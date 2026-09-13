import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/platform/accounts/[id]/reactivate
//
// Guards:
//   - non-platform-admin callers get 403 before any DB work
//   - a missing account is 404
//   - successful reactivation returns the new status

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

// Minimal supabase-js mock: from('accounts') -> select -> eq -> maybeSingle
// returns the target account; update -> eq resolves the desired result.
function makeAdminClient(opts: {
  targetAccount?: { id: string } | null;
  updateError?: unknown;
}) {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      if (table !== 'accounts') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          calls.push('select:accounts');
          return {
            eq() {
              calls.push('eq:accounts');
              return {
                maybeSingle: () =>
                  Promise.resolve({
                    data: opts.targetAccount ?? null,
                    error: null,
                  }),
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          calls.push(`update:accounts:${JSON.stringify(payload)}`);
          return {
            eq() {
              calls.push('eqUpdate:accounts');
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
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'admin-1' });
});

describe('POST /api/platform/accounts/[id]/reactivate', () => {
  it('returns 403 for a non-platform-admin caller', async () => {
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
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('reactivates an account', async () => {
    const client = makeAdminClient({ targetAccount: { id: 'acct-1' } });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await POST(
      new Request('http://localhost/', { method: 'POST' }),
      {
        params: Promise.resolve({ id: 'acct-1' }),
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'acct-1', status: 'active' });
    expect(client.calls).toContain('update:accounts:{"status":"active"}');
  });

  it('returns 404 for an unknown account', async () => {
    const client = makeAdminClient({ targetAccount: null });
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
