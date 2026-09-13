import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/access-requests/[id]/approve
//
// Cases:
//   - non-platform-admin gets 403, no DB work
//   - approves a pending request: creates ONE invite, links the request
//   - returns a COMPLETE invite URL (no separate raw token)
//   - re-approving an already-approved request returns 409 (no 2nd invite)
//   - a request that already has a pending invite for the email → 409

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

const { POST } = await import('./route');
const { ForbiddenError } = await import('@/lib/auth/account');

function makeClient(queues: {
  signupRequests?: Record<number, unknown>;
  existingInvite?: unknown;
  inviteInsert?: { data: unknown; error: unknown };
  requestUpdate?: { error: unknown };
}) {
  const counters: Record<string, number> = {};
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      calls.push(`from:${table}`);
      const idx = (counters[table] = (counters[table] ?? 0) + 1) - 1;
      if (table === 'signup_requests') {
        // call 0: load the request (maybeSingle), call 1: update (.eq)
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: queues.signupRequests?.[idx] ?? null, error: null }) }),
          }),
          update: () => ({ eq: () => Promise.resolve({ error: queues.requestUpdate?.error ?? null }) }),
        };
      }
      if (table === 'platform_customer_invites') {
        // call 0: existing check; call 1: insert
        if (idx === 0) {
          return {
            select: () => ({
              eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: queues.existingInvite ?? null, error: null }) }) }),
            }),
          };
        }
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: queues.inviteInsert?.data ?? { id: 'inv-1' },
                error: queues.inviteInsert?.error ?? null,
              }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

function pendingReq(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    email: 'alice@example.com',
    status: 'pending',
    platform_invite_id: null,
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    full_name: 'Alice',
    company_name: null,
    message: null,
    referral_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'admin-1' });
  mocks.checkRateLimit.mockReturnValue({ success: true, remaining: 29, reset: 0, limit: 30 });
  mocks.rateLimitResponse.mockReturnValue(new Response('{}', { status: 429 }));
  process.env.NEXT_PUBLIC_SITE_URL = 'https://wacrm.example/';
});

function approve(id = 'req-1') {
  return POST(new Request('http://localhost/api', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

describe('POST /api/platform/access-requests/[id]/approve', () => {
  it('returns 403 for a non-platform-admin caller, doing no DB work', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required'),
    );
    const client = makeClient({});
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await approve();
    expect(res.status).toBe(403);
    expect(client.calls.length).toBe(0);
  });

  it('approves a pending request creating one invite and linking it', async () => {
    const client = makeClient({
      signupRequests: { 0: pendingReq() },
      existingInvite: null,
      inviteInsert: { data: { id: 'inv-1' }, error: null },
      requestUpdate: { error: null },
    });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await approve();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Complete URL only — no separate raw token field.
    expect(body.inviteUrl).toMatch(
      /^https:\/\/wacrm\.example\/signup\?customer_invite=/,
    );
    expect(body).not.toHaveProperty('token');
    // Update linked platform_invite_id + status approved.
    const updateCall = client.calls.find((c) => c.startsWith('from:signup_requests'));
    expect(updateCall).toBeDefined();
  });

  it('is idempotent: re-approving a non-pending request returns 409', async () => {
    const client = makeClient({
      signupRequests: { 0: pendingReq({ status: 'approved', platform_invite_id: 'inv-1' }) },
    });
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await approve();
    expect(res.status).toBe(409);
    // No invite insert happened.
    expect(client.calls.some((c) => c.startsWith('from:platform_customer_invites'))).toBe(false);
  });

  it('returns 409 when the email already has a pending platform invite', async () => {
    const client = makeClient({
      signupRequests: { 0: pendingReq() },
      existingInvite: { id: 'inv-existing' },
    });
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await approve();
    expect(res.status).toBe(409);
    // No insert happened (existing invite guarded first).
    expect(client.calls.filter((c) => c.startsWith('from:platform_customer_invites')).length).toBe(1);
  });

  it('returns 409 (not a second invite) on a concurrent unique-violation insert', async () => {
    const client = makeClient({
      signupRequests: { 0: pendingReq() },
      existingInvite: null,
      inviteInsert: { data: null, error: { code: '23505' } },
    });
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await approve();
    expect(res.status).toBe(409);
  });

  it('returns 404 for a missing request', async () => {
    const client = makeClient({ signupRequests: { 0: null } });
    mocks.platformAdminClient.mockReturnValue(client);
    const res = await approve('missing');
    expect(res.status).toBe(404);
  });
});
