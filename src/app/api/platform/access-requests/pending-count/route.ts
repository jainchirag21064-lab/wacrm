// ============================================================
// GET /api/platform/access-requests/pending-count
//
// Platform-admin-only. Returns the count of PENDING access requests,
// used to surface a badge on the platform sidebar ("Request Access"
// queue). Enforced server-side via requirePlatformAdmin(); this is a
// convenience counter, never a security boundary.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';

export async function GET() {
  try {
    await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const { count, error } = await supabase
      .from('signup_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    if (error) {
      console.error('[GET pending-count] error:', error);
      return NextResponse.json({ error: 'Failed to count requests' }, { status: 500 });
    }

    return NextResponse.json({ count: count ?? 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
