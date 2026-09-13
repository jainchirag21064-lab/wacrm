// ============================================================
// Server-side platform-admin context — for routes that need
// platform-level access (not account-level).
//
// IMPORTANT: like account.ts, this module is server-only. It
// imports the Supabase SSR client (`@/lib/supabase/server`),
// which reads `next/headers` cookies.
//
// Platform-admin authorization is completely independent of
// profiles.account_role. A user can be a viewer in their own
// account and still be a platform admin, or vice versa.
// ============================================================

import { createClient } from '@/lib/supabase/server';
import { UnauthorizedError, ForbiddenError } from './account';

export interface PlatformAdminContext {
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
}

/**
 * Verify the authenticated user is a platform admin.
 *
 * Uses the SSR client (user-scoped, RLS active). The
 * `platform_admins` table has restrictive RLS that blocks all
 * authenticated reads, so we use a SECURITY DEFINER helper
 * `is_platform_admin(uid)` that bypasses the policy.
 *
 * Throws `UnauthorizedError` if there's no session.
 * Throws `ForbiddenError` if the user is not a platform admin.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  // Call the SECURITY DEFINER helper — it reads platform_admins
  // with the function owner's privileges, bypassing the restrictive
  // RLS policy that blocks direct authenticated reads. This resolving
  // to an error usually means migration 040 hasn't been applied to
  // the connected Supabase yet (or PostgREST's schema cache is stale),
  // so the message below is written to be actionable for an operator.
  const { data: isAdmin, error } = await supabase.rpc('is_platform_admin', {
    uid: user.id,
  });

  if (error) {
    console.error(
      '[requirePlatformAdmin] rpc error — is migration 040 applied?',
      error.message ?? error,
    );
    throw new ForbiddenError('Could not verify platform admin status');
  }

  if (!isAdmin) {
    throw new ForbiddenError('Platform admin access required');
  }

  return { userId: user.id };
}
