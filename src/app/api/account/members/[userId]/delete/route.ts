// ============================================================
// POST /api/account/members/[userId]/delete
//
// OWNER-ONLY. Permanently deletes a member (migration 045):
// auth user + profile + any personal accounts they own are purged.
// Irreversible — this is the only way to free a seat that a
// deactivated member still occupies.
//
// Authorization is enforced in the DB RPC (caller role must be
// 'owner'); this route only forwards and maps SQLSTATEs.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { rpcErrorToResponse } from "@/lib/api/member-rpc";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `owner:memberDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { error } = await ctx.supabase.rpc("delete_account_member", {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}