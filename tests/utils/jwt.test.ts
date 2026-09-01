import jwt from 'jsonwebtoken';

const CURRENT_SECRET = 'test-secret';
const PREVIOUS_SECRET = 'old-test-secret';

process.env.JWT_SECRET = CURRENT_SECRET;
process.env.CONTRACT_ID = process.env.CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

describe('JWT dual-key verification (src/utils/jwt.ts)', () => {
  afterEach(() => {
    delete process.env.JWT_SECRET_PREVIOUS;
    delete process.env.JWT_SECRET_PREVIOUS_UNTIL;
    jest.resetModules();
  });

  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../src/utils/jwt') as typeof import('../../src/utils/jwt');
  }

  // ── Always sign with current secret ────────────────────────────────────────

  it('signJwt signs with the current secret', () => {
    const { signJwt } = load();
    const token = signJwt({ sub: 'G1', role: 'player' }, { expiresIn: '1h' });
    const decoded = jwt.verify(token, CURRENT_SECRET) as jwt.JwtPayload;
    expect(decoded.sub).toBe('G1');
  });

  // ── Default single-secret mode ─────────────────────────────────────────────

  it('verifyJwt accepts a token signed with the current secret', () => {
    const { verifyJwt } = load();
    const token = jwt.sign({ sub: 'G1' }, CURRENT_SECRET, { expiresIn: '1h' });
    const p = verifyJwt(token);
    expect(p.sub).toBe('G1');
  });

  it('verifyJwt rejects an unknown secret when no previous is configured', () => {
    const { verifyJwt } = load();
    const token = jwt.sign({ sub: 'G1' }, 'unknown', { expiresIn: '1h' });
    expect(() => verifyJwt(token)).toThrow();
  });

  // ── Previous secret without UNTIL (open-ended grace) ───────────────────────

  it('accepts previous-secret token when UNTIL is unset (open grace)', () => {
    process.env.JWT_SECRET_PREVIOUS = PREVIOUS_SECRET;
    jest.resetModules();
    const { verifyJwt } = load();
    const token = jwt.sign({ sub: 'G1' }, PREVIOUS_SECRET, { expiresIn: '1h' });
    expect(verifyJwt(token).sub).toBe('G1');
  });

  // ── Previous secret with UNTIL within grace window ─────────────────────────

  it('accepts previous-secret token when now < UNTIL', () => {
    process.env.JWT_SECRET_PREVIOUS = PREVIOUS_SECRET;
    const futureMs = Date.now() + 60 * 60 * 1000;
    process.env.JWT_SECRET_PREVIOUS_UNTIL = String(Math.floor(futureMs / 1000));
    jest.resetModules();
    const { verifyJwt } = load();
    const token = jwt.sign({ sub: 'G1' }, PREVIOUS_SECRET, { expiresIn: '1h' });
    expect(verifyJwt(token, Date.now()).sub).toBe('G1');
  });

  // ── Previous secret after UNTIL — rejected ─────────────────────────────────

  it('rejects previous-secret token when now >= UNTIL', () => {
    process.env.JWT_SECRET_PREVIOUS = PREVIOUS_SECRET;
    const pastMs = Date.now() - 60_000;
    process.env.JWT_SECRET_PREVIOUS_UNTIL = String(Math.floor(pastMs / 1000));
    jest.resetModules();
    const { verifyJwt } = load();
    const token = jwt.sign({ sub: 'G1' }, PREVIOUS_SECRET, { expiresIn: '1h' });
    // now is well past UNTIL so previous secret is no longer accepted
    expect(() => verifyJwt(token, Date.now())).toThrow();
  });

  // ── tryVerifyJwt returns null on failure ────────────────────────────────────

  it('tryVerifyJwt returns null for invalid token', () => {
    const { tryVerifyJwt } = load();
    expect(tryVerifyJwt('garbage')).toBeNull();
  });

  // ── isPreviousJwtSecretActive ──────────────────────────────────────────────

  it('isPreviousJwtSecretActive is false when no previous secret', () => {
    const { isPreviousJwtSecretActive } = load();
    expect(isPreviousJwtSecretActive()).toBe(false);
  });

  it('isPreviousJwtSecretActive is true when previous + no UNTIL', () => {
    process.env.JWT_SECRET_PREVIOUS = PREVIOUS_SECRET;
    jest.resetModules();
    const { isPreviousJwtSecretActive } = load();
    expect(isPreviousJwtSecretActive()).toBe(true);
  });

  it('isPreviousJwtSecretActive respects UNTIL boundary', () => {
    process.env.JWT_SECRET_PREVIOUS = PREVIOUS_SECRET;
    const future = Math.floor((Date.now() + 3600_000) / 1000);
    process.env.JWT_SECRET_PREVIOUS_UNTIL = String(future);
    jest.resetModules();
    const { isPreviousJwtSecretActive } = load();
    expect(isPreviousJwtSecretActive(Date.now())).toBe(true);
    // After the deadline
    expect(isPreviousJwtSecretActive(future * 1000 + 1000)).toBe(false);
  });

  // ── JWT_SECRET_PREVIOUS_UNTIL accepts ISO-8601 ─────────────────────────────

  it('config parses ISO-8601 UNTIL', () => {
    process.env.JWT_SECRET_PREVIOUS = PREVIOUS_SECRET;
    process.env.JWT_SECRET_PREVIOUS_UNTIL = '2099-12-31T23:59:59Z';
    jest.resetModules();
    const { isPreviousJwtSecretActive } = load();
    expect(isPreviousJwtSecretActive()).toBe(true);
  });
});
