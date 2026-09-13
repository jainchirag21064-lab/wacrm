// ============================================================
// GET /api/platform/access-requests
//
// Platform-admin-only. Lists public "Request Access" submissions with
// optional status filtering, free-text search (name / email / company
// / referral code) and pagination.
//
// Authorization is enforced here via requirePlatformAdmin() before the
// service-role client is touched. The service-role key is never
// exposed to the browser.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';
import type { SignupRequest, SignupRequestStatus } from '@/types';

const VALID_STATUSES: SignupRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'converted',
  'spam',
];

function toRequest(row: SignupRequest): SignupRequest {
  return row;
}

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const url = new URL(request.url);
    const rawStatus = url.searchParams.get('status') ?? '';
    const status = rawStatus
      ? (rawStatus as SignupRequestStatus)
      : 'pending';
    const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get('page_size') ?? 20) || 20),
    );

    // Validate the status filter before touching the service-role client.
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: 'Unknown status filter' },
        { status: 400 },
      );
    }

    let query = supabase.from('signup_requests').select(
      'id, full_name, email, company_name, message, referral_code, status, reviewed_by, reviewed_at, rejection_reason, platform_invite_id, created_at, updated_at',
      { count: 'exact' },
    );

    query = query.eq('status', status);

    if (search) {
      query = query.or(
        `full_name.ilike.%${search}%,email.ilike.%${search}%,company_name.ilike.%${search}%,referral_code.ilike.%${search}%`,
      );
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      console.error('[GET /api/platform/access-requests] error:', error);
      return NextResponse.json(
        { error: 'Failed to load access requests' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      requests: (data ?? []).map(toRequest),
      total: count ?? 0,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
