import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/platform/config/member-limit
//   GET  — current limit (platform admin only)
//   POST — update the limit (platform admin only, rate-limited)
//
// Cases:
//   - non-platform-admin → 403
//   - GET returns the current limit
//   - POST with a non-integer limit → 400
//   - POST with out-of-range limit → 400
//   - POST upserts and returns the new limit

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  platformAdminClient: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));

vi.mock('@/lib/supabase/platform-admin-client', () => ({
  platformAdminClient: mocks.platformAdminClient,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
  RATE_LIMITS: {},
}));

const { GET, POST } = await import('./route');
const { ForbiddenError } = await import('@/lib/auth/account');

function makeClient() {
  const calls: string[] = [];
  return {
    calls,
    rpc: (name: string) => {
      calls.push(`rpc:${name}`);
      return Promise.resolve({ data: 3, error: null });
    },
    from: () => ({
      upsert: () => {
        calls.push('upsert');
        return Promise.resolve({ error: null });
      },
    }),
  };
}

function callPost(body?: string) {
  const req = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return POST(req);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'admin-1' });
  mocks.checkRateLimit.mockReturnValue({
    success: true,
    remaining: 29,
    reset: 0,
    limit: 30,
  });
});

describe('GET /api/platform/config/member-limit', () => {
  it('returns 403 for a non-platform-admin caller', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required')
    );
    const client = makeClient();
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(client.calls.length).toBe(0);
  });

  it('returns the current limit', async () => {
    const client = makeClient();
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limit: 3 });
    expect(client.calls).toEqual(['rpc:account_member_limit']);
  });
});

describe('POST /api/platform/config/member-limit', () => {
  it('returns 403 for a non-platform-admin caller', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required')
    );
    const client = makeClient();
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await callPost(JSON.stringify({ limit: 5 }));
    expect(res.status).toBe(403);
    expect(client.calls.length).toBe(0);
  });

  it('returns 400 for a non-integer limit', async () => {
    const client = makeClient();
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await callPost(JSON.stringify({ limit: '5' }));
    expect(res.status).toBe(400);
    expect(client.calls.length).toBe(0);
  });

  it('returns 400 for an out-of-range limit', async () => {
    const client = makeClient();
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await callPost(JSON.stringify({ limit: 1001 }));
    expect(res.status).toBe(400);
    expect(client.calls.length).toBe(0);
  });

  it('upserts the limit and returns it', async () => {
    const client = makeClient();
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await callPost(JSON.stringify({ limit: 5 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limit: 5 });
    expect(client.calls).toEqual(['upsert']);
  });

  it('returns 429 when rate-limited', async () => {
    mocks.checkRateLimit.mockReturnValue({
      success: false,
      remaining: 0,
      reset: Date.now() + 60_000,
      limit: 30,
    });
    mocks.rateLimitResponse.mockReturnValue(
      new Response('rate limited', { status: 429 })
    );
    const client = makeClient();
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await callPost(JSON.stringify({ limit: 5 }));
    expect(res.status).toBe(429);
    expect(client.calls.length).toBe(0);
  });
});
