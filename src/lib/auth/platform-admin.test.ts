import { afterEach, describe, expect, it, vi } from 'vitest';

// requirePlatformAdmin verifies platform-admin status independent of
// profiles.account_role. Regression guards:
//   1. Platform-admin authorization must NOT consult account role.
//   2. It must go through the is_platform_admin RPC (not a direct
//      table read, which the restrictive RLS policy blocks).

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  rpcResult?: { data: unknown; error: unknown };
}) {
  const rpcCalls: RpcCall[] = [];
  const client = {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: opts.user },
          error: opts.userErr ?? null,
        }),
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(opts.rpcResult ?? { data: false, error: null });
    },
  };
  return { client, rpcCalls };
}

const createClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClient(),
}));

const { requirePlatformAdmin } = await import('./platform-admin');
const { UnauthorizedError, ForbiddenError } = await import('./account');

afterEach(() => {
  vi.clearAllMocks();
});

describe('requirePlatformAdmin', () => {
  it('resolves when the caller is a platform admin', async () => {
    const { client, rpcCalls } = makeClient({
      user: { id: 'admin-user' },
      rpcResult: { data: true, error: null },
    });
    createClient.mockReturnValue(client);

    const ctx = await requirePlatformAdmin();

    expect(ctx).toEqual({ userId: 'admin-user' });
    expect(rpcCalls).toEqual([
      { fn: 'is_platform_admin', args: { uid: 'admin-user' } },
    ]);
  });

  it('throws UnauthorizedError when there is no session', async () => {
    const { client } = makeClient({ user: null });
    createClient.mockReturnValue(client);
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it('throws ForbiddenError when the caller is not a platform admin', async () => {
    const { client } = makeClient({
      user: { id: 'regular-user' },
      rpcResult: { data: false, error: null },
    });
    createClient.mockReturnValue(client);
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws ForbiddenError when the RPC itself errors', async () => {
    const { client } = makeClient({
      user: { id: 'regular-user' },
      rpcResult: { data: null, error: { message: 'boom' } },
    });
    createClient.mockReturnValue(client);
    await expect(requirePlatformAdmin()).rejects.toThrow(
      'Could not verify platform admin status'
    );
  });

  it('never consults profiles/account_role', async () => {
    // The mock client has no .from() at all — if requirePlatformAdmin
    // tried to read profiles or accounts it would crash. Resolving
    // proves authorization went through the RPC only.
    const { client } = makeClient({
      user: { id: 'admin-user' },
      rpcResult: { data: true, error: null },
    });
    createClient.mockReturnValue(client);
    await expect(requirePlatformAdmin()).resolves.toEqual({
      userId: 'admin-user',
    });
  });
});
