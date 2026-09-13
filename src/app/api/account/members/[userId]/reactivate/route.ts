// ============================================================
// POST /api/account/members/[userId]/reactivate
//
// Admin+. Restores a deactivated member (migration 045): clears
// `profiles.deactivated_at`, so every RLS policy admits them again
// and their (never-touched) data is back. Reversible counterpart of
// DELETE on /api/account/members/[userId].
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
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberReactivate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { error } = await ctx.supabase.rpc("reactivate_account_member", {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}