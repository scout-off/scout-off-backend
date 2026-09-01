import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue(null),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  getSubscriptionsByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  submitContactPayment: jest.fn(),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

const SCOUT_A = 'GBR74NFBBGUV3VPNRT77QKUE55O4EAYTF52BACRRXOJ4GLBQOSH7EUNH';
const SCOUT_B = 'GBDVKEFA4VTCQOORAW5VGF27XXLBK425EQR64Y47KJGGQ2TEUNJVX7PF';

function makeScoutToken(wallet: string): string {
  return jwt.sign({ sub: wallet, role: 'scout' }, SECRET, { expiresIn: '1h' });
}

describe('GET /api/scouts/:wallet/payments — wallet ownership enforcement', () => {
  it('returns 403 when Scout A tries to read Scout B payment history', async () => {
    const tokenA = makeScoutToken(SCOUT_A);
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_B}/payments`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 when Scout A reads their own payment history', async () => {
    const tokenA = makeScoutToken(SCOUT_A);
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/payments`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/scouts/${SCOUT_A}/payments`);
    expect(res.status).toBe(401);
  });
});
