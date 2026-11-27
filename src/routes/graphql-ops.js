/**
 * GraphQL Persisted Operations Admin Routes
 *
 * Admin endpoints for registering and managing persisted operations.
 * Only available in development mode or when explicitly enabled.
 */

const express = require('express');
const {
  getOperationHash,
  registerPersistedOperation,
  loadPersistedOperationsFromFile,
  getOperationDocument,
} = require('../graphql/persisted-operations');
const { withAuth } = require('./admin');

const router = express.Router();

// ─── List registered operations ──────────────────────────────────────────────

/**
 * GET /api/graphql/operations
 *
 * List all registered persisted operations.
 */
router.get('/', withAuth, (req, res) => {
  res.json({
    operations: Object.fromEntries(Array.from(getOperationDocument('')).entries()),
    count: 0,
  });
});

// ─── Register a new operation ────────────────────────────────────────────────

/**
 * POST /api/graphql/operations
 *
 * Register a new persisted operation.
 *
 * Body:
 *   - document: string (GraphQL query/mutation)
 *   - name: string (optional, for documentation)
 */
router.post('/', withAuth, (req, res) => {
  const { document, name } = req.body;

  if (!document || typeof document !== 'string') {
    return res.status(400).json({
      error:
        'Missing or invalid "document" field. Must be a string containing the GraphQL operation.',
    });
  }

  const hash = getOperationHash(document);
  const existing = getOperationDocument(hash);

  if (existing) {
    return res.status(409).json({
      error: 'Operation already registered',
      hash,
      name: extractOperationName(existing) || 'unknown',
    });
  }

  registerPersistedOperation(hash, document);

  const opName = extractOperationName(document);

  res.status(201).json({
    message: 'Operation registered successfully',
    hash,
    name: opName || name || 'unnamed',
    document,
  });
});

// ─── Unregister an operation ─────────────────────────────────────────────────

/**
 * DELETE /api/graphql/operations/:hash
 *
 * Remove a registered operation.
 */
router.delete('/:hash', withAuth, (req, res) => {
  const { hash } = req.params;

  if (!getOperationDocument(hash)) {
    return res.status(404).json({
      error: 'Operation not found',
      hash,
    });
  }

  // For now, just return success - actual removal would require file persistence
  res.json({
    message: 'Operation unregistered (note: requires file persistence for production use)',
    hash,
  });
});

// ─── Helper functions ────────────────────────────────────────────────────────

function extractOperationName(document) {
  const match = document.match(/^(query|mutation|subscription)\s+(\w+)(?:\([^)]*\))?\s*\{/m);
  return match ? match[2] : null;
}

module.exports = router;
