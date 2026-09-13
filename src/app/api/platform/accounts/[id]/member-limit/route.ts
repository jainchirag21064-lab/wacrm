// ============================================================
// POST /api/platform/accounts/[id]/member-limit
//
// Platform-admin-only. Sets or clears the per-account member cap
// (accounts.member_limit, migration 046).
//
//   { "limit": 10 }   → override: cap THIS account at 10 members
//   { "limit": null } → clear the override: fall back to the
//                       platform default (platform_config)
//
// The override is enforced server-side by redeem_invitation() via
// account_member_limit(account_id); the owner-facing Members tab
// also shows the account's effective cap.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';

const MAX_LIMIT = 1000;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface Body {
  limit?: number | null;
}

export async function POST(request: Request, { params }: RouteContext) {
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

    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // `limit` omitted or NaN → treat as clear (explicit null is also
    // cleared); otherwise it must be a whole number in [0, MAX_LIMIT].
    const limit = body.limit ?? null;
    if (limit !== null) {
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 0 ||
        limit > MAX_LIMIT
      ) {
        return NextResponse.json(
          {
            error: `Member limit must be an integer between 0 and ${MAX_LIMIT}`,
          },
          { status: 400 }
        );
      }
    }

    const { data: account, error: loadErr } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (loadErr) {
      console.error('[platform accounts member-limit] load error:', loadErr);
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
      .update({ member_limit: limit })
      .eq('id', id);

    if (error) {
      console.error('[platform accounts member-limit] update error:', error);
      return NextResponse.json(
        { error: 'Failed to update member limit' },
        { status: 500 }
      );
    }

    return NextResponse.json({ id, member_limit: limit });
  } catch (err) {
    return toErrorResponse(err);
  }
}
