// ============================================================
// Access-request input validation + sanitization (shared).
//
// Pure, dependency-free. Used by the public POST /api/access-requests
// route. Splitting it out keeps the route thin and lets the validation
// rules be unit-tested in isolation.
// ============================================================

export const ACCESS_REQUEST_LIMITS = {
  full_name_max: 120,
  email_max: 254,
  company_name_max: 120,
  message_max: 2000,
  referral_code_max: 100,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ValidAccessRequest {
  full_name: string;
  email: string;
  company_name: string | null;
  message: string | null;
  referral_code: string | null;
}

export type AccessRequestParseResult =
  | { ok: true; value: ValidAccessRequest }
  | { ok: false };

function truncateOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Validate + normalize an access-request payload.
 *
 * Always lowercases the email; trims every field; clamps optional
 * strings to their limits; and rejects missing/invalid required field
 * + malformed emails. Referral code is informational only — it never
 * influences authorization anywhere downstream.
 */
export function validateAccessRequest(
  input: Record<string, unknown> | null | undefined,
): AccessRequestParseResult {
  if (!input || typeof input !== 'object') return { ok: false };

  const fullName = truncateOrNull(input.full_name, ACCESS_REQUEST_LIMITS.full_name_max);
  if (!fullName) return { ok: false };

  const rawEmail = typeof input.email === 'string' ? input.email.trim() : '';
  if (rawEmail.length > ACCESS_REQUEST_LIMITS.email_max) return { ok: false };
  const email = rawEmail.toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false };

  const companyName = truncateOrNull(
    input.company_name,
    ACCESS_REQUEST_LIMITS.company_name_max,
  );
  const message = truncateOrNull(input.message, ACCESS_REQUEST_LIMITS.message_max);
  const referralCode = truncateOrNull(
    input.referral_code,
    ACCESS_REQUEST_LIMITS.referral_code_max,
  );

  return {
    ok: true,
    value: {
      full_name: fullName,
      email,
      company_name: companyName,
      message: message,
      referral_code: referralCode,
    },
  };
}
