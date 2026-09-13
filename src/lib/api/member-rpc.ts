// ============================================================
// Shared SQLSTATE → HTTP mapping for the member-management RPCs
// (migrations 018/041/045: set_member_role, deactivate_account_member,
// reactivate_account_member, delete_account_member).
//
//   - 42501 (insufficient_privilege) → 403, the RPC's message
//   - 22023 (invalid_parameter_value)  → 400, the RPC's message
//   - anything else → 500 with a generic body
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

export function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[member RPC] unexpected error:", err);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}