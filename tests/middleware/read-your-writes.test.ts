import { canReadReplica, readConsistencyMiddleware, verifyReadAfter } from '../../src/middleware/readYourWrites';
import type { Request, Response } from 'express';

describe('read-your-writes context', () => {
  const previous = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret-for-read-after-marker'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET=previous;
  });
  const call = (method: string, marker?: string) => {
    const setHeader=jest.fn();
    const req={method,headers:{},get: (key:string)=> key==='X-Read-After'?marker:undefined} as unknown as Request;
    const res={setHeader} as unknown as Response;
    let eligible=false;
    readConsistencyMiddleware(req,res,()=> {eligible=canReadReplica();});
    return {eligible,setHeader};
  };
  it('permits unsigned GETs to use replicas and writes to remain primary', () => {
    expect(call('GET').eligible).toBe(true);
    expect(call('POST').eligible).toBe(false);
    expect(canReadReplica()).toBe(false); // background workers have no request context
  });
  it('issues signed markers that pin the next GET to primary', () => {
    const {setHeader}=call('POST');
    const marker=setHeader.mock.calls.find((args: unknown[])=>args[0]==='X-Read-After')?.[1];
    expect(verifyReadAfter(marker)).toBe(true);
    expect(call('GET',marker).eligible).toBe(false);
    expect(call('GET',marker+'broken').eligible).toBe(true);
  });
  it('does not trust malformed markers',()=>{
    expect(verifyReadAfter(undefined)).toBe(false);
    expect(verifyReadAfter('not-a-token')).toBe(false);
  });
});
