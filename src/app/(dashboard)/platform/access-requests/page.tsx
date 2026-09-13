import { redirect } from 'next/navigation';

import { ForbiddenError } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { PlatformAccessRequestsClient } from '@/components/platform/access-requests';

// ============================================================
// /platform/access-requests
//
// Platform-admin-only: review public "Request Access" submissions.
// Approving generates a secure platform customer invitation URL that
// is copied to the requester. Authorization is enforced server-side
// here AND on every /api/platform/access-requests* route.
// ============================================================

export default async function PlatformAccessRequestsPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof ForbiddenError && err.status === 403) {
      redirect('/dashboard');
    }
    throw err;
  }

  return <PlatformAccessRequestsClient />;
}
