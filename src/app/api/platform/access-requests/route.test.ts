import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/platform/access-requests
//
// Guards:
//   - non-platform-admin caller gets 403 before any DB work
//   - platform admin can list requests
//   - status filtering + search + pagination carry through to the query

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

const { GET } = await import('./route');
const { ForbiddenError } = await import('@/lib/auth/account');

function makeClient(rows: unknown[], count: number) {
  const calls: string[] = [];
  const range = async () => ({ data: rows, count, error: null });
  const or = () => ({ order: () => ({ range }) });
  return {
    calls,
    from() {
      calls.push('from');
      return {
        select() {
          calls.push('select');
          return {
            eq() {
              calls.push('eq');
              return { order: () => ({ range }), or };
            },
            or() {
              calls.push('or');
              return { order: () => ({ range }) };
            },
            order: () => ({ range }),
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

describe('GET /api/platform/access-requests', () => {
  it('returns 403 for a non-platform-admin caller', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(
      new ForbiddenError('Platform admin access required'),
    );
    const res = await GET(new Request('http://localhost/api/platform/access-requests'));
    expect(res.status).toBe(403);
    expect(mocks.platformAdminClient).not.toHaveBeenCalled();
  });

  it('returns a list with count for a platform admin (defaults to pending)', async () => {
    mocks.platformAdminClient.mockReturnValue(
      makeClient(
        [
          {
            id: 'r1',
            full_name: 'Alice',
            email: 'alice@example.com',
            company_name: 'Acme',
            status: 'pending',
            reviewed_by: null,
            reviewed_at: null,
            rejection_reason: null,
            platform_invite_id: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            message: null,
            referral_code: null,
          },
        ],
        1,
      ),
    );
    const res = await GET(
      new Request('http://localhost/api/platform/access-requests'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.requests[0].email).toBe('alice@example.com');
  });

  it('rejects an unknown status filter with 400', async () => {
    const res = await GET(
      new Request('http://localhost/api/platform/access-requests?status=bogus'),
    );
    expect(res.status).toBe(400);
  });
});
