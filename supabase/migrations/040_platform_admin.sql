-- ============================================================
-- 040_platform_admin.sql — Platform administration foundation
--
-- Introduces a platform-admin tier that sits *above* customer
-- accounts. Platform admins are identified by a row in the new
-- `platform_admins` table, NOT by any account role. A platform
-- admin can be a member of a customer account (with any role),
-- but their platform-admin powers are entirely independent of
-- their account membership.
--
-- Three changes:
--
--   1. `platform_admins` — a lookup table keyed on auth.users.id.
--      RLS is locked down: anon and authenticated users cannot read
--      or write it through the Supabase client. All platform-admin
--      authorization is done server-side by calling the
--      `is_platform_admin()` SECURITY DEFINER function.
--
--   2. `accounts.status` — an enum column (`active` | `suspended`)
--      that lets a platform admin disable a customer account.
--      Defaults to `active` for every existing and new row.
--
--   3. `is_platform_admin()` — a SECURITY DEFINER SQL helper that
--      checks the `platform_admins` table for the *caller*
--      (auth.uid()). Usable from any authenticated client, so both
--      the server (`requirePlatformAdmin`) and the client UI
--      (`useIsPlatformAdmin`) can ask "am I a platform admin?"
--
-- SECURITY MODEL (why no platform-admin RLS policies on domain
-- tables):
--
--   Platform routes run with the service-role client AFTER the
--   server-side requirePlatformAdmin() check. They never go through
--   RLS, so giving platform admins extra RLS rows on accounts /
--   profiles / whatsapp_config would only increase the blast radius
--   of ordinary customer-facing routes (which run under the
--   user's RLS and would suddenly let a platform admin read every
--   account). Keeping tenant RLS byte-for-byte unchanged for
--   platform admins guarantees a platform admin cannot accidentally
--   see cross-tenant data in the normal app.
--
-- Bootstrap: to create the first platform admin, run:
--
--   INSERT INTO platform_admins (user_id) VALUES ('<auth-user-uuid>');
--
-- This must be done with the service-role key (e.g. the Supabase
-- SQL editor or the management API) because the table has no
-- self-service RLS.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- TYPES
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status_enum') THEN
    CREATE TYPE account_status_enum AS ENUM ('active', 'suspended');
  END IF;
END $$;

-- ============================================================
-- PLATFORM ADMINS
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lock down the table: no anon or authenticated access. Only
-- service-role (which bypasses RLS) can read or write directly.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- RESTRICTIVE + always-false: blocks the Supabase client roles from
-- every command. The is_platform_admin() helper goes around this via
-- SECURITY DEFINER (function owner privileges bypass RLS).
DROP POLICY IF EXISTS "platform_admins_block_client_access" ON platform_admins;
CREATE POLICY "platform_admins_block_client_access"
  ON platform_admins
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- ============================================================
-- is_platform_admin() — SECURITY DEFINER helper
--
-- Resolves against auth.uid() (the caller), NOT the uid argument.
-- The argument is accepted for a readable call signature
-- (rpc('is_platform_admin', { uid })) but deliberately ignored so a
-- caller cannot probe whether arbitrary user IDs are admins.
-- ============================================================
CREATE OR REPLACE FUNCTION is_platform_admin(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = auth.uid()
  );
$$;

ALTER FUNCTION is_platform_admin(UUID) OWNER TO postgres;

-- Grant execute to authenticated and anon so the server SSR client
-- and the browser client can ask "am I a platform admin?". The
-- function itself resolves the caller — no user-supplied id is
-- trusted. NOTE the argument is intentionally unused (see above).
GRANT EXECUTE ON FUNCTION is_platform_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION is_platform_admin(UUID) TO anon;

-- ============================================================
-- ACCOUNTS.STATUS
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status account_status_enum
  NOT NULL DEFAULT 'active';

-- ============================================================
-- SCHEMA SMOKE TEST
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'accounts.status column was not created by migration 040';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_admins'
      AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION 'platform_admins table was not created by migration 040';
  END IF;

  RAISE NOTICE '040_platform_admin.sql — schema verification passed';
END
$$;