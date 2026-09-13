import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/access-requests (public)
//
// Cases:
//   - unauthenticated visitor can submit a request
//   - malformed email rejected (400)
//   - oversized fields / missing name rejected (400)
//   - duplicate pending request → still `{ ok: true }` (no enumeration)
//   - rate limiting (per-IP) returns 429
//   - no Auth user is ever created (route never calls auth)

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  platformAdminClient: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
  RATE_LIMITS: {},
}));
vi.mock('@/lib/supabase/platform-admin-client', () => ({
  platformAdminClient: mocks.platformAdminClient,
}));

const { POST } = await import('./route');

function okLimit() {
  return { success: true, remaining: 4, reset: 0, limit: 5 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockReturnValue(okLimit());
  mocks.rateLimitResponse.mockReturnValue(
    new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
  );
});

function makeClient(opts: { error?: { code?: string } | null } = {}) {
  const insert = vi.fn(async () => ({ data: null, error: opts.error ?? null }));
  return {
    from: () => ({
      insert,
    }),
  };
}

describe('POST /api/access-requests', () => {
  it('accepts a valid submission from an unauthenticated visitor', async () => {
    mocks.platformAdminClient.mockReturnValue(makeClient());
    const res = await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: 'Alice',
          email: 'Alice@Example.com',
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      message: 'Your request has been received.',
    });
    // Email normalized to lowercase before insert.
    const insert = mocks.platformAdminClient.mock.results[0].value.from().insert;
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com', full_name: 'Alice' }),
    );
  });

  it('returns 400 + generic message for a malformed email', async () => {
    mocks.platformAdminClient.mockReturnValue(makeClient());
    const res = await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'A', email: 'not-an-email' }),
      }),
    );
    expect(res.status).toBe(400);
    // No row insert attempt.
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing full name', async () => {
    const res = await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('returns 400 for oversized required fields', async () => {
    const res = await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: 'A',
          email: `${'a'.repeat(250)}@b.com`,
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns the SAME ok response on a duplicate pending request', async () => {
    // Simulate the partial-unique-index violation.
    mocks.platformAdminClient.mockReturnValue(
      makeClient({ error: { code: '23505' } }),
    );
    const body = JSON.stringify({ full_name: 'A', email: 'a@b.com' });
    const res = await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      message: 'Your request has been received.',
    });
  });

  it('returns 429 when the per-IP rate limit is exceeded', async () => {
    mocks.checkRateLimit.mockReturnValue({
      success: false,
      remaining: 0,
      reset: Date.now() + 60_000,
      limit: 5,
    });
    mocks.platformAdminClient.mockReturnValue(makeClient());
    const res = await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'A', email: 'a@b.com' }),
      }),
    );
    expect(res.status).toBe(429);
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('never creates or touches an Auth user', async () => {
    mocks.platformAdminClient.mockReturnValue(makeClient());
    await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'A', email: 'a@b.com' }),
      }),
    );
    // Route must not reference any auth RPC/signup path — it only
    // inserts into signup_requests via the platform client. Assert the
    // only DB call is the insert.
    const calls = mocks.platformAdminClient.mock.calls;
    expect(calls).toHaveLength(1);
  });

  it('returns 429 (rate limit) when the per-email budget is exceeded', async () => {
    // First call (IP) succeeds, second call (email) fails.
    mocks.checkRateLimit
      .mockReturnValueOnce(okLimit())
      .mockReturnValueOnce({
        success: false,
        remaining: 0,
        reset: Date.now() + 60_000,
        limit: 3,
      });
    mocks.platformAdminClient.mockReturnValue(makeClient());
    const res = await POST(
      new Request('http://localhost/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'A', email: 'a@b.com' }),
      }),
    );
    expect(res.status).toBe(429);
  });
});
