import { redirect } from 'next/navigation';

import { ForbiddenError } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { PlatformSettingsClient } from '@/components/platform/settings';

// ============================================================
// /platform/settings
//
// Platform-admin-only: product-wide configuration (e.g. the
// account member limit). Authorization is enforced server-side
// here AND on /api/platform/config/*.
// ============================================================

export default async function PlatformSettingsPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof ForbiddenError && err.status === 403) {
      redirect('/dashboard');
    }
    throw err;
  }

  return <PlatformSettingsClient />;
}
