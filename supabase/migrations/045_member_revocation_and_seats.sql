-- ============================================================
-- 045_member_revocation_and_seats.sql
--
-- Two product decisions, one migration:
--
--   1. Member removal becomes a two-action model.
--
--      "Remove member" (deactivate) revokes the teammate's access
--      INSTANTLY and reversibly: their profile gains
--      `deactivated_at`, `is_account_member()` stops admitting
--      them, and every account-scoped RLS policy denies them app-
--      wide (mirrors how 041 suspended whole accounts, but at the
--      per-person level). Their auth login survives and an
--      owner/admin can restore them later.
--
--      "Delete permanently" (owner-only) is the hard delete: the
--      member is removed from the account AND their auth user,
--      profile and any personal accounts they own are purged.
--      Irreversible — reserved for stale users.
--
--   2. Seat limit per account, configured by platform admins.
--
--      `platform_config.account_member_limit` (default 3) caps the
--      number of NON-OWNER members an account may have. Existing
--      `remove_account_member()` (the old "kick them to their own
--      fresh personal account" behaviour) is dropped — that gave a
--      removed member a free usable workspace, which defeats the
--      product. Seat accounting deliberately INCLUDES deactivated
--      members: a stale (deactivated) member keeps occupying a
--      seat until an owner permanently deletes them, which is the
--      only way to free it. `redeem_invitation` enforces the cap
--      at the DB layer (single admission path for new members).
--
--      Config semantics: value is JSONB so the pattern extends to
--      future platform knobs. 0 means "no seats allowed"; to
--      disable the cap entirely set it to a very high value.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. profiles.deactivated_at
-- ------------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- ------------------------------------------------------------------
-- 2. is_account_member() — deactivation-aware
--
-- Only diff from 041 (which added the accounts-status join) is the
-- `AND p.deactivated_at IS NULL` predicate. Every account-scoped RLS
-- policy funnels through this helper, so flipping a member off costs
-- exactly one row update and their app-wide access dies instantly.
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND a.status = 'active'
      AND p.deactivated_at IS NULL
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  )
$$;

-- ------------------------------------------------------------------
-- 3. Seat-limit config + helpers
--
-- platform_config is created with RLS ENABLED but NO policies, i.e.
-- fully locked: in Supabase, tables in `public` get default ALL grants
-- to anon/authenticated, so without RLS any signed-in client could hit
-- `/rest/v1/platform_config` and rewrite the seat limit directly. This
-- table is only ever meant to be reached via the SECURITY DEFINER
-- helpers (server-side, run as postgres) and the platform-admin routes
-- (service-role client) — both bypass RLS, so zero policies is exactly
-- right.
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_config ENABLE ROW LEVEL SECURITY;

-- Seed the default (3 seats). ON CONFLICT DO NOTHING keeps a value
-- a platform admin already changed when the migration is re-run.
INSERT INTO platform_config (key, value)
VALUES ('account_member_limit', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.account_member_limit()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(0, COALESCE(
    -- `value #>> '{}'` renders the JSONB scalar as plain text for both
    -- a JSON number (3) and a JSON string ("3"), so admins setting the
    -- value either way (API route vs SQL editor) can't break the cast.
    (SELECT ((value #>> '{}')::int) FROM platform_config WHERE key = 'account_member_limit'),
    3
  ))
$$;

ALTER FUNCTION public.account_member_limit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_member_limit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_member_limit() TO authenticated;

-- Number of NON-OWNER members (active + deactivated) on an account.
-- The owner is the subscription itself, not a seat. Deactivated
-- members intentionally keep occupying their seat until a permanent
-- delete frees it.
CREATE OR REPLACE FUNCTION public.account_member_usage(
  p_account_id UUID
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::int
  FROM profiles
  WHERE account_id = p_account_id
    AND account_role IS DISTINCT FROM 'owner'
$$;

ALTER FUNCTION public.account_member_usage(UUID) OWNER TO postgres;

-- ------------------------------------------------------------------
-- 4. Member management RPCs (replace remove_account_member)
--
-- The old remove_account_member spun up a FRESH personal account for
-- the removed member (they walked away owning a usable workspace).
-- That behaviour is gone: removal means deactivation (reversible,
-- locked out), and a separate owner-only RPC does permanent delete.
-- ============================================================
DROP FUNCTION IF EXISTS public.remove_account_member(UUID);

-- ---- deactivate_account_member -------------------------------
-- Admin+. Locked out instantly and reversibly; seat stays occupied.
CREATE OR REPLACE FUNCTION public.deactivate_account_member(
  p_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_deactivated_at TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF (SELECT status FROM accounts WHERE id = v_caller_account_id) = 'suspended' THEN
    RAISE EXCEPTION 'This account has been suspended' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, deactivated_at
  INTO v_target_account_id, v_target_role, v_target_deactivated_at
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Target user is already deactivated' USING ERRCODE = '22023';
  END IF;

  -- Revoke access: the single row change every RLS policy now reads.
  UPDATE profiles
  SET deactivated_at = NOW()
  WHERE user_id = p_user_id;

  -- Drop their presence row so they stop showing online to teammates.
  DELETE FROM member_presence WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.deactivate_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.deactivate_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_account_member(UUID) TO authenticated;

-- ---- reactivate_account_member -------------------------------
-- Admin+. Restores access; the member's data was never touched.
CREATE OR REPLACE FUNCTION public.reactivate_account_member(
  p_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_deactivated_at TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF (SELECT status FROM accounts WHERE id = v_caller_account_id) = 'suspended' THEN
    RAISE EXCEPTION 'This account has been suspended' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, deactivated_at
  INTO v_target_account_id, v_target_deactivated_at
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_deactivated_at IS NULL THEN
    RAISE EXCEPTION 'Target user is not deactivated' USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET deactivated_at = NULL
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.reactivate_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reactivate_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reactivate_account_member(UUID) TO authenticated;

-- ---- delete_account_member -----------------------------------
-- OWNER-ONLY. Permanent: auth user + profile + any personal
-- accounts the member owns are purged. The account's own data is
-- owned by account_id, so the team loses nothing but the person.
--
-- DANGER — the legacy `user_id` column on the account domain tables
-- (contacts, conversations, broadcasts, flows, automations, message
-- templates, quick_replies, …) is still written by the app as the
-- row's "creator", and its REFERENCES auth.users(id) ON DELETE
-- CASCADE would silently wipe the TEAM's rows this member created
-- the moment the auth row goes. So before the auth delete we
-- reassign those rows to the deleting owner (account_id unchanged,
-- still tenanted to the same account).
CREATE OR REPLACE FUNCTION public.delete_account_member(
  p_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_row record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Deliberately owner-only: permanent deletion is the most
  -- destructive action an account owner can take.
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'This action requires the account owner'
      USING ERRCODE = '42501';
  END IF;

  IF (SELECT status FROM accounts WHERE id = v_caller_account_id) = 'suspended' THEN
    RAISE EXCEPTION 'This account has been suspended' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot delete yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot delete the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- accounts.owner_user_id is ON DELETE RESTRICT, so any personal
  -- accounts the target owns must go before the auth row. Their
  -- account-scoped rows cascade with the account. In the redeeming
  -- flow the target has none (their personal account was deleted on
  -- joining), so this is purely defensive.
  DELETE FROM accounts WHERE owner_user_id = p_user_id;

  -- Reassign the team's account-scoped rows the target created to the
  -- deleting owner. Discovered from the catalog (any table with a
  -- `user_id` FK to auth.users AND an `account_id`) so future tables
  -- are covered automatically. Rows in the target's own (now-deleted)
  -- personal accounts are out of scope — they died with the account.
  FOR v_row IN
    SELECT tc.table_name AS tbl
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
     AND kcu.table_name = tc.table_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = tc.constraint_schema
     AND ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND kcu.column_name = 'user_id'
      AND ccu.table_schema = 'auth'
      AND ccu.table_name = 'users'
      AND ccu.column_name = 'id'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name  = tc.table_name
          AND column_name = 'account_id'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'UPDATE %I SET user_id = $2 WHERE user_id = $1 AND account_id = $3',
        v_row.tbl
      ) USING p_user_id, auth.uid(), v_target_account_id;
    EXCEPTION
      WHEN unique_violation THEN
        -- e.g. whatsapp_config UNIQUE(user_id): the owner already has
        -- a row in this account, so the target's row is a redundant
        -- duplicate for the account — drop it rather than abort the
        -- entire member delete.
        EXECUTE format(
          'DELETE FROM %I WHERE user_id = $1 AND account_id = $2',
          v_row.tbl
        ) USING p_user_id, v_target_account_id;
    END;
  END LOOP;

  -- The auth row is now safe to remove: profiles, notifications,
  -- member_presence and platform_admins cascade away; every other
  -- reference (assigned agents, created_bys, actor ids) is SET NULL.
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;

ALTER FUNCTION public.delete_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_account_member(UUID) TO authenticated;

-- ------------------------------------------------------------------
-- 5. redeem_invitation — deactivation + seat-limit guards
--
-- Same body as migration 019 with two additions:
--   1. A deactivated caller cannot redeem (prevents "escaping" a
--      revocation by joining another team — revocation follows the
--      person until an admin restores them).
--   2. Seat cap: joining when the team is at its member limit is
--      refused with SQLSTATE 22023 (mapped to 400 by the route) and
--      a message that tells the owner exactly what to do.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_deactivated_at TIMESTAMPTZ;
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- A revoked (deactivated) member cannot redeem into another team:
  -- revocation follows the person until an admin restores them.
  SELECT deactivated_at INTO v_caller_deactivated_at
  FROM profiles WHERE user_id = v_caller_id;
  IF v_caller_deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Your access has been revoked'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Seat cap: refuse joining a team that has no spare seat.
  -- Deactivated members keep occupying seats, so the owner must
  -- permanently delete stale members to free one.
  IF account_member_usage(v_inv.account_id) >= account_member_limit() THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = format(
        'This team has reached its member limit (%s seats). An owner must permanently remove a member to free a seat.',
        account_member_limit()
      );
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior join). Any other state means they're either:
  --   - a member of another shared account (joining would silently
  --     orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;