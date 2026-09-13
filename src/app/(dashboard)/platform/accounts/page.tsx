import { redirect } from 'next/navigation';

import { ForbiddenError } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { PlatformAccountsClient } from '@/components/platform/accounts-table';

// ============================================================
// /platform/accounts
//
// Platform-admin-only: central hub for managing customer accounts.
// Authorization is enforced here server-side (redirect for
// non-admins) AND on every /api/platform/* route
// (requirePlatformAdmin). The UI is a convenience, never a
// security boundary.
// ============================================================

export default async function PlatformAccountsPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    // A signed-out user is handled by middleware (redirect to login).
    // A signed-in non-platform-admin gets a hard redirect to the
    // dashboard — the API routes remain the real enforcement layer.
    if (err instanceof ForbiddenError && err.status === 403) {
      redirect('/dashboard');
    }
    throw err;
  }

  return <PlatformAccountsClient />;
}
