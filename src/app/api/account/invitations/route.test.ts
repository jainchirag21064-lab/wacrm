import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/account/invitations — create invite link
//
// Seat-guard enforcement (migration 047):
//   - usage >= limit → 400 { code: 'seat_full' }
//   - DB trigger 22023 → 400 { code: 'seat_full' } (race window)
//   - usage < limit → inserts and returns 201

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  generateInviteToken: vi.fn(),
  inviteExpiresAt: vi.fn(),
  inviteUrl: vi.fn(),
  clampExpiryDays: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: mocks.requireRole,
  };
});

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
  RATE_LIMITS: { adminAction: {} },
}));

vi.mock('@/lib/auth/invitations', () => ({
  generateInviteToken: mocks.generateInviteToken,
  inviteExpiresAt: mocks.inviteExpiresAt,
  inviteUrl: mocks.inviteUrl,
  clampExpiryDays: mocks.clampExpiryDays,
}));

// The route reads NEXT_PUBLIC_SITE_URL from env to build invite URLs.
process.env.NEXT_PUBLIC_SITE_URL = 'https://app.test';

const { POST } = await import('./route');
const { ForbiddenError } = await import('@/lib/auth/account');

function makeClient(opts: {
  usage?: number;
  limit?: number;
  insertError?: { code?: string; message?: string } | null;
}) {
  const calls: string[] = [];
  return {
    calls,
    rpc(name: string) {
      calls.push(`rpc:${name}`);
      if (name === 'account_member_usage') {
        return Promise.resolve({ data: opts.usage ?? 0, error: null });
      }
      return Promise.resolve({ data: opts.limit ?? 3, error: null });
    },
    from() {
      calls.push('from:account_invitations');
      return {
        insert(payload: Record<string, unknown>) {
          calls.push(`insert:${JSON.stringify(payload)}`);
          return {
            select() {
              return {
                single: () =>
                  opts.insertError
                    ? Promise.resolve({ data: null, error: opts.insertError })
                    : Promise.resolve({
                        data: {
                          id: 'inv-1',
                          role: 'agent',
                          label: null,
                          expires_at: '2025-12-31T00:00:00Z',
                          created_at: '2025-11-01T00:00:00Z',
                        },
                        error: null,
                      }),
              };
            },
          };
        },
      };
    },
  };
}

function callPost(body: unknown = { role: 'agent' }) {
  return POST(
    new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    userId: 'admin-1',
    accountId: 'acct-1',
    role: 'admin',
    supabase: makeClient({}),
  });
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.rateLimitResponse.mockReturnValue(
    new Response('rate limited', { status: 429 })
  );
  mocks.generateInviteToken.mockReturnValue({ token: 'tok', hash: 'hash' });
  mocks.inviteExpiresAt.mockReturnValue(new Date('2025-12-31'));
  mocks.clampExpiryDays.mockReturnValue(7);
  mocks.inviteUrl.mockReturnValue('https://app.test/join/tok');
});

describe('POST /api/account/invitations', () => {
  it('returns 403 when the caller lacks admin role', async () => {
    mocks.requireRole.mockRejectedValue(
      new ForbiddenError('Admin role required')
    );

    const res = await callPost();

    expect(res.status).toBe(403);
  });

  it('creates an invite when seats are available', async () => {
    mocks.requireRole.mockResolvedValue({
      userId: 'admin-1',
      accountId: 'acct-1',
      role: 'admin',
      supabase: makeClient({ usage: 1, limit: 3 }),
    });

    const res = await callPost({ role: 'agent' });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toBe('https://app.test/join/tok');
    expect(body.code).toBeUndefined();
  });

  it('returns 400 with seat_full when no seat is available', async () => {
    mocks.requireRole.mockResolvedValue({
      userId: 'admin-1',
      accountId: 'acct-1',
      role: 'admin',
      supabase: makeClient({ usage: 3, limit: 3 }),
    });

    const res = await callPost({ role: 'viewer' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('seat_full');
    expect(body.error).toMatch(/member limit/);
  });

  it('returns 400 seat_full when the insert triggers a 22023 (race window)', async () => {
    mocks.requireRole.mockResolvedValue({
      userId: 'admin-1',
      accountId: 'acct-1',
      role: 'admin',
      supabase: makeClient({
        usage: 2,
        limit: 3,
        insertError: { code: '22023', message: 'seat cap' },
      }),
    });

    const res = await callPost({ role: 'agent' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('seat_full');
  });

  it('rejects an invalid role with 400', async () => {
    const res = await callPost({ role: 'owner' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/role/);
  });
});
