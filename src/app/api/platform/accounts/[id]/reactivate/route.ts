// ============================================================
// POST /api/platform/accounts/[id]/reactivate
//
// Platform-admin-only. Re-sets accounts.status to 'active'.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requirePlatformAdmin();
    const supabase = platformAdminClient();

    if (!id) {
      return NextResponse.json(
        { error: 'Missing account id' },
        { status: 400 }
      );
    }

    const { data: account, error: loadErr } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (loadErr) {
      console.error('[platform accounts reactivate] load error:', loadErr);
      return NextResponse.json(
        { error: 'Failed to load account' },
        { status: 500 }
      );
    }
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('accounts')
      .update({ status: 'active' })
      .eq('id', id);

    if (error) {
      console.error('[platform accounts reactivate] update error:', error);
      return NextResponse.json(
        { error: 'Failed to reactivate account' },
        { status: 500 }
      );
    }

    return NextResponse.json({ id, status: 'active' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
