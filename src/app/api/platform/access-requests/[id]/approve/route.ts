// ============================================================
// POST /api/platform/access-requests/[id]/approve
//
// Platform-admin-only. Approves a PENDING access request by:
//   1. verifying it is still pending,
//   2. creating a secure platform customer invitation for the
//      request's normalized email,
//   3. linking platform_invite_id, status='approved', reviewed_by /
//      reviewed_at.
//
// Returns the COMPLETE invitation URL only — never the raw token.
//
// Idempotency: re-approving an already-approved (or otherwise
// non-pending) request returns 409 WITHOUT creating a new invite. A
// second concurrent approval for the same email is additionally
// stopped by the DB's unique partial index on pending invites
// (migration 044), which surfaces as a unique_violation we map to 409.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';
import { customerInviteUrl, generateInviteToken } from '@/lib/auth/invitations';
import { resolvePublicOrigin } from '@/lib/auth/redirect-url';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const limit = checkRateLimit(
      `platform:accessRequestApprove:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Missing request id' }, { status: 400 });
    }

    // Load the request; fail if missing or not pending.
    const { data: req, error: loadErr } = await supabase
      .from('signup_requests')
      .select(
        'id, email, status, platform_invite_id, reviewed_by, reviewed_at, rejection_reason, full_name, company_name, message, referral_code, created_at, updated_at',
      )
      .eq('id', id)
      .maybeSingle();

    if (loadErr) {
      console.error('[approve] load error:', loadErr);
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
            req.status === 'approved'
              ? 'This request has already been approved'
              : `This request cannot be approved (status: ${req.status})`,
        },
        { status: 409 },
      );
    }

    // Another pending platform invite may already exist for this email
    // (a previous approval that linked, or a manual creation). Creating
    // a second pending invite would orphan the first's URL, and we can
    // never reconstruct it (only its hash is stored). Fail clearly
    // instead of silently creating a duplicate.
    const { data: existing, error: existingErr } = await supabase
      .from('platform_customer_invites')
      .select('id')
      .eq('email', req.email)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingErr) {
      console.error('[approve] existing check error:', existingErr);
      return NextResponse.json(
        { error: 'Failed to check existing invitations' },
        { status: 500 },
      );
    }
    if (existing) {
      return NextResponse.json(
        {
          error:
            'This email already has a pending platform invitation. Revoke it or check /platform/customer-invites.',
        },
        { status: 409 },
      );
    }

    const { token, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { data: invite, error: inviteErr } = await supabase
      .from('platform_customer_invites')
      .insert({
        email: req.email,
        token_hash: hash,
        status: 'pending',
        created_by_platform_admin: userId,
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single();

    if (inviteErr) {
      if (inviteErr.code === '23505') {
        // Concurrent approval won the race; only one invite exists.
        return NextResponse.json(
          { error: 'This email already has a pending platform invitation.' },
          { status: 409 },
        );
      }
      console.error('[approve] invite insert error:', inviteErr);
      return NextResponse.json(
        { error: 'Failed to create platform invitation' },
        { status: 500 },
      );
    }

    // Link the request to the new invite and mark it approved.
    const { error: updateErr } = await supabase
      .from('signup_requests')
      .update({
        status: 'approved',
        platform_invite_id: invite.id,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (updateErr) {
      // The invite exists but the link failed — surface the URL so the
      // admin can still send it, keeping the flow usable. (No harm: the
      // invite is valid either way.)
      console.error('[approve] request link error:', updateErr);
    }

    const inviteUrl = customerInviteUrl(token, resolvePublicOrigin(request));
    return NextResponse.json({ inviteUrl, request_id: id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
