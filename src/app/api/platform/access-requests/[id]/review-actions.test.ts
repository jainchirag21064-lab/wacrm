import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/access-requests/[id]/reject
// POST /api/platform/access-requests/[id]/spam
//
// Cases:
//   - non-platform-admin gets 403
//   - reject a pending request (optionally with reason)
//   - reject non-pending → 409
//   - spam a pending request
//   - missing → 404

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

const { POST: reject } = await import('./reject/route');
const { POST: spam } = await import('./spam/route');
const { ForbiddenError } = await import('@/lib/auth/account');

type Action = 'reject' | 'spam';

function makeClient(status: unknown) {
  const calls: string[] = [];
  return {
    calls,
    from() {
      calls.push('load');
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: status, error: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
  };
}

function call(action: Action, id = 'req-1', body?: string) {
  const fn = action === 'reject' ? reject : spam;
  const req = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return fn(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'admin-1' });
  mocks.checkRateLimit.mockReturnValue({ success: true, remaining: 29, reset: 0, limit: 30 });
});

describe('reject', () => {
  it('returns 403 for a non-platform-admin caller', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required'),
    );
    const client = makeClient({ status: 'pending' });
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await call('reject');
    expect(res.status).toBe(403);
    expect(client.calls.length).toBe(0);
  });

  it('rejects a pending request', async () => {
    const client = makeClient({ status: 'pending' });
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await call('reject', 'req-1', JSON.stringify({ rejection_reason: 'Not a fit' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'req-1', status: 'rejected' });
  });

  it('returns 409 for a non-pending request', async () => {
    mocks.platformAdminClient.mockReturnValue(makeClient({ status: 'approved' }));
    const res = await call('reject');
    expect(res.status).toBe(409);
  });

  it('returns 404 for a missing request', async () => {
    mocks.platformAdminClient.mockReturnValue(makeClient(null));
    const res = await call('reject', 'missing');
    expect(res.status).toBe(404);
  });
});

describe('spam', () => {
  it('returns 403 for a non-platform-admin caller', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required'),
    );
    const client = makeClient({ status: 'pending' });
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await call('spam');
    expect(res.status).toBe(403);
    expect(client.calls.length).toBe(0);
  });

  it('marks a pending request as spam', async () => {
    mocks.platformAdminClient.mockReturnValue(makeClient({ status: 'pending' }));
    const res = await call('spam');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'req-1', status: 'spam' });
  });

  it('returns 409 for a non-pending request', async () => {
    mocks.platformAdminClient.mockReturnValue(makeClient({ status: 'rejected' }));
    const res = await call('spam');
    expect(res.status).toBe(409);
  });
});
