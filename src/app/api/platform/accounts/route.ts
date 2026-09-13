// ============================================================
// GET /api/platform/accounts
//
// Platform-admin-only. Returns the full customer account list
// with owner info, member count, and WhatsApp config status.
//
// Authorization is enforced server-side via requirePlatformAdmin(),
// which is independent of profiles.account_role. The service-role
// client is used only after that check passes — never expose it to
// the client.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';
import type { PlatformAccountListItem } from '@/types';

export async function GET() {
  try {
    await requirePlatformAdmin();

    const supabase = platformAdminClient();

    // Load accounts with owner profile (auth.users has no name/email —
    // that lives on the profiles row) and member counts.
    const { data: accounts, error } = await supabase
      .from('accounts')
      .select('id, name, status, created_at, owner_user_id, member_limit')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/platform/accounts] load error:', error);
      return NextResponse.json(
        { error: 'Failed to load accounts' },
        { status: 500 }
      );
    }

    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ accounts: [] });
    }

    const ownerIds = accounts.map((a) => a.owner_user_id);

    // Owner profiles (name + email).
    const { data: owners, error: ownerErr } = await supabase
      .from('profiles')
      .select('user_id, full_name, email')
      .in('user_id', ownerIds);

    if (ownerErr) {
      console.error('[GET /api/platform/accounts] owner load error:', ownerErr);
      return NextResponse.json(
        { error: 'Failed to load owner profiles' },
        { status: 500 }
      );
    }

    const ownerByUserId = new Map((owners ?? []).map((o) => [o.user_id, o]));

    // Member counts per account.
    const { data: memberships, error: memberErr } = await supabase
      .from('profiles')
      .select('account_id')
      .in(
        'account_id',
        accounts.map((a) => a.id)
      );

    if (memberErr) {
      console.error(
        '[GET /api/platform/accounts] member load error:',
        memberErr
      );
      return NextResponse.json(
        { error: 'Failed to load member counts' },
        { status: 500 }
      );
    }

    const memberCountByAccount = new Map<string, number>();
    for (const m of memberships ?? []) {
      memberCountByAccount.set(
        m.account_id,
        (memberCountByAccount.get(m.account_id) ?? 0) + 1
      );
    }

    // WhatsApp config status per account (one row per account).
    const { data: whatsappRows, error: whatsappErr } = await supabase
      .from('whatsapp_config')
      .select('account_id')
      .in(
        'account_id',
        accounts.map((a) => a.id)
      );

    if (whatsappErr) {
      console.error(
        '[GET /api/platform/accounts] whatsapp load error:',
        whatsappErr
      );
      return NextResponse.json(
        { error: 'Failed to load WhatsApp config status' },
        { status: 500 }
      );
    }

    const whatsappConfiguredByAccount = new Set(
      (whatsappRows ?? []).map((w) => w.account_id)
    );

    // Global default limit (used when an account has no override).
    const { data: defaultMemberLimit, error: defaultErr } = await supabase.rpc(
      'account_member_limit'
    );
    if (defaultErr) {
      console.error(
        '[GET /api/platform/accounts] default limit fetch error:',
        defaultErr
      );
      return NextResponse.json(
        { error: 'Failed to load default member limit' },
        { status: 500 }
      );
    }

    const result: PlatformAccountListItem[] = accounts.map((a) => {
      const owner = ownerByUserId.get(a.owner_user_id);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        created_at: a.created_at,
        owner_name: owner?.full_name ?? 'Unknown',
        owner_email: owner?.email ?? '',
        member_count: memberCountByAccount.get(a.id) ?? 0,
        member_limit: a.member_limit ?? null,
        whatsapp_configured: whatsappConfiguredByAccount.has(a.id),
      };
    });

    return NextResponse.json({
      accounts: result,
      default_member_limit: defaultMemberLimit ?? 3,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
