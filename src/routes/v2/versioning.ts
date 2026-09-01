import { Router } from 'express';

const router = Router();

/**
 * GET /api/v2/versioning/demo
 *
 * Deliberate v2-only example endpoint used to demonstrate intentional
 * divergence and exercise the parity allowlist/test. Not mounted under
 * /api or /api/v1.
 *
 * @response 200 { version: 2, demo: true }
 */
router.get('/demo', (_req, res) => {
  res.json({ version: 2, demo: true });
});

export default router;
