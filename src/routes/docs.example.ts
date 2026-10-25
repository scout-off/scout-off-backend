/**
 * EXAMPLE: Updated docs.ts with API_DOCS_MODE guard.
 * 
 * Shows how to integrate the guardApiDocs middleware and spec filtering.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { guardApiDocs, filterAdminPathsFromSpec } from '../middleware/docs.guard';

const router = Router();

// Apply guard middleware to all documentation routes
router.use(guardApiDocs);

// Rest of the implementation (same as before)
const SPEC_YAML_PATH = path.join(__dirname, '..', 'openapi.yaml');
const SPEC_JSON_PATH = path.join(__dirname, '..', 'openapi.json');

function parseYamlSpec(yamlText: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml') as typeof import('js-yaml');
    return yaml.load(yamlText) as Record<string, unknown>;
  } catch {
    return JSON.parse(fs.readFileSync(SPEC_JSON_PATH, 'utf8')) as Record<string, unknown>;
  }
}

let cachedSpec: Record<string, unknown> | null = null;

function loadSpec(): Record<string, unknown> {
  if (cachedSpec) return cachedSpec;
  if (fs.existsSync(SPEC_YAML_PATH)) {
    const raw = fs.readFileSync(SPEC_YAML_PATH, 'utf8');
    cachedSpec = parseYamlSpec(raw);
  } else if (fs.existsSync(SPEC_JSON_PATH)) {
    cachedSpec = JSON.parse(fs.readFileSync(SPEC_JSON_PATH, 'utf8')) as Record<string, unknown>;
  } else {
    throw new Error('OpenAPI spec not found.');
  }
  return cachedSpec;
}

/**
 * GET /api/docs
 * Returns the OpenAPI spec as JSON, optionally filtered to hide admin paths.
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    let spec = loadSpec();
    
    // Apply optional admin path filtering
    spec = filterAdminPathsFromSpec(spec);
    
    res.json(spec);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load OpenAPI spec' });
  }
});

/**
 * GET /api/docs/yaml
 * Returns the raw YAML spec (not filtered — YAML is harder to filter).
 */
router.get('/yaml', (_req: Request, res: Response) => {
  try {
    const raw = fs.readFileSync(SPEC_YAML_PATH, 'utf8');
    res.type('text/yaml').send(raw);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load OpenAPI spec YAML' });
  }
});

/**
 * GET /api/docs/ui
 * Serves Swagger UI (existing implementation).
 */
router.get('/ui', (req: Request, res: Response) => {
  // ... existing Swagger UI code ...
});

// ... rest of the routes (swagger-ui.css, swagger-ui-bundle.js) ...

export default router;

/**
 * INTEGRATION IN app.ts:
 *
 * // Import the docs router
 * import docsRouter from './routes/docs';
 *
 * // In app setup, mount under multiple prefixes
 * app.use('/api/docs', docsRouter);
 * app.use('/api/v1/docs', docsRouter);
 * app.use('/api/v2/docs', docsRouter);
 *
 * The guardApiDocs middleware will enforce API_DOCS_MODE for all mounted routes.
 */
