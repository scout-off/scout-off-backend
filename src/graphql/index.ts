/**
 * GraphQL endpoint factory.
 *
 * Creates a graphql-yoga handler and mounts it on the Express app at /graphql.
 *
 * Security controls:
 *   - Depth limiting: queries deeper than MAX_DEPTH levels are rejected (DoS guard)
 *     Implemented as a custom GraphQL validation rule using the standard
 *     `graphql` ValidationContext API — no external plugin required.
 *   - Introspection: disabled in production (NODE_ENV=production)
 *   - Auth: extracted in context; resolvers enforce it per-field
 *
 * The endpoint is mounted alongside the REST API (not replacing it).
 */

import { createYoga, createSchema } from 'graphql-yoga';
import { useValidationRule } from '@envelop/core';
import { Application } from 'express';
import { GraphQLError, Kind } from 'graphql';
import { typeDefs } from './schema';
import { resolvers } from './resolvers';
import { createContext } from './context';
import { createDepthLimitRule, createQueryCostRule, MAX_DEPTH, MAX_QUERY_COST } from './validation';
import { logger } from '../utils/logger';

// ─── Production introspection-blocking plugin ────────────────────────────────

/**
 * graphql-yoga plugin that intercepts execution and returns an error for
 * introspection queries (__schema / __type) when running in production.
 *
 * Uses the `onExecute` lifecycle hook + `setResultAndStopExecution` to short-
 * circuit execution before any resolver runs — the cleanest approach for this
 * version of graphql-yoga that doesn't require an external depth-limit package.
 */
function createBlockIntrospectionPlugin() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onExecute({ args, setResultAndStopExecution }: any) {
      const defs: readonly import('graphql').DefinitionNode[] =
        args?.document?.definitions ?? [];
      for (const def of defs) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;
        for (const sel of def.selectionSet.selections) {
          if (
            sel.kind === Kind.FIELD &&
            (sel.name.value === '__schema' || sel.name.value === '__type')
          ) {
            setResultAndStopExecution({
              errors: [
                new GraphQLError('GraphQL introspection is disabled in production.', {
                  extensions: { code: 'INTROSPECTION_DISABLED' },
                }),
              ],
            });
            return;
          }
        }
      }
    },
  };
}

// ─── Mount ────────────────────────────────────────────────────────────────────

/**
 * Creates and mounts the GraphQL endpoint on `app` at `/graphql`.
 * Call this from `src/app.ts` after all other middleware is set up.
 */
export function mountGraphQL(app: Application): void {
  const isProduction = process.env.NODE_ENV === 'production';

  const yoga = createYoga({
    schema: createSchema({
      typeDefs,
      resolvers,
    }),
    context: createContext,
    // Depth limiting + query-cost limiting via @envelop/core useValidationRule
    // (shared rule implementations in src/graphql/validation.ts); introspection
    // blocking via onExecute plugin.
    plugins: [
      useValidationRule(createDepthLimitRule(MAX_DEPTH)),
      useValidationRule(createQueryCostRule(MAX_QUERY_COST)),
      ...(isProduction ? [createBlockIntrospectionPlugin()] : []),
    ],
    // graphql-yoga manages its own /graphql path
    graphqlEndpoint: '/graphql',
    // Log errors (graphql-yoga catches them internally)
    maskedErrors: isProduction,
    logging: {
      debug: (...args) => logger.debug(args),
      info: (...args) => logger.info(args),
      warn: (...args) => logger.warn(args),
      error: (...args) => logger.error(args),
    },
  });

  // graphql-yoga returns a standard request handler compatible with Express
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/graphql', yoga as any);

  logger.info(
    `[graphql] endpoint mounted at /graphql (introspection=${!isProduction}, maxDepth=${MAX_DEPTH}, maxQueryCost=${MAX_QUERY_COST})`,
  );
}
