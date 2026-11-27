describe('API docs admin path filtering', () => {
  const oldMode = process.env.API_DOCS_MODE;
  const oldHidden = process.env.API_DOCS_HIDE_ADMIN;
  afterAll(() => {
    if (oldMode === undefined) delete process.env.API_DOCS_MODE;
    else process.env.API_DOCS_MODE = oldMode;
    if (oldHidden === undefined) delete process.env.API_DOCS_HIDE_ADMIN;
    else process.env.API_DOCS_HIDE_ADMIN = oldHidden;
  });
  it('removes admin paths without mutating the original spec', () => {
    jest.resetModules();
    process.env.API_DOCS_MODE = 'public';
    process.env.API_DOCS_HIDE_ADMIN = 'true';
    // Import after setting environment because module reads config at startup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { filterAdminPathsFromSpec: filter } = require('../../src/middleware/docs.guard');
    const original = { paths: { '/admin/fees': { post: {} }, '/players': { get: {} } } };
    const filtered = filter(original);
    expect(Object.keys(filtered.paths)).toEqual(['/players']);
    expect(Object.keys(original.paths)).toHaveLength(2);
  });
});
