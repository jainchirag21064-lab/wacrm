// ============================================================
// /api/platform/config/member-limit
//
//   GET  — current per-account member (seat) limit.
//   POST — set it (platform-admin only).
//
// The knob defaults to 3 (migration 045, platform_config) and caps
// the number of NON-OWNER members an account may have. Deactivated
// members keep occupying seats until an owner permanently deletes
// them, so this limit is what forces cleanup of stale users.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { platformAdminClient } from '@/lib/supabase/platform-admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MIN_LIMIT = 0;
const MAX_LIMIT = 1000;

export async function GET() {
  try {
    await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const { data: limit, error } = await supabase.rpc('account_member_limit');
    if (error) {
      console.error('[member-limit] read error:', error);
      return NextResponse.json(
        { error: 'Failed to load member limit' },
        { status: 500 }
      );
    }

    return NextResponse.json({ limit });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requirePlatformAdmin();
    const supabase = platformAdminClient();

    const limit = checkRateLimit(
      `platform:memberLimit:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const raw = (await request.json().catch(() => null)) as {
      limit?: unknown;
    } | null;
    const value = raw?.limit;

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return NextResponse.json(
        { error: "'limit' must be an integer" },
        { status: 400 }
      );
    }
    if (value < MIN_LIMIT || value > MAX_LIMIT) {
      return NextResponse.json(
        {
          error: `'limit' must be between ${MIN_LIMIT} and ${MAX_LIMIT}`,
        },
        { status: 400 }
      );
    }

    const { error } = await supabase.from('platform_config').upsert(
      {
        key: 'account_member_limit',
        // JSONB column: store a JSON *number*, not the string form —
        // account_member_limit() reads it back as `(value #>> '{}')::int`
        // and a string "5" would still cast fine, but a number keeps
        // the config consistent with the '3'::jsonb seed in migration 045.
        value: value,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );

    if (error) {
      console.error('[member-limit] upsert error:', error);
      return NextResponse.json(
        { error: 'Failed to save member limit' },
        { status: 500 }
      );
    }

    return NextResponse.json({ limit: value });
  } catch (err) {
    return toErrorResponse(err);
  }
}
