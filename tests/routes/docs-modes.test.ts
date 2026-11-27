import request from 'supertest';

/** Tests all three actual documentation mount prefixes without starting the full backend. */
describe('API documentation visibility modes', () => {
  const previousMode = process.env.API_DOCS_MODE;
  const previousHide = process.env.API_DOCS_HIDE_ADMIN;
  afterAll(() => {
    if (previousMode === undefined) delete process.env.API_DOCS_MODE;
    else process.env.API_DOCS_MODE = previousMode;
    if (previousHide === undefined) delete process.env.API_DOCS_HIDE_ADMIN;
    else process.env.API_DOCS_HIDE_ADMIN = previousHide;
    jest.dontMock('../../src/middleware/auth');
  });
  function appFor(mode: string, hideAdmin = 'false') {
    process.env.API_DOCS_MODE = mode;
    process.env.API_DOCS_HIDE_ADMIN = hideAdmin;
    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      requireRole: () => (req: any, res: any, next: any) => {
        const auth = req.get('Authorization');
        if (!auth) return res.status(401).json({ error: 'Unauthorized' });
        if (auth !== 'Bearer administrator') return res.status(403).json({ error: 'Forbidden' });
        next();
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { guardApiDocs } = require('../../src/middleware/docs.guard');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const docs = require('../../src/routes/docs').default;
    const app = express();
    for (const prefix of ['/api', '/api/v1', '/api/v2'])
      app.use(`${prefix}/docs`, guardApiDocs, docs);
    return app;
  }
  for (const prefix of ['/api', '/api/v1', '/api/v2']) {
    it(`${prefix}: disabled hides JSON, YAML, UI and assets`, async () => {
      const app = appFor('disabled');
      for (const suffix of ['', '/yaml', '/ui', '/swagger-ui.css']) {
        expect((await request(app).get(`${prefix}/docs${suffix}`)).status).toBe(404);
      }
    });
    it(`${prefix}: admin requires a verified admin`, async () => {
      const app = appFor('admin');
      expect((await request(app).get(`${prefix}/docs`)).status).toBe(401);
      expect(
        (await request(app).get(`${prefix}/docs`).set('Authorization', 'Bearer visitor')).status,
      ).toBe(403);
      expect(
        (await request(app).get(`${prefix}/docs`).set('Authorization', 'Bearer administrator'))
          .status,
      ).toBe(200);
    });
    it(`${prefix}: public mode hides admin paths in JSON and YAML`, async () => {
      const app = appFor('public', 'true');
      const json = await request(app).get(`${prefix}/docs`);
      const yaml = await request(app).get(`${prefix}/docs/yaml`);
      expect(json.status).toBe(200);
      expect(yaml.status).toBe(200);
      expect(Object.keys(json.body.paths).some((key: string) => key.startsWith('/admin'))).toBe(
        false,
      );
      expect(yaml.text).not.toMatch(/^\s+\/admin\//m);
      expect((await request(app).get(`${prefix}/docs/ui`)).status).toBe(200);
    });
  }
});
