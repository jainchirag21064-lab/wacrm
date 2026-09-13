// ============================================================
// /api/platform/customer-invites
//
//   GET  — list customer invites.
//   POST — create a customer invite (invite-only onboarding).
//
// Platform-admin-only. These are the "approved customer" invites
// for the SaaS onboarding model: a platform admin approves an
// email, and that email may then register a customer account.
//
// The plaintext token is returned exactly ONCE (embedded in the
// complete shareable /signup?customer_invite=<token> URL from POST);
// the DB stores only the SHA-256 hash (see
// platform_customer_invites.token_hash), satisfying "never store
// plaintext invitation tokens". The client shows the whole URL, not
// the bare token.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import type {
  CustomerInviteStatus,
  PlatformCustomerInvite,
} from '@/types';
import {
  customerInviteUrl,
  generateInviteToken,
  inviteExpiresAt,
} from '@/lib/auth/invitations';
import { resolvePublicOrigin } from '@/lib/auth/redirect-url';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const DEFAULT_EXPIRY_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteRow {
  id: string;
  email: string;
  status: CustomerInviteStatus;
  created_by_platform_admin: string | null;
  created_at: string;
  signup_started_at: string | null;
  accepted_at: string | null;
  expires_at: string;
}

function toInvite(row: InviteRow): PlatformCustomerInvite {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    created_by_platform_admin: row.created_by_platform_admin,
    created_at: row.created_at,
    signup_started_at: row.signup_started_at,
    accepted_at: row.accepted_at,
    expires_at: row.expires_at,
  };
}

// Mark a pending invite `expired` if it has passed expires_at, so
// the platform UI reflects reality without a background job.
function normalizeStatus(
  rows: InviteRow[],
  now: Date,
): InviteRow[] {
  return rows.map((r) =>
    r.status === 'pending' && new Date(r.expires_at) <= now
      ? { ...r, status: 'expired' as const }
      : r,
  );
}

export async function GET() {
  try {
    // Platform-admin check first — this endpoint must never be
    // reached by non-platform users.
    await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const now = new Date();
    const { data: rows, error } = await supabase
      .from('platform_customer_invites')
      .select(
        'id, email, status, created_by_platform_admin, created_at, signup_started_at, accepted_at, expires_at',
      )
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/platform/customer-invites] error:', error);
      return NextResponse.json(
        { error: 'Failed to load customer invites' },
        { status: 500 },
      );
    }

    // Persist any expiration we observe so the DB status stays
    // accurate (best-effort; failure must not break the response).
    const expired = (rows ?? []).filter(
      (r) =>
        r.status === 'pending' && new Date(r.expires_at) <= now,
    );
    if (expired.length > 0) {
      await supabase
        .from('platform_customer_invites')
        .update({ status: 'expired' })
        .in(
          'id',
          expired.map((e) => e.id),
        );
    }

    return NextResponse.json({
      invites: normalizeStatus(rows ?? [], now).map(toInvite),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const limit = checkRateLimit(
      `platform:customerInviteCreate:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { email?: unknown; expiresInDays?: unknown }
      | null;

    const rawEmail = body?.email;
    if (typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail.trim())) {
      return NextResponse.json(
        { error: 'A valid email is required' },
        { status: 400 },
      );
    }
    const email = rawEmail.trim().toLowerCase();

    const rawExpiry = body?.expiresInDays;
    let expiresInDays = DEFAULT_EXPIRY_DAYS;
    if (
      typeof rawExpiry === 'number' &&
      Number.isFinite(rawExpiry) &&
      rawExpiry > 0
    ) {
      expiresInDays = Math.min(
        Math.floor(rawExpiry),
        365, // cap at 1 year
      );
    }
    const expiresAt = inviteExpiresAt(expiresInDays);

    // Don't create a duplicate pending invite for the same email.
    const { data: existing } = await supabase
      .from('platform_customer_invites')
      .select('id, status, expires_at')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1);
    if (existing && existing.length > 0) {
      const latest = existing[0];
      if (
        latest.status === 'pending' &&
        new Date(latest.expires_at) > new Date()
      ) {
        return NextResponse.json(
          { error: 'This email already has a pending invitation' },
          { status: 409 },
        );
      }
      if (latest.status === 'accepted') {
        return NextResponse.json(
          { error: 'This email has already accepted an invitation' },
          { status: 409 },
        );
      }
    }

    const { token, hash } = generateInviteToken();

    const { data: row, error } = await supabase
      .from('platform_customer_invites')
      .insert({
        email,
        token_hash: hash,
        status: 'pending',
        created_by_platform_admin: userId,
        expires_at: expiresAt.toISOString(),
      })
      .select(
        'id, email, status, created_by_platform_admin, created_at, signup_started_at, accepted_at, expires_at',
      )
      .single();

    if (error || !row) {
      console.error('[POST /api/platform/customer-invites] insert:', error);
      return NextResponse.json(
        { error: 'Failed to create customer invite' },
        { status: 500 },
      );
    }

    // The complete, shareable link. The raw token is embedded once
    // here and never surfaced on its own.
    const inviteUrl = customerInviteUrl(token, resolvePublicOrigin(request));

    return NextResponse.json(
      {
        invite: toInvite(row),
        inviteUrl,
        expiresInDays,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
