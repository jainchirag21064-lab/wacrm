import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// Member lifecycle routes (migration 045):
//   DELETE /api/account/members/[userId]         — deactivate (admin+)
//   POST  /api/account/members/[userId]/reactivate (admin+)
//   POST  /api/account/members/[userId]/delete   — permanent (owner-only)
//
// Cases covered per route:
//   - insufficient role → 403 (requireRole throws ForbiddenError)
//   - RPC rejects with 42501 (insufficient_privilege) → 403
//   - RPC rejects with 22023 (invalid_parameter_value) → 400
//   - success → { ok: true }

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: mocks.requireRole,
    toErrorResponse: mocks.toErrorResponse,
  };
});

vi.mock('@/lib/api/member-rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/member-rpc')>();
  return { rpcErrorToResponse: actual.rpcErrorToResponse };
});

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
  RATE_LIMITS: {},
}));

const { DELETE } = await import('./route');
const { POST: reactivate } = await import('./reactivate/route');
const { POST: deleteMember } = await import('./delete/route');

const { ForbiddenError } = await import('@/lib/auth/account');

function makeCtx(rpcResult: { error: unknown } | undefined = { error: null }) {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      userId: 'admin-1',
      accountId: 'acct-1',
      role: 'admin',
      supabase: {
        rpc: (name: string) => {
          calls.push(name);
          return Promise.resolve(rpcResult);
        },
      },
    },
  };
}

function callDelete(userId = 'member-1') {
  const req = new Request('http://localhost/api', { method: 'DELETE' });
  return DELETE(req, { params: Promise.resolve({ userId }) });
}

function callReactivate(userId = 'member-1') {
  const req = new Request('http://localhost/api', { method: 'POST' });
  return reactivate(req, { params: Promise.resolve({ userId }) });
}

function callDeletePermanent(userId = 'member-1') {
  const req = new Request('http://localhost/api', { method: 'POST' });
  return deleteMember(req, { params: Promise.resolve({ userId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(
    makeCtx().ctx as unknown as Awaited<ReturnType<typeof mocks.requireRole>>
  );
  mocks.toErrorResponse.mockImplementation((err: unknown) =>
    NextResponse.json(
      { error: (err as Error).message },
      { status: (err as { status?: number }).status ?? 500 }
    )
  );
  mocks.checkRateLimit.mockReturnValue({
    success: true,
    remaining: 29,
    reset: 0,
    limit: 30,
  });
});

describe('DELETE /api/account/members/[userId] (deactivate)', () => {
  it('returns 403 for a caller below admin', async () => {
    mocks.requireRole.mockRejectedValue(
      new ForbiddenError('This action requires the admin role or higher')
    );
    const res = await callDelete();
    expect(res.status).toBe(403);
  });

  it('deactivates a member', async () => {
    const { ctx, calls } = makeCtx();
    mocks.requireRole.mockResolvedValue(ctx as never);
    const res = await callDelete('member-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(['deactivate_account_member']);
  });

  it('maps a 42501 RPC rejection to 403', async () => {
    const { ctx } = makeCtx({ error: { code: '42501', message: 'No access' } });
    mocks.requireRole.mockResolvedValue(ctx as never);
    const res = await callDelete();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'No access' });
  });

  it('rejects when the target is this account owner (22023 → 400)', async () => {
    const { ctx } = makeCtx({
      error: {
        code: '22023',
        message: 'Cannot deactivate the account owner',
      },
    });
    mocks.requireRole.mockResolvedValue(ctx as never);
    const res = await callDelete();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Cannot deactivate the account owner',
    });
  });
});

describe('POST /api/account/members/[userId]/reactivate', () => {
  it('returns 403 for a caller below admin', async () => {
    mocks.requireRole.mockRejectedValue(
      new ForbiddenError('This action requires the admin role or higher')
    );
    const res = await callReactivate();
    expect(res.status).toBe(403);
  });

  it('reactivates a member', async () => {
    const { ctx, calls } = makeCtx();
    mocks.requireRole.mockResolvedValue(ctx as never);
    const res = await callReactivate('member-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(['reactivate_account_member']);
  });

  it('maps a 42501 RPC rejection to 403', async () => {
    const { ctx } = makeCtx({ error: { code: '42501', message: 'No access' } });
    mocks.requireRole.mockResolvedValue(ctx as never);
    const res = await callReactivate();
    expect(res.status).toBe(403);
  });
});

describe('POST /api/account/members/[userId]/delete', () => {
  it('returns 403 for a caller below owner', async () => {
    mocks.requireRole.mockRejectedValue(
      new ForbiddenError('This action requires the owner role or higher')
    );
    const res = await callDeletePermanent();
    expect(res.status).toBe(403);
  });

  it('permanently deletes a member as owner', async () => {
    const { ctx, calls } = makeCtx();
    mocks.requireRole.mockResolvedValue(ctx as never);
    const res = await callDeletePermanent('member-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(['delete_account_member']);
  });

  it('maps a 42501 RPC rejection to 403', async () => {
    const { ctx } = makeCtx({ error: { code: '42501', message: 'No access' } });
    mocks.requireRole.mockResolvedValue(ctx as never);
    const res = await callDeletePermanent();
    expect(res.status).toBe(403);
  });
});
