// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account, PLUS the seat-limit
// config (migration 045):
//   - `memberLimit` — platform-configured cap on non-owner members
//   - `seatUsage`   — non-owner members, INCLUDING deactivated ones
//     (a deactivated member keeps occupying the seat until a
//     permanent delete frees it)
// Any member can call it (the Members tab is shown to admins+, but
// agents/viewers see a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { canManageMembers, isAccountRole } from '@/lib/auth/roles';
import type { AccountMember } from '@/types';

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  deactivated_at: string | null;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    // Deactivated members are still returned (active ones first) so
    // the Members tab can show them for restore / permanent delete.
    const { data, error } = await ctx.supabase
      .from('profiles')
      .select(
        'user_id, full_name, email, avatar_url, account_role, deactivated_at, created_at'
      )
      .eq('account_id', ctx.accountId)
      .order('deactivated_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[GET /api/account/members] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load members' },
        { status: 500 }
      );
    }

    // Effective seat cap for THIS account: a per-account override
    // (accounts.member_limit, migration 046) wins over the global
    // platform default. Purely informational on the client, so any
    // member may read it.
    const { data: memberLimit, error: limitErr } = await ctx.supabase.rpc(
      'account_member_limit',
      { p_account_id: ctx.accountId }
    );
    if (limitErr) {
      console.error('[GET /api/account/members] limit fetch error:', limitErr);
      return NextResponse.json(
        { error: 'Failed to load member limit' },
        { status: 500 }
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      const active = !row.deactivated_at;
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? '',
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          deactivated_at: row.deactivated_at ?? null,
          joined_at: row.created_at,
          status: active ? 'active' : 'deactivated',
        },
      ];
    });

    const seatUsage = members.filter((m) => m.role !== 'owner').length;

    return NextResponse.json({ members, memberLimit, seatUsage });
  } catch (err) {
    return toErrorResponse(err);
  }
}