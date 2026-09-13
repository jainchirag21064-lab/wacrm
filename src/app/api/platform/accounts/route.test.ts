import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/platform/accounts
//
// Guards:
//   - non-platform-admin callers get 403 before any DB work
//   - the service-role client is used only after authorization
//   - the response shape carries every column the UI needs

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

const { GET } = await import('./route');
const { ForbiddenError } = await import('@/lib/auth/account');

// Queues per-table results. Each `.from(table)` resolves the next queued
// row for that table. Order of the route's queries:
//   1. accounts        (select + order)
//   2. profiles        (owners)
//   3. profiles        (member counts)
//   4. whatsapp_config (WhatsApp status)
type Queue = { data: unknown; error: unknown }[];

function makeAdminClient(queueByTable: Record<string, Queue>) {
  const counters: Record<string, number> = {};
  const calls: string[] = [];
  const superclient = {
    calls,
    from(table: string) {
      const idx = counters[table] ?? 0;
      counters[table] = idx + 1;
      calls.push(`from:${table}:${idx}`);
      const queued = queueByTable[table];
      const terminal = () =>
        Promise.resolve(
          idx < (queued?.length ?? 0)
            ? queued[idx]
            : { data: null, error: null }
        );
      return {
        select() {
          calls.push(`select:${table}:${idx}`);
          return {
            order() {
              return terminal();
            },
            in() {
              return terminal();
            },
          };
        },
      };
    },
    rpc(name: string) {
      calls.push(`rpc:${name}`);
      return Promise.resolve({ data: 3, error: null });
    },
  };
  return superclient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ userId: 'admin-1' });
});

describe('GET /api/platform/accounts', () => {
  it('returns 403 for a non-platform-admin caller', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required')
    );

    const res = await GET();

    expect(res.status).toBe(403);
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('returns the full account list with owner, member count and WhatsApp status', async () => {
    const client = makeAdminClient({
      accounts: [
        {
          data: [
            {
              id: 'acct-1',
              name: 'Acme',
              status: 'active',
              created_at: '2025-01-01T00:00:00Z',
              owner_user_id: 'owner-1',
              member_limit: 10,
            },
            {
              id: 'acct-2',
              name: 'Beta',
              status: 'suspended',
              created_at: '2025-02-01T00:00:00Z',
              owner_user_id: 'owner-2',
            },
          ],
          error: null,
        },
      ],
      profiles: [
        // owners
        {
          data: [
            { user_id: 'owner-1', full_name: 'Alice', email: 'alice@acme.com' },
            { user_id: 'owner-2', full_name: 'Bob', email: 'bob@beta.com' },
          ],
          error: null,
        },
        // memberships
        {
          data: [
            { account_id: 'acct-1' },
            { account_id: 'acct-1' },
            { account_id: 'acct-2' },
          ],
          error: null,
        },
      ],
      whatsapp_config: [{ data: [{ account_id: 'acct-1' }], error: null }],
    });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toHaveLength(2);
    expect(body.default_member_limit).toBe(3);
    expect(body.accounts[0]).toEqual({
      id: 'acct-1',
      name: 'Acme',
      status: 'active',
      created_at: '2025-01-01T00:00:00Z',
      owner_name: 'Alice',
      owner_email: 'alice@acme.com',
      member_count: 2,
      member_limit: 10,
      whatsapp_configured: true,
    });
    expect(body.accounts[1]).toEqual({
      id: 'acct-2',
      name: 'Beta',
      status: 'suspended',
      created_at: '2025-02-01T00:00:00Z',
      owner_name: 'Bob',
      owner_email: 'bob@beta.com',
      member_count: 1,
      member_limit: null,
      whatsapp_configured: false,
    });
    // The effective limit is fetched once for the UI's default display.
    expect(client.calls).toContain('rpc:account_member_limit');
  });

  it('returns an empty list when there are no accounts', async () => {
    const client = makeAdminClient({ accounts: [{ data: [], error: null }] });
    mocks.platformAdminClient.mockReturnValue(client);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });
});
