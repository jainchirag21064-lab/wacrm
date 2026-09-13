// ============================================================
// POST /api/platform/access-requests/[id]/spam
//
// Platform-admin-only. Marks a PENDING access request as spam and sets
// reviewed_by / reviewed_at. No invitation is created.
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

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const limit = checkRateLimit(
      `platform:accessRequestSpam:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Missing request id' }, { status: 400 });
    }

    const { data: req, error: loadErr } = await supabase
      .from('signup_requests')
      .select('status')
      .eq('id', id)
      .maybeSingle();
    if (loadErr) {
      console.error('[spam] load error:', loadErr);
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
            req.status === 'spam'
              ? 'This request is already marked as spam'
              : `This request cannot be marked as spam (status: ${req.status})`,
        },
        { status: 409 },
      );
    }

    const { error } = await supabase
      .from('signup_requests')
      .update({
        status: 'spam',
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      console.error('[spam] error:', error);
      return NextResponse.json(
        { error: 'Failed to mark request as spam' },
        { status: 500 },
      );
    }

    return NextResponse.json({ id, status: 'spam' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
