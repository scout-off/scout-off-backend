/**
 * OpenAPI documentation routes.
 *
 * GET /api/docs        → OpenAPI 3.0 spec as JSON
 * GET /api/docs/ui     → Swagger UI (if swagger-ui-dist is installed)
 * GET /api/docs/yaml   → OpenAPI 3.0 spec as YAML (raw)
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';

const router = Router();

// Resolve the spec files relative to this source file
const SPEC_YAML_PATH = path.join(__dirname, '..', 'openapi.yaml');
const SPEC_JSON_PATH = path.join(__dirname, '..', 'openapi.json');

/** Parse YAML into a JS object without external runtime dependencies. */
function parseYamlSpec(yamlText: string): Record<string, unknown> {
  // Use js-yaml if available, otherwise fall back to require()'ing the pre-built JSON
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml') as typeof import('js-yaml');
    return yaml.load(yamlText) as Record<string, unknown>;
  } catch {
    // js-yaml not installed — return the pre-built JSON instead
    return JSON.parse(fs.readFileSync(SPEC_JSON_PATH, 'utf8')) as Record<string, unknown>;
  }
}

/** Lazily parsed spec — parsed once on first request then cached. */
let cachedSpec: Record<string, unknown> | null = null;

function loadSpec(): Record<string, unknown> {
  if (cachedSpec) return cachedSpec;
  if (fs.existsSync(SPEC_YAML_PATH)) {
    const raw = fs.readFileSync(SPEC_YAML_PATH, 'utf8');
    cachedSpec = parseYamlSpec(raw);
  } else if (fs.existsSync(SPEC_JSON_PATH)) {
    cachedSpec = JSON.parse(fs.readFileSync(SPEC_JSON_PATH, 'utf8')) as Record<string, unknown>;
  } else {
    throw new Error(
      `OpenAPI spec not found. Expected ${SPEC_YAML_PATH} or ${SPEC_JSON_PATH} ` +
        `(resolved relative to ${path.join(__dirname, '..')}).`
    );
  }
  return cachedSpec;
}

/**
 * Log a spec-loading failure and send the standard error envelope.
 * The attempted spec paths are logged (not returned) so clients get a stable message.
 */
function sendDocsUnavailable(req: Request, res: Response, err: unknown, what: string): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const correlationId = req.correlationId;
  logger.error(
    `[docs] failed to load ${what} attemptedPaths=${SPEC_YAML_PATH},${SPEC_JSON_PATH}` +
      `${correlationId ? ` correlationId=${correlationId}` : ''}: ${message}`,
    ...(stack ? [stack] : [])
  );
  res.status(500).json({
    success: false,
    error: `Failed to load OpenAPI spec. Expected ${SPEC_YAML_PATH} or ${SPEC_JSON_PATH}.`,
    code: ErrorCode.DOCS_UNAVAILABLE,
    ...(correlationId !== undefined && { correlationId }),
  });
}

/**
 * GET /api/docs
 * Returns the OpenAPI 3.0 specification as JSON.
 *
 * @response 200 OpenAPI 3.0 document (application/json)
 * @response 500 { success: false, error: string, code: string, correlationId?: string } - Spec file missing or unparsable
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const spec = loadSpec();
    res.json(spec);
  } catch (err) {
    sendDocsUnavailable(req, res, err, 'OpenAPI spec');
  }
});

/**
 * GET /api/docs/yaml
 * Returns the raw OpenAPI YAML source.
 *
 * @response 200 Raw OpenAPI YAML (text/yaml)
 * @response 500 { success: false, error: string } - Spec file missing
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
 * Serves embedded Swagger UI.
 * Requires `swagger-ui-dist` to be installed:
 *   npm install swagger-ui-dist
 *
 * @response 200 Swagger UI HTML page (text/html)
 * @response 501 { success: false, error: string } - swagger-ui-dist not installed
 */
router.get('/ui', (req: Request, res: Response) => {
  const assetRoot = req.baseUrl;
  const assetDir = path.dirname(require.resolve('swagger-ui-dist/swagger-ui.css'));
  const cssPath = path.join(assetDir, 'swagger-ui.css');
  const bundlePath = path.join(assetDir, 'swagger-ui-bundle.js');

  const assetFiles = [
    ['swagger-ui.css', cssPath],
    ['swagger-ui-bundle.js', bundlePath],
  ];

  for (const [name, filePath] of assetFiles) {
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(assetDir))) {
      res.status(500).json({ success: false, error: `Invalid asset path for ${name}` });
      return;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ScoutOff API Docs</title>
  <link rel="stylesheet" href="${assetRoot}/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${assetRoot}/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "${req.baseUrl}",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true,
    });
  </script>
</body>
</html>`;

  res.type('html').send(html);
});

/**
 * GET /api/docs/swagger-ui.css
 * Serves the Swagger UI stylesheet from swagger-ui-dist for the /ui page.
 *
 * @response 200 Swagger UI stylesheet (text/css)
 */
router.get('/swagger-ui.css', (_req: Request, res: Response) => {
  const cssPath = require.resolve('swagger-ui-dist/swagger-ui.css');
  res.type('text/css').sendFile(cssPath);
});

/**
 * GET /api/docs/swagger-ui-bundle.js
 * Serves the Swagger UI JavaScript bundle from swagger-ui-dist for the /ui page.
 *
 * @response 200 Swagger UI JavaScript bundle (text/javascript)
 */
router.get('/swagger-ui-bundle.js', (_req: Request, res: Response) => {
  const jsPath = require.resolve('swagger-ui-dist/swagger-ui-bundle.js');
  res.type('text/javascript').sendFile(jsPath);
});

export default router;
