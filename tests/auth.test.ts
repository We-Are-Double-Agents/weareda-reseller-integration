/**
 * Inbound authentication - contract 3.1.
 * Direction: WeAreDA -> Reseller.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestSandbox,
  TEST_API_KEY,
  testConfig,
  type TestSandbox,
} from './helpers.js';

describe('inbound authentication (WeAreDA -> Reseller)', () => {
  let sandbox: TestSandbox;

  beforeAll(() => {
    sandbox = createTestSandbox();
  });

  afterAll(async () => {
    await sandbox.cleanup();
  });

  it('accepts a valid API key on GET /', async () => {
    const response = await sandbox.app.inject({ method: 'GET', url: '/', headers: authHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, service: 'weareda-reseller-reference' });
    expect(response.json().timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('rejects a missing API key with 401', async () => {
    const response = await sandbox.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects an invalid API key with 401', async () => {
    const response = await sandbox.app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-api-key': 'not-the-key' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('protects every contract endpoint, not just the health check', async () => {
    const calls = [
      { method: 'GET' as const, url: '/products' },
      { method: 'POST' as const, url: '/orders' },
      { method: 'POST' as const, url: '/orders/SO-1/cancel' },
      { method: 'POST' as const, url: '/orders/cancel' },
    ];
    for (const call of calls) {
      const response = await sandbox.app.inject({ ...call, payload: {} });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('never leaks the expected credential in the 401 body', async () => {
    const response = await sandbox.app.inject({ method: 'GET', url: '/' });
    expect(response.body).not.toContain(TEST_API_KEY);
  });

  describe('other mechanisms the contract allows', () => {
    it('bearer: Authorization: Bearer <key>', async () => {
      const bearer = createTestSandbox({ inbound: { ...testConfig().inbound, mode: 'bearer' } });
      const ok = await bearer.app.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
      });
      const bad = await bearer.app.inject({
        method: 'GET',
        url: '/',
        headers: { 'x-api-key': TEST_API_KEY },
      });
      expect(ok.statusCode).toBe(200);
      expect(bad.statusCode).toBe(401);
      await bearer.cleanup();
    });

    it('basic: Authorization: Basic base64(user:password)', async () => {
      const basic = createTestSandbox({
        inbound: {
          ...testConfig().inbound,
          mode: 'basic',
          basicUser: 'weareda',
          basicPassword: 'demo_secret',
        },
      });
      const encoded = Buffer.from('weareda:demo_secret').toString('base64');
      const ok = await basic.app.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Basic ${encoded}` },
      });
      const bad = await basic.app.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Basic ${Buffer.from('weareda:wrong').toString('base64')}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(bad.statusCode).toBe(401);
      await basic.cleanup();
    });

    it('custom: an arbitrary header name', async () => {
      const custom = createTestSandbox({
        inbound: { ...testConfig().inbound, mode: 'custom', customHeader: 'X-Auth-Token' },
      });
      const ok = await custom.app.inject({
        method: 'GET',
        url: '/',
        headers: { 'x-auth-token': TEST_API_KEY },
      });
      const bad = await custom.app.inject({
        method: 'GET',
        url: '/',
        headers: { 'x-api-key': TEST_API_KEY },
      });
      expect(ok.statusCode).toBe(200);
      expect(bad.statusCode).toBe(401);
      await custom.cleanup();
    });
  });

  it('leaves the unauthenticated liveness probe open (not a contract endpoint)', async () => {
    const response = await sandbox.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });
});
