-- ============================================================
-- 041_suspend_rls.sql — make account suspension a real security
-- boundary in the database.
--
-- Migration 040 introduced `accounts.status` ('active' | 'suspended')
-- and the platform-admin tier, but status was advisory: every tenant
-- RLS policy funnels through `is_account_member()`, which only checked
-- membership + role and never looked at the account's status. A
-- suspended account kept full read/write access to every table.
--
-- This migration closes that gap in four places:
--
--   1. `is_account_member()` now joins `accounts` and requires
--      `accounts.status = 'active'`. Because every tenant policy on
--      every account-scoped table calls this helper, one change makes
--      suspension block ALL reads/writes app-wide — with zero edits to
--      the policies themselves. service_role still bypasses RLS, so
--      the webhook, automations engine, and flows runner keep working
--      for suspended accounts (they must — the account is suspended,
--      not deleted, and inbound messages still need handling).
--
--      Consequence for the app: the `accounts_select` policy (also
--      `is_account_member(id)`) now hides a suspended account's row
--      from its own members. A member can no longer resolve their
--      account via the `accounts` table, so the server (getCurrentAccount)
--      and the client (useAuth) need a way to still learn "your account
--      is suspended" — that's the `current_account_status()` RPC below.
--      The profiles own-row SELECT is unaffected (it switches on
--      `auth.uid() = user_id`), so members still resolve their
--      account_id / role and can render the SuspendedScreen.
--
--   2. `current_account_status()` — SECURITY DEFINER helper that
--      returns the caller's own account status even when the accounts
--      row is RLS-hidden. Resolves via the caller's profile, so it can
--      only ever answer "what is MY account status?".
--
--   3. Storage write policies (chat-media 023, flow-media 020) — the
--      account-path branch now also requires an active account, so a
--      suspended account can't upload/replace/delete media. Resources
--      stay readable (the buckets are public so Meta reaches URLs).
--
--   4. Member-management SECURITY DEFINER RPCs (018) — these bypass
--      RLS by design (they self-check the caller's authority), so
--      `is_account_member` alone can't stop a suspended owner from
--      transferring ownership or ejecting teammates. Each function now
--      refuses to run when the caller's account is suspended.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. is_account_member() — suspend-aware
--
-- The only diff from migration 017 is the `JOIN accounts a` + the
-- `a.status = 'active'` predicate.
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
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- ============================================================
-- 2. current_account_status() — suspension probe
--
-- SECURITY DEFINER so it can read the accounts row that RLS now hides
-- for suspended accounts. Scope is hard-wired to the caller's own
-- profile (auth.uid()), so it never answers for another user.
--
-- Returns NULL when the caller has no profile row (identical to
-- `is_account_member`'s implicit "no membership" answer).
-- ============================================================
CREATE OR REPLACE FUNCTION public.current_account_status()
RETURNS account_status_enum
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.status
  FROM accounts a
  JOIN profiles p ON p.account_id = a.id
  WHERE p.user_id = auth.uid()
  LIMIT 1
$$;

ALTER FUNCTION public.current_account_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_account_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_account_status() TO authenticated;

-- ============================================================
-- 3. STORAGE POLICIES — require an active account
--
-- chat-media (023): all three write policies gain the accounts join.
-- ============================================================
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- flow-media (020): both account-scoped and legacy user-scoped paths
-- require an active account. Existing files remain readable because the
-- bucket is public, but suspended users cannot write or delete them.
-- ============================================================
DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
        WHERE p.user_id = auth.uid()
          AND auth.uid()::text = (storage.foldername(name))[1]
      )
    )
  );

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
        WHERE p.user_id = auth.uid()
          AND auth.uid()::text = (storage.foldername(name))[1]
      )
    )
  );

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
        WHERE p.user_id = auth.uid()
          AND auth.uid()::text = (storage.foldername(name))[1]
      )
    )
  );

-- ============================================================
-- 4. MEMBER-MANAGEMENT RPCs — refuse to run for suspended accounts
--
-- These SECURITY DEFINER functions bypass RLS, so the is_account_member
-- change can't govern them. Each gains one check right after the
-- caller's role passes: their account must be active.
-- ============================================================

-- ---- set_member_role ----------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
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
BEGIN
  -- Caller must be authenticated.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Resolve caller's account + role.
  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Caller must be admin+.
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  -- Suspended accounts cannot manage members (migration 041).
  IF (SELECT status FROM accounts WHERE id = v_caller_account_id) = 'suspended' THEN
    RAISE EXCEPTION 'This account has been suspended' USING ERRCODE = '42501';
  END IF;

  -- Can't change own role via this endpoint.
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve target.
  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  -- Target must be in caller's account.
  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Owner role changes go through transfer_account_ownership.
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ---- remove_account_member ----------------------------------
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the new personal account id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
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

  -- Suspended accounts cannot manage members (migration 041).
  IF (SELECT status FROM accounts WHERE id = v_caller_account_id) = 'suspended' THEN
    RAISE EXCEPTION 'This account has been suspended' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
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

  -- Spin up a fresh personal account for the removed user. Mirror
  -- of handle_new_user's logic — keep them whole, just relocated.
  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

-- ---- transfer_account_ownership -----------------------------
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
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

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  -- Suspended accounts cannot manage members (migration 041).
  IF (SELECT status FROM accounts WHERE id = v_caller_account_id) = 'suspended' THEN
    RAISE EXCEPTION 'This account has been suspended' USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_new_owner_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Demote current owner first so the temporary state where the
  -- account has zero owners is never visible — both writes happen
  -- in the same function transaction.
  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid();

  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id;

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

-- ============================================================
-- SCHEMA SMOKE TEST
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'current_account_status'
  ) THEN
    RAISE EXCEPTION 'current_account_status() was not created by migration 041';
  END IF;

  -- The suspension predicate must be baked into is_account_member —
  -- assert on its definition body so a silent revert is caught.
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_functiondef('is_account_member(uuid, account_role_enum)'::regprocedure)
    WHERE pg_get_functiondef LIKE '%a.status = ''active''%'
  ) THEN
    RAISE EXCEPTION 'is_account_member() is missing the accounts.status=active join (migration 041)';
  END IF;

  RAISE NOTICE '041_suspend_rls.sql — schema verification passed';
END
$$;