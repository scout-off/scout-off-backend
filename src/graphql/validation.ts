/**
 * GraphQL validation rules shared by the mounted endpoint and tests.
 *
 * Rules:
 *   - Depth limiting (createDepthLimitRule): rejects queries deeper than
 *     MAX_DEPTH (DoS guard for deeply nested queries).
 *   - Query-cost limiting (createQueryCostRule): rejects queries whose
 *     calculated cost exceeds MAX_QUERY_COST. Cost accounts for EVERY
 *     field node in the operation — including aliases — so a request with
 *     ~20+ aliased expensive operations cannot bypass the depth limit by
 *     widening instead of deepening (#1019).
 *
 * Both rules use the standard graphql ValidationContext API — no external
 * plugin required (matches the existing codebase approach).
 */

import { GraphQLError, ValidationContext, Kind, type ASTNode } from 'graphql';

/** Maximum nesting depth of a single operation's selection sets. */
export const MAX_DEPTH = 5;

/**
 * Maximum allowed query cost per operation.
 *
 * Cost model: every field costs FIELD_COST (1); expensive fields
 * (milestones, players, player, scoutSubscription — each performs DB/RPC
 * work) cost EXPENSIVE_COST (5) per occurrence, so aliasing an expensive
 * field N times costs EXPENSIVE_COST × N plus the cost of its sub-fields.
 *
 * A typical aliased `milestones { milestoneId playerId }` block costs 7
 * (5 + 2 × 1). MAX_QUERY_COST = 135 means 20 such aliases (140) are
 * rejected while 19 (133) still pass — the required "~20+ aliased
 * expensive operations" abuse boundary. Normal queries (a handful of
 * fields) cost well under 100 and are unaffected.
 */
export const MAX_QUERY_COST = 135;

/** Fields whose resolvers perform expensive work (DB/RPC per occurrence). */
const EXPENSIVE_FIELDS = new Set([
  'milestones',
  'players',
  'player',
  'scoutSubscription',
]);

const FIELD_COST = 1;
const EXPENSIVE_COST = 5;

/**
 * Returns a GraphQL validation rule that rejects queries deeper than
 * maxDepth.
 *
 * Depth is measured as the maximum nesting of selection sets in a single
 * operation. Fragment spreads are followed so inlined and named fragments
 * are both counted. Introspection fields (__schema, __type) are excluded.
 */
export function createDepthLimitRule(maxDepth: number) {
  return function depthLimitRule(context: ValidationContext) {
    return {
      OperationDefinition(operation: ASTNode) {
        if (operation.kind !== Kind.OPERATION_DEFINITION) return;

        const fragments = context.getDocument().definitions
          .filter((d): d is import('graphql').FragmentDefinitionNode =>
            d.kind === Kind.FRAGMENT_DEFINITION,
          )
          .reduce<Record<string, import('graphql').FragmentDefinitionNode>>((acc, frag) => {
            acc[frag.name.value] = frag;
            return acc;
          }, {});

        function measureDepth(
          node: import('graphql').SelectionSetNode | undefined,
          depth: number,
          visited: Set<string>,
        ): number {
          if (!node) return depth;
          let max = depth;
          for (const selection of node.selections) {
            if (selection.kind === Kind.FIELD) {
              // skip meta-fields
              if (selection.name.value.startsWith('__')) continue;
              const childDepth = measureDepth(selection.selectionSet, depth + 1, visited);
              if (childDepth > max) max = childDepth;
            } else if (selection.kind === Kind.INLINE_FRAGMENT) {
              const childDepth = measureDepth(selection.selectionSet, depth, visited);
              if (childDepth > max) max = childDepth;
            } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
              const fragName = selection.name.value;
              if (!visited.has(fragName) && fragments[fragName]) {
                visited.add(fragName);
                const childDepth = measureDepth(
                  fragments[fragName].selectionSet,
                  depth,
                  visited,
                );
                if (childDepth > max) max = childDepth;
              }
            }
          }
          return max;
        }

        const depth = measureDepth(operation.selectionSet, 0, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}.`,
              { nodes: [operation] },
            ),
          );
        }
      },
    };
  };
}

/**
 * Returns a GraphQL validation rule that rejects operations whose
 * calculated cost exceeds maxCost.
 *
 * Cost counting:
 *   - every Field node (alias or not) contributes its field cost;
 *   - fragment spreads are expanded once per use (visited-set so shared
 *     fragments are not double-counted);
 *   - introspection meta-fields (__schema / __type / __typename) are free;
 *   - an operation is rejected when cost >= maxCost.
 *
 * The error carries `extensions.code = 'QUERY_COST_EXCEEDED'` for clients
 * that want to distinguish cost rejection from other validation errors.
 */
export function createQueryCostRule(maxCost: number) {
  return function queryCostRule(context: ValidationContext) {
    return {
      OperationDefinition(operation: ASTNode) {
        if (operation.kind !== Kind.OPERATION_DEFINITION) return;

        const fragments = context.getDocument().definitions
          .filter((d): d is import('graphql').FragmentDefinitionNode =>
            d.kind === Kind.FRAGMENT_DEFINITION,
          )
          .reduce<Record<string, import('graphql').FragmentDefinitionNode>>((acc, frag) => {
            acc[frag.name.value] = frag;
            return acc;
          }, {});

        function calculateCost(
          node: import('graphql').SelectionSetNode | undefined,
          visited: Set<string>,
        ): number {
          if (!node) return 0;
          let total = 0;
          for (const selection of node.selections) {
            if (selection.kind === Kind.FIELD) {
              // Meta-fields (__schema, __type, __typename) are free.
              if (selection.name.value.startsWith('__')) continue;
              const fieldCost = EXPENSIVE_FIELDS.has(selection.name.value)
                ? EXPENSIVE_COST
                : FIELD_COST;
              total += fieldCost;
              total += calculateCost(selection.selectionSet, visited);
            } else if (selection.kind === Kind.INLINE_FRAGMENT) {
              total += calculateCost(selection.selectionSet, visited);
            } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
              const fragName = selection.name.value;
              if (!visited.has(fragName) && fragments[fragName]) {
                visited.add(fragName);
                total += calculateCost(fragments[fragName].selectionSet, visited);
              }
            }
          }
          return total;
        }

        const cost = calculateCost(operation.selectionSet, new Set());
        if (cost >= maxCost) {
          context.reportError(
            new GraphQLError(
              `Query cost ${cost} exceeds maximum allowed cost of ${maxCost}.`,
              {
                nodes: [operation],
                extensions: { code: 'QUERY_COST_EXCEEDED' },
              },
            ),
          );
        }
      },
    };
  };
}