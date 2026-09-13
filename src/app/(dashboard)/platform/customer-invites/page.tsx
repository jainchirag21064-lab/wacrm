import { redirect } from 'next/navigation';

import { ForbiddenError } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { PlatformCustomerInvitesClient } from '@/components/platform/customer-invites';

// ============================================================
// /platform/customer-invites
//
// Platform-admin-only: invite/approve customer signups for the
// invite-only onboarding model. Authorization is enforced server-side
// here AND on every /api/platform/customer-invites* route.
// ============================================================

export default async function PlatformCustomerInvitesPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof ForbiddenError && err.status === 403) {
      redirect('/dashboard');
    }
    throw err;
  }

  return <PlatformCustomerInvitesClient />;
}
