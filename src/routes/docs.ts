/** OpenAPI documentation endpoints; guarded at every mount in app.ts. */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import yaml from 'js-yaml';
import { filterAdminPathsFromSpec } from '../middleware/docs.guard';

const router = Router();
const SPEC_JSON_PATH = path.join(__dirname, '..', 'openapi.json');
const SPEC_YAML_PATH = path.join(__dirname, '..', 'openapi.yaml');
let cachedSpec: Record<string, unknown> | undefined;

function loadSpec(): Record<string, unknown> {
  if (cachedSpec) return cachedSpec;
  // The pre-generated JSON has resolved components and is copied to dist by postbuild.
  if (fs.existsSync(SPEC_JSON_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(SPEC_JSON_PATH, 'utf8')) as Record<string, unknown>;
    if (!parsed.openapi || !parsed.paths) throw new Error('Invalid OpenAPI specification');
    cachedSpec = parsed;
  } else if (fs.existsSync(SPEC_YAML_PATH)) {
    const parsed = yaml.load(fs.readFileSync(SPEC_YAML_PATH, 'utf8')) as Record<string, unknown>;
    if (!parsed?.openapi || !parsed.paths) throw new Error('Invalid OpenAPI specification');
    cachedSpec = parsed;
  } else {
    throw new Error(
      `OpenAPI spec not found. Expected ${SPEC_YAML_PATH} or ${SPEC_JSON_PATH} ` +
        `(resolved relative to ${path.join(__dirname, '..')}).`,
    );
  }
  return cachedSpec;
}
function visibleSpec(): Record<string, unknown> {
  return filterAdminPathsFromSpec(loadSpec());
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
    ...(stack ? [stack] : []),
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
    const spec = visibleSpec();
    res.json(spec);
  } catch (err) {
    sendDocsUnavailable(req, res, err, 'OpenAPI spec');
  }
});
/**
 * GET /api/docs/yaml
 *
 * Returns the visible OpenAPI specification as YAML.
 *
 * @response 200 OpenAPI 3.0 document (application/yaml)
 * @response 500 { success: false, error: string } - Spec file missing or unparsable
 */
router.get('/yaml', (_req: Request, res: Response) => {
  try {
    res.type('application/yaml').send(yaml.dump(visibleSpec(), { noRefs: true }));
  } catch {
    res.status(500).json({ success: false, error: 'Failed to load OpenAPI spec YAML' });
  }
});
/**
 * GET /api/docs/ui
 *
 * Serves the Swagger UI page for the OpenAPI specification.
 *
 * @response 200 Swagger UI HTML page (text/html)
 */
router.get('/ui', (req: Request, res: Response) => {
  const base = req.baseUrl;
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>ScoutOff API Docs</title>
<link rel="stylesheet" href="${base}/swagger-ui.css"></head><body>
<div id="swagger-ui"></div>
<script src="${base}/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:${JSON.stringify(base)},dom_id:'#swagger-ui',
  presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],
  layout:'BaseLayout',deepLinking:true});</script></body></html>`);
});
/**
 * GET /api/docs/swagger-ui.css
 *
 * Serves the bundled Swagger UI stylesheet.
 *
 * @response 200 Swagger UI stylesheet (text/css)
 */
router.get('/swagger-ui.css', (_req: Request, res: Response) => {
  res.type('text/css').sendFile(require.resolve('swagger-ui-dist/swagger-ui.css'));
});
/**
 * GET /api/docs/swagger-ui-bundle.js
 *
 * Serves the bundled Swagger UI script.
 *
 * @response 200 Swagger UI script (application/javascript)
 */
router.get('/swagger-ui-bundle.js', (_req: Request, res: Response) => {
  res.type('text/javascript').sendFile(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'));
});
export default router;
