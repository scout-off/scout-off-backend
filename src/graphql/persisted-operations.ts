/**
 * GraphQL Persisted Operations support.
 *
 * In production, only pre-registered operation hashes are accepted.
 * This protects against arbitrary queries (DoS/data scraping) while
 * keeping development flexible.
 *
 * Usage:
 *   - Development: Arbitrary queries allowed (GRAPHQL_PERSISTED_ONLY not set or false)
 *   - Production: Only known operation hashes accepted (GRAPHQL_PERSISTED_ONLY=true)
 *
 * Operation hash is SHA-256 of the document string.
 */

import { Plugin } from 'graphql-yoga';
import { GraphQLError } from 'graphql';
import crypto from 'crypto';
import config from '../config';
import { logger } from '../utils/logger';

// In-memory store of allowed operations in development
// In production, this is empty - operations must be in the persisted store
const developmentOperations = new Map<string, string>();

// Persisted operations store - populated from file or admin endpoint
let persistedOperations = new Map<string, string>();

/**
 * Register an operation for development (arbitrary queries allowed).
 */
export function registerDevelopmentOperation(hash: string, document: string): void {
  developmentOperations.set(hash, document);
}

/**
 * Register a persisted operation.
 */
export function registerPersistedOperation(hash: string, document: string): void {
  persistedOperations.set(hash, document);
}

/**
 * Load persisted operations from a JSON file.
 * Expected format: { "operationHash": "query/mutation document", ... }
 */
export function loadPersistedOperationsFromFile(filePath: string): boolean {
  try {
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      logger.info(`[persisted-ops] File not found: ${filePath}, starting with empty store`);
      return true;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const ops = JSON.parse(content) as Record<string, string>;
    
    persistedOperations = new Map(Object.entries(ops));
    logger.info(`[persisted-ops] Loaded ${persistedOperations.size} persisted operation(s) from ${filePath}`);
    return true;
  } catch (err) {
    logger.error(`[persisted-ops] Failed to load persisted operations: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Get the document for a given hash.
 */
export function getOperationDocument(hash: string): string | undefined {
  // In production, only check persisted store
  if (config.graphqlPersistedOnly) {
    return persistedOperations.get(hash);
  }
  
  // In development, check both stores
  return persistedOperations.get(hash) || developmentOperations.get(hash);
}

/**
 * Check if an operation hash is allowed.
 */
export function isOperationAllowed(hash: string): boolean {
  if (config.graphqlPersistedOnly) {
    return persistedOperations.has(hash);
  }
  return persistedOperations.has(hash) || developmentOperations.has(hash);
}

/**
 * Generate SHA-256 hash of a GraphQL document.
 */
export function getOperationHash(document: string): string {
  return crypto.createHash('sha256').update(document).digest('hex');
}

// ─── graphql-yoga plugin ─────────────────────────────────────────────────────

/**
 * GraphQL plugin that enforces persisted operations.
 *
 * In production mode (GRAPHQL_PERSISTED_ONLY=true):
 *   - Unknown operation hashes return 400 PERSISTED_QUERY_NOT_FOUND
 *   - Arbitrary documents (with no hash or unknown hash) return 400 PERSISTED_QUERY_REQUIRED
 *
 * In development mode:
 *   - Arbitrary queries allowed (for interactive testing)
 *   - Persisted operations also work
 */
export function createPersistedOperationsPlugin(): Plugin {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onExecute({ args, setResult, setResultHandler }: any) {
      const document = args?.document;
      
      if (!document) {
        setResult({
          errors: [
            new GraphQLError('Missing document in request', {
              extensions: { code: 'PERSISTED_QUERY_REQUIRED' },
            }),
          ],
        });
        return;
      }
      
      // Extract hash from extensions if present
      const hash = args?.extensions?.persistedQuery?.version 
        ? args.extensions.persistedQuery.sha256Hash 
        : undefined;
      
      // In production, we require a valid hash
      if (config.graphqlPersistedOnly) {
        if (!hash) {
          setResult({
            errors: [
              new GraphQLError('Persisted query required in production. Register your operation or use GRAPHQL_PERSISTED_ONLY=false for development.', {
                extensions: { code: 'PERSISTED_QUERY_REQUIRED' },
              }),
            ],
          });
          return;
        }
        
        const documentForHash = persistedOperations.get(hash);
        if (!documentForHash) {
          setResult({
            errors: [
            new GraphQLError(`Unknown persisted query hash: ${hash}`, {
                extensions: { code: 'PERSISTED_QUERY_NOT_FOUND', hash },
              }),
            ],
          });
          return;
        }
        
        // Validate that the provided document matches the stored hash
        // This prevents hash collision attacks
        if (document !== documentForHash) {
          setResult({
            errors: [
              new GraphQLError('Document hash mismatch', {
                extensions: { code: 'PERSISTED_QUERY_MISMATCH' },
              }),
            ],
          });
          return;
        }
        
        // Store the validated document for execution
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (args as any).document = documentForHash;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { onExecuteDone: ({ result }: any) => logOperationResult(args.document, result) };
      }
      
      // In development mode, allow arbitrary documents
      // If a hash is provided and we have it, use it; otherwise use provided document
      if (hash) {
        const documentForHash = getOperationDocument(hash);
        if (documentForHash) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (args as any).document = documentForHash;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { onExecuteDone: ({ result }: any) => logOperationResult(args.document, result) };
    },
  };
}

/**
 * Log persisted-query errors and completed operations for metrics.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logOperationResult(document: unknown, result: any): void {
  if (typeof document !== 'string') return;

  // Extract operation name for metrics
  const operationName = extractOperationName(document);

  if (result.errors && result.errors.length > 0) {
    for (const error of result.errors) {
      const code = (error.extensions as { code?: string } | undefined)?.code;
      if (code === 'PERSISTED_QUERY_NOT_FOUND') {
        logger.warn(`[graphql] Persisted query not found: ${error.message}`);
      } else if (code === 'PERSISTED_QUERY_REQUIRED') {
        logger.warn('[graphql] Persisted query required in production');
      } else if (code === 'PERSISTED_QUERY_MISMATCH') {
        logger.warn('[graphql] Persisted query hash mismatch');
      }
    }
  } else if (operationName) {
    logger.debug(`[graphql] Operation completed: ${operationName}`);
  }
}

/**
 * Extract the operation name from a GraphQL document string.
 */
function extractOperationName(document: string): string | null {
  // Simple regex to extract operation name
  const match = document.match(/(?:query|mutation|subscription)\s+(\w+)(?:\([^)]*\))?\s*\{/);
  return match ? match[1] : null;
}
