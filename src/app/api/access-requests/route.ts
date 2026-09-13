// ============================================================
// POST /api/access-requests
//
// Public "Request Access" submission. A visitor who has no platform
// invitation can request access here WITHOUT creating an Auth user.
//
// Security posture:
//   * Submission NEVER authorizes signup — only a valid platform
//     customer invitation token does. This endpoint only records a
//     pending request for a platform admin to review.
//   * No Auth user / no session is created or touched.
//   * Emails are normalized to lowercase and validated.
//   * All fields are trimmed and length-bounded.
//   * Rate-limited per IP and per normalized email.
//   * A generic `{ ok: true }` is returned for success AND duplicate
//     submissions so the endpoint does not reveal whether an email
//     already has a request (or an Auth account).
//   * Writes happen via the server-only service-role client; the
//     service-role key never reaches the browser.
//
// Bot protection: the repository has no configured CAPTCHA / OAuth
// challenge provider, so this route relies on IP+email rate limiting
// plus the DB's one-pending-per-email constraint. If a CAPTCHA
// provider is added later, verify its token here before inserting.
// ============================================================

import { NextResponse } from 'next/server';

import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';
import { validateAccessRequest } from '@/lib/access-requests/validation';

/** Best-effort client IP from proxy headers. Never trusted as an
 *  identity — it only keys an in-memory rate-limit bucket. */
function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'unknown';
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function POST(request: Request) {
  // Rate limit by IP first — cheap and independent of the body.
  const ip = clientIp(request);
  const ipLimit = checkRateLimit(
    `accessRequest:ip:${ip}`,
    RATE_LIMITS.accessRequest,
  );
  if (!ipLimit.success) return rateLimitResponse(ipLimit);

  const raw = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  const parsed = validateAccessRequest(raw);
  if (!parsed.ok) {
    // We still consume an entry of the IP bucket but return the same
    // facade as other failures: a generic failure, no field detail.
    // (Malformed input is a client bug, not an enumeration oracle.)
    return NextResponse.json(
      { ok: false, message: 'Your request could not be processed.' },
      { status: 400 },
    );
  }
  const value = parsed.value;

  // Rate limit per normalized email.
  const emailLimit = checkRateLimit(
    `accessRequest:email:${value.email}`,
    RATE_LIMITS.accessRequestPerEmail,
  );
  if (!emailLimit.success) return rateLimitResponse(emailLimit);

  const supabase = platformAdminClient();
  const { error } = await supabase.from('signup_requests').insert({
    full_name: value.full_name,
    email: value.email,
    company_name: value.company_name,
    message: value.message,
    referral_code: value.referral_code,
    status: 'pending',
  });

  if (error) {
    // 23505 = unique_violation on the one-pending-per-email partial
    // index. A pending request already exists for this email — treat it
    // as success so we never reveal existence.
    if (error.code === '23505') {
      return NextResponse.json({
        ok: true,
        message: 'Your request has been received.',
      });
    }
    if (error.code === '42501' || error.code === 'P0001') {
      // Blocked by RLS / a DB guard — reject generically, no detail.
      return NextResponse.json(
        { ok: false, message: 'Your request could not be processed.' },
        { status: 400 },
      );
    }
    console.error('[POST /api/access-requests] insert error:', error);
    return NextResponse.json(
      { ok: false, message: 'Your request could not be processed.' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: 'Your request has been received.',
  });
}
