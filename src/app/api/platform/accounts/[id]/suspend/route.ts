// ============================================================
// POST /api/platform/accounts/[id]/suspend
// POST /api/platform/accounts/[id]/reactivate
//
// Platform-admin-only. Sets accounts.status to 'suspended' or
// 'active'.
//
// Guard: a platform admin cannot suspend their OWN account. The
// platform admin's platform-admin powers come from the
// platform_admins table, not from any account — but their personal
// account (like any other) would be blocked from the dashboard if
// suspended. Suspending your own account locks you out with no
// recovery path, so we refuse it.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function setStatus(accountId: string, status: 'active' | 'suspended') {
  const { userId } = await requirePlatformAdmin();
  const supabase = platformAdminClient();

  if (!accountId) {
    return NextResponse.json({ error: 'Missing account id' }, { status: 400 });
  }

  // Load the target account to guard against self-suspension.
  const { data: account, error: loadErr } = await supabase
    .from('accounts')
    .select('id, owner_user_id')
    .eq('id', accountId)
    .maybeSingle();

  if (loadErr) {
    console.error('[platform accounts status] load error:', loadErr);
    return NextResponse.json(
      { error: 'Failed to load account' },
      { status: 500 }
    );
  }
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  // Prevent a platform admin from suspending their own account.
  if (status === 'suspended') {
    // Check whether the caller is a member of this account (which
    // would mean suspending their own working account).
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (profileErr) {
      console.error(
        '[platform accounts status] profile check error:',
        profileErr
      );
      return NextResponse.json(
        { error: 'Failed to verify caller membership' },
        { status: 500 }
      );
    }
    if (profile) {
      return NextResponse.json(
        { error: 'You cannot suspend your own account' },
        { status: 409 }
      );
    }
  }

  const { error } = await supabase
    .from('accounts')
    .update({ status })
    .eq('id', accountId);

  if (error) {
    console.error('[platform accounts status] update error:', error);
    return NextResponse.json(
      { error: 'Failed to update account status' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    id: accountId,
    status,
  });
}

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    return await setStatus(id, 'suspended');
  } catch (err) {
    return toErrorResponse(err);
  }
}
