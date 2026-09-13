// Service-role Supabase client for platform-admin server routes.
//
// Same lazy-singleton pattern as src/lib/flows/admin-client.ts.
// Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS — necessary because
// platform admins need cross-account visibility that RLS would
// normally block.
//
// IMPORTANT: This client is server-only. Never import from client
// components. Each call site must verify platform-admin status
// BEFORE using this client.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _adminClient: SupabaseClient | null = null;

export function platformAdminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}
