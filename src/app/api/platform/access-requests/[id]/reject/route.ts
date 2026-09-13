// ============================================================
// POST /api/platform/access-requests/[id]/reject
//
// Platform-admin-only. Rejects a PENDING access request: stores an
// optional (safely length-bounded) rejection reason and sets
// status='rejected' with reviewed_by / reviewed_at. No invitation is
// created.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_REJECTION_REASON = 500;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const limit = checkRateLimit(
      `platform:accessRequestReject:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Missing request id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      rejection_reason?: unknown;
    } | null;
    let rejectionReason: string | null = null;
    if (
      body &&
      typeof body.rejection_reason === 'string' &&
      body.rejection_reason.trim().length > 0
    ) {
      rejectionReason = body.rejection_reason.trim().slice(0, MAX_REJECTION_REASON);
    }

    // Verify it's pending before mutating.
    const { data: req, error: loadErr } = await supabase
      .from('signup_requests')
      .select('status')
      .eq('id', id)
      .maybeSingle();
    if (loadErr) {
      console.error('[reject] load error:', loadErr);
      return NextResponse.json(
        { error: 'Failed to load request' },
        { status: 500 },
      );
    }
    if (!req) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }
    if (req.status !== 'pending') {
      return NextResponse.json(
        {
          error:
            req.status === 'rejected'
              ? 'This request has already been rejected'
              : `This request cannot be rejected (status: ${req.status})`,
        },
        { status: 409 },
      );
    }

    const { error } = await supabase
      .from('signup_requests')
      .update({
        status: 'rejected',
        rejection_reason: rejectionReason,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      console.error('[reject] error:', error);
      return NextResponse.json(
        { error: 'Failed to reject request' },
        { status: 500 },
      );
    }

    return NextResponse.json({ id, status: 'rejected' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
