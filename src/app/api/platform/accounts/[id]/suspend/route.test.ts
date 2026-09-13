import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/suspend
//
// Guards:
//   - non-platform-admin callers get 403 before any DB work
//   - a platform admin cannot suspend their own account (409)
//   - a missing account is 404
//   - successful suspend returns the new status

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

// Chainable supabase-js mock. The route drives the builder as:
//   .from('accounts').select(...).eq(...).maybeSingle()
//   .from('profiles').select(...).eq(...).eq(...).maybeSingle()
//   .from('accounts').update(...).eq(...)
function makeAdminClient(opts: {
  targetAccount?: { id: string; owner_user_id: string } | null;
  callerProfile?: { account_id: string } | null;
  updateError?: unknown;
}) {
  const calls: string[] = [];
  const client = {
    calls,
    from(table: string) {
      calls.push(`from:${table}`);
      const row =
        table === 'accounts'
          ? (opts.targetAccount ?? null)
          : (opts.callerProfile ?? null);

      return {
        select() {
          calls.push(`select:${table}`);
          return {
            eq() {
              calls.push(`eq:${table}:first`);
              return {
                eq() {
                  calls.push(`eq:${table}:second`);
                  return this;
                },
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'admin-1' });
});

afterEach(() => {});

describe('POST /api/platform/accounts/[id]/suspend', () => {
  it('returns 403 for non-platform-admin callers before any DB work', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required')
    );

    const res = await POST(
      new Request('http://localhost/', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'acct-1' }),
      }
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Platform admin access required');
    // The service-role client must never be touched for an unauthorized caller.
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('suspends an account when the caller is a platform admin', async () => {
    const client = makeAdminClient({
      targetAccount: { id: 'acct-1', owner_user_id: 'someone-else' },
      callerProfile: null,
    });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await POST(
      new Request('http://localhost/', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'acct-1' }),
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'acct-1', status: 'suspended' });
    expect(client.calls).toContain('update:accounts:{"status":"suspended"}');
  });

  it("rejects suspending the caller's own account with 409", async () => {
    const client = makeAdminClient({
      targetAccount: { id: 'acct-1', owner_user_id: 'someone-else' },
      callerProfile: { account_id: 'acct-1' },
    });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await POST(
      new Request('http://localhost/', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'acct-1' }),
      }
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('your own account');
    // No UPDATE ran.
    expect(client.calls.some((c) => c.startsWith('update:'))).toBe(false);
  });

  it('returns 404 for an unknown account', async () => {
    const client = makeAdminClient({
      targetAccount: null,
      callerProfile: null,
    });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await POST(
      new Request('http://localhost/', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'nope' }),
      }
    );

    expect(res.status).toBe(404);
  });
});
