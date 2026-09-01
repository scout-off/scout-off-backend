import { Request, Response } from 'express';
import { setIpReputationController, getIpReputationController } from '../../src/controllers/ipReputationController';
import { resetReputationStore, getReputation } from '../../src/services/ipReputation';

function mockRes() {
  const res: Partial<Response> & { status: jest.Mock; json: jest.Mock } = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

describe('setIpReputationController', () => {
  beforeEach(() => {
    resetReputationStore();
  });

  it('accepts a valid IPv4 address', () => {
    const req = { body: { ip: '203.0.113.5', score: 100 } } as Request;
    const res = mockRes();

    setIpReputationController(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ip: '203.0.113.5', score: 100 } });
    expect(getReputation('203.0.113.5')?.score).toBe(100);
  });

  it('accepts a valid IPv6 address', () => {
    const req = { body: { ip: '2001:db8::1', score: 0 } } as Request;
    const res = mockRes();

    setIpReputationController(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ip: '2001:db8::1', score: 0 } });
    expect(getReputation('2001:db8::1')?.score).toBe(0);
  });

  it('rejects an empty ip', () => {
    const req = { body: { ip: '', score: 100 } } as Request;
    const res = mockRes();

    setIpReputationController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'ip is required' });
  });

  it('rejects a malformed dotted-quad address', () => {
    const req = { body: { ip: '999.999.999.999', score: 100 } } as Request;
    const res = mockRes();

    setIpReputationController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'ip must be a valid IPv4 or IPv6 address' });
  });

  it('rejects random text', () => {
    const req = { body: { ip: 'not-an-ip', score: 100 } } as Request;
    const res = mockRes();

    setIpReputationController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'ip must be a valid IPv4 or IPv6 address' });
  });

  it('does not store a rejected malformed ip', () => {
    const req = { body: { ip: 'not-an-ip', score: 100 } } as Request;
    const res = mockRes();

    setIpReputationController(req, res);

    expect(getReputation('not-an-ip')).toBeUndefined();
  });
});

describe('getIpReputationController', () => {
  beforeEach(() => {
    resetReputationStore();
  });

  it('returns the reputation record for a valid IPv4 address', () => {
    const setReq = { body: { ip: '198.51.100.7', score: 50 } } as Request;
    setIpReputationController(setReq, mockRes());

    const req = { params: { ip: '198.51.100.7' } } as unknown as Request;
    const res = mockRes();

    getIpReputationController(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ score: 50 }),
    });
  });

  it('returns null data for a valid but unknown IPv6 address', () => {
    const req = { params: { ip: '::1' } } as unknown as Request;
    const res = mockRes();

    getIpReputationController(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null });
  });

  it('rejects a malformed ip param', () => {
    const req = { params: { ip: 'not-an-ip' } } as unknown as Request;
    const res = mockRes();

    getIpReputationController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'ip must be a valid IPv4 or IPv6 address' });
  });

  it('rejects an empty ip param', () => {
    const req = { params: { ip: '' } } as unknown as Request;
    const res = mockRes();

    getIpReputationController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'ip must be a valid IPv4 or IPv6 address' });
  });
});
