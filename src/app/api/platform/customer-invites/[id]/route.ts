// ============================================================
// DELETE /api/platform/customer-invites/[id]
//
// Platform-admin-only. Revokes a pending customer invite. Once
// revoked the email is no longer allow-listed and cannot register.
//
// We soft-delete (status = 'revoked') rather than hard-delete so the
// platform audit trail / UI history stays coherent — a revoked invite
// still shows up (filtered to revoked) with its creation metadata.
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const limit = checkRateLimit(
      `platform:customerInviteRevoke:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: 'Missing invite id' },
        { status: 400 },
      );
    }

    const { data: invite, error: loadErr } = await supabase
      .from('platform_customer_invites')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();

    if (loadErr) {
      console.error('[DELETE customer-invite] load error:', loadErr);
      return NextResponse.json(
        { error: 'Failed to load invite' },
        { status: 500 },
      );
    }
    if (!invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }
    if (invite.status !== 'pending') {
      return NextResponse.json(
        { error: `Only pending invitations can be revoked (status: ${invite.status})` },
        { status: 409 },
      );
    }

    const { error } = await supabase
      .from('platform_customer_invites')
      .update({ status: 'revoked' })
      .eq('id', id);

    if (error) {
      console.error('[DELETE customer-invite] error:', error);
      return NextResponse.json(
        { error: 'Failed to revoke invite' },
        { status: 500 },
      );
    }

    return NextResponse.json({ id, status: 'revoked' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
