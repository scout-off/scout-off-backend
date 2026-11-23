/** OpenAPI documentation endpoints; guarded at every mount in app.ts. */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
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
    throw new Error('OpenAPI specification missing from dist; run npm run build');
  }
  return cachedSpec;
}
function visibleSpec(): Record<string, unknown> {
  return filterAdminPathsFromSpec(loadSpec());
}

router.get('/', (_req: Request, res: Response) => {
  try { res.json(visibleSpec()); }
  catch { res.status(500).json({ success: false, error: 'Failed to load OpenAPI spec' }); }
});
router.get('/yaml', (_req: Request, res: Response) => {
  try { res.type('application/yaml').send(yaml.dump(visibleSpec(), { noRefs: true })); }
  catch { res.status(500).json({ success: false, error: 'Failed to load OpenAPI spec YAML' }); }
});
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
router.get('/swagger-ui.css', (_req: Request, res: Response) => {
  res.type('text/css').sendFile(require.resolve('swagger-ui-dist/swagger-ui.css'));
});
router.get('/swagger-ui-bundle.js', (_req: Request, res: Response) => {
  res.type('text/javascript').sendFile(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'));
});
export default router;
