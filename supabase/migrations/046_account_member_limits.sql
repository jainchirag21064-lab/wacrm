-- ============================================================
-- 046_account_member_limits.sql
--
-- Granular, per-account member limits.
--
-- 045 introduced a single GLOBAL seat cap (platform_config, default
-- 3) applied to every account. That's too blunt for prod: one
-- customer may want 10 members while another stays at 3. This
-- migration adds a per-account override:
--
--   accounts.member_limit INT NULL (0..1000)
--
--     NULL  → fall back to the global default (platform_config)
--     0..N  → hard cap for THIS account
--
--   account_member_limit(p_account_id UUID DEFAULT NULL)
--
--     with an account id → override, else the global default, else 3
--     without one        → the global default (back-compat)
--
-- redeem_invitation() passes the JOINING team's id so the per-account
-- cap (not the caller's personal-account default) is enforced at the
-- single admission path.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Per-account override column
-- ------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS member_limit INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_member_limit_range'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_member_limit_range
      CHECK (member_limit IS NULL OR member_limit BETWEEN 0 AND 1000);
  END IF;
END $$;

-- ------------------------------------------------------------------
-- 2. Account-aware limit helper (replaces the 045 global-only version)
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.account_member_limit();

CREATE OR REPLACE FUNCTION public.account_member_limit(
  p_account_id UUID DEFAULT NULL
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(0, COALESCE(
    -- Per-account override first; NULL means "use the default".
    (SELECT a.member_limit FROM accounts a WHERE a.id = p_account_id),
    -- Global default from platform_config. `value #>> '{}'` renders
    -- both a JSON number (3) and a JSON string ("3") as plain text,
    -- so either storage form casts cleanly.
    (SELECT ((value #>> '{}')::int) FROM platform_config WHERE key = 'account_member_limit'),
    3
  ))
$$;

ALTER FUNCTION public.account_member_limit(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_member_limit(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_member_limit(UUID) TO authenticated;

-- ------------------------------------------------------------------
-- 3. redeem_invitation — enforce the JOINING team's cap
--
-- Same body as 045 with the seat check switched from the global
-- `account_member_limit()` to `account_member_limit(v_inv.account_id)`.
-- The caller is still in their own personal account at this point, so
-- auth.uid()'s account would read the wrong override.
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

  -- Seat cap for the team being joined. Deactivated members keep
  -- occupying seats, so the owner must permanently delete stale
  -- members to free one.
  IF account_member_usage(v_inv.account_id) >= account_member_limit(v_inv.account_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = format(
        'This team has reached its member limit (%s seats). An owner must permanently remove a member to free a seat.',
        account_member_limit(v_inv.account_id)
      );
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

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

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;