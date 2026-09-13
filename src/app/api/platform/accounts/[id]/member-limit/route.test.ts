import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/member-limit
//
// Guards:
//   - non-platform-admin callers get 403 before any DB work
//   - limit must be null (clear) or a whole number in [0, 1000]
//   - malformed JSON is 400
//   - a missing account is 404
//   - a valid override persists as accounts.member_limit

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  platformAdminClient: vi.fn(),
}));

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));
vi.mock('@/lib/supabase/platform-admin-client', () => ({
  platformAdminClient: mocks.platformAdminClient,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

const { POST } = await import('./route');
const { ForbiddenError } = await import('@/lib/auth/account');

function makeAdminClient(opts: {
  targetAccount?: { id: string } | null;
  updateError?: unknown;
}) {
  const calls: string[] = [];
  const client = {
    calls,
    from(table: string) {
      calls.push(`from:${table}`);
      const row = opts.targetAccount ?? null;
      return {
        select() {
          calls.push(`select:${table}`);
          return {
            eq() {
              calls.push(`eq:${table}:first`);
              return {
                maybeSingle: () => Promise.resolve({ data: row, error: null }),
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          calls.push(`update:${table}:${JSON.stringify(payload)}`);
          return {
            eq() {
              calls.push(`eqUpdate:${table}`);
              return Promise.resolve({
                data: null,
                error: opts.updateError ?? null,
              });
            },
          };
        },
      };
    },
  };
  return client;
}

const post = (body: unknown, id = 'acct-1') =>
  POST(
    new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    {
      params: Promise.resolve({ id }),
    }
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'admin-1' });
});

afterEach(() => {});

describe('POST /api/platform/accounts/[id]/member-limit', () => {
  it('returns 403 for non-platform-admin callers before any DB work', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required')
    );

    const res = await post({ limit: 10 });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Platform admin access required');
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('sets a per-account override', async () => {
    const client = makeAdminClient({ targetAccount: { id: 'acct-1' } });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await post({ limit: 10 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'acct-1', member_limit: 10 });
    expect(client.calls).toContain('update:accounts:{"member_limit":10}');
  });

  it('clears the override with an explicit null', async () => {
    const client = makeAdminClient({ targetAccount: { id: 'acct-1' } });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await post({ limit: null });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'acct-1', member_limit: null });
    expect(client.calls).toContain('update:accounts:{"member_limit":null}');
  });

  it('treats a missing limit as clearing the override', async () => {
    const client = makeAdminClient({ targetAccount: { id: 'acct-1' } });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await post({});

    expect(res.status).toBe(200);
    expect((await res.json()).member_limit).toBeNull();
  });

  it('rejects negative, fractional, and over-1000 limits with 400', async () => {
    const client = makeAdminClient({ targetAccount: { id: 'acct-1' } });
    mocks.platformAdminClient.mockReturnValue(client);

    for (const limit of [-1, 1.5, 1001]) {
      const res = await post({ limit });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/between 0 and 1000/);
    }

    // No UPDATE ever ran for the invalid attempts.
    expect(client.calls.some((c) => c.startsWith('update:'))).toBe(false);
  });

  it('rejects a non-numeric limit string with 400', async () => {
    const client = makeAdminClient({ targetAccount: { id: 'acct-1' } });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await post({ limit: 'ten' });

    expect(res.status).toBe(400);
    expect(client.calls.some((c) => c.startsWith('update:'))).toBe(false);
  });

  it('rejects malformed JSON with 400', async () => {
    mocks.platformAdminClient.mockReturnValue(
      makeAdminClient({ targetAccount: { id: 'acct-1' } })
    );

    const res = await POST(
      new Request('http://localhost/', { method: 'POST', body: '{nope' }),
      { params: Promise.resolve({ id: 'acct-1' }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
  });

  it('returns 404 for an unknown account', async () => {
    const client = makeAdminClient({ targetAccount: null });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await post({ limit: 10 });

    expect(res.status).toBe(404);
    expect(client.calls.some((c) => c.startsWith('update:'))).toBe(false);
  });
});
