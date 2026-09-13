-- ============================================================
-- 043_customer_invite_lifecycle.sql
-- Follow-up to 042_customer_onboarding: correct the customer
-- invite lifecycle and tighten the signup gate.
--
-- 042 treated "a user row was created" as "invitation accepted",
-- because the BEFORE INSERT gate cannot see the asynchronous email
-- confirmation event. That conflated two distinct moments and meant
-- an abandoned / unverified signup permanently consumed an invite.
--
-- This migration introduces the full lifecycle
--
--     pending → (signup started) → email confirmed → accepted
--
-- implemented with two separate server-side hooks:
--
--   1. enforce_signup_gate() (BEFORE INSERT on auth.users) still
--      decides whether a signup is admissible, but instead of
--      marking the invite `accepted` it now records that signup
--      began (`signup_started_at`) and leaves the invite `pending`
--      until the email is actually confirmed. An abandoned signup
--      therefore does NOT consume the invite: status stays `pending`
--      and a platform admin can re-invite / the invite stays valid.
--
--   2. mark_platform_invite_confirmed() (AFTER UPDATE OF
--      email_confirmed_at on auth.users) flips the matching pending
--      invite to `accepted` only when the invited email is really
--      confirmed.
--
-- The gate is also tightened so a `customer_invite_token` supplied
-- through signup metadata is bound to a specific invited email: a
-- token that resolves to a revoked / expired / already-accepted
-- invite, or whose invited email differs from the signup email, is
-- rejected outright. A token-less signup still works for an
-- approved (pending, unexpired) email, preserving the 042 flow as a
-- fallback.
--
-- Per repo convention this is a NEW migration (042 is treated as
-- already applied); the pre-existing function is replaced, not the
-- file edited.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Track the start of signup as its own point in time.
--    status stays 'pending' until email confirmation; signup_started_at
--    records when the (possibly unverified) signup began. The platform
--    UI surfaces this as "signup in progress".
-- ------------------------------------------------------------------
ALTER TABLE platform_customer_invites
  ADD COLUMN IF NOT EXISTS signup_started_at TIMESTAMPTZ;

-- ------------------------------------------------------------------
-- 1b. Schema-independent SHA-256 helper.
--
-- The gate must hash the invite token presented at signup so it can be
-- matched against the stored token_hash (SHA-256 hex, same value the
-- Node side produces via createHash('sha256').update(t).digest('hex')).
-- pgcrypto's digest() is NOT guaranteed to be visible: projects install
-- pgcrypto into `public`, `extensions`, or any schema, and SECURITY
-- DEFINER triggers run with their own narrow search_path — so an
-- unqualified `digest(...)` raises 42883 ("function does not exist")
-- and kills every token-based signup. This helper locates pgcrypto by
-- its extension owner schema and calls digest() fully qualified.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sha256_hex(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE STRICT
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ns   text;
  v_hash text;
BEGIN
  SELECT n.nspname
    INTO v_ns
    FROM pg_namespace n
    JOIN pg_extension e ON e.extnamespace = n.oid
   WHERE e.extname = 'pgcrypto'
   LIMIT 1;

  IF v_ns IS NULL THEN
    RAISE EXCEPTION 'pgcrypto is required for invite validation (CREATE EXTENSION pgcrypto)';
  END IF;

  EXECUTE format('SELECT encode(%I.digest($1, ''sha256''), ''hex'')', v_ns)
    INTO v_hash
    USING input;

  RETURN v_hash;
END;
$$;

ALTER FUNCTION public.sha256_hex(text) OWNER TO postgres;

-- ------------------------------------------------------------------
-- 2. Rewritten signup gate (replaces the 042 version).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_signup_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email              TEXT;
  v_customer_token     TEXT;
  v_token_hash         TEXT;
  v_invite_id          UUID;
  v_invite_status      TEXT;
  v_invite_expires     TIMESTAMPTZ;
  v_invite_email       TEXT;
BEGIN
  -- Escape hatch for bootstrapping (first platform admin, recovery).
  IF current_setting('app.bypass_signup_gate', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- A user row must always carry an email; reject otherwise to stay
  -- strictly invite-only.
  IF NEW.email IS NULL OR NEW.email = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Public signup is invite-only.';
  END IF;

  v_email := lower(NEW.email);

  -- ------------------------------------------------------------------
  -- Path A: platform customer invite.
  --
  -- Two admissible sub-paths:
  --   A1 (preferred) — signup metadata carries a `customer_invite_token`
  --      (the token embedded in the admin's /signup?customer_invite=<t>
  --      link). Resolve the invite by its hash and require that it is
  --      pending, unexpired, AND its invited email equals the signup
  --      email. Any other outcome (missing, revoked, expired, accepted,
  --      email mismatch) is a hard rejection — this binds a token to
  --      exactly one approved email and refuses to consume one merely
  --      because a signup began.
  --   A2 (fallback) — no token: a pending, unexpired invite for the
  --      signup email admits it (back-compat with 042).
  -- In both cases we record signup_started_at and leave status pending;
  -- only email confirmation (trigger below) accepts the invite.
  -- ------------------------------------------------------------------
  v_customer_token := NULLIF(NEW.raw_user_meta_data->>'customer_invite_token', '');

  IF v_customer_token IS NOT NULL THEN
    v_token_hash := public.sha256_hex(v_customer_token);
    SELECT i.id, i.status::TEXT, i.expires_at, i.email
      INTO v_invite_id, v_invite_status, v_invite_expires, v_invite_email
      FROM platform_customer_invites i
     WHERE i.token_hash = v_token_hash;

    IF v_invite_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'Public signup is invite-only. Please use an invitation link.';
    END IF;
    IF v_invite_status <> 'pending' OR v_invite_expires <= NOW() THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'This invitation is invalid or has expired. Please ask for a new one.';
    END IF;
    IF v_invite_email <> v_email THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'This invitation is for a different email address. Sign up with the invited email.';
    END IF;

    UPDATE platform_customer_invites
       SET signup_started_at = COALESCE(signup_started_at, NOW())
     WHERE id = v_invite_id;

    RETURN NEW;
  END IF;

  -- A2: token-less, email-only fallback.
  IF EXISTS (
    SELECT 1 FROM platform_customer_invites
     WHERE email = v_email
       AND status = 'pending'
       AND expires_at > NOW()
  ) THEN
    -- Defensive housekeeping: flip any expired-but-pending invite for
    -- this email to `expired` so the platform UI reflects reality.
    UPDATE platform_customer_invites
       SET status = 'expired'
     WHERE email = v_email
       AND status = 'pending'
       AND expires_at <= NOW();

    UPDATE platform_customer_invites
       SET signup_started_at = COALESCE(signup_started_at, NOW())
     WHERE email = v_email
       AND status = 'pending'
       AND expires_at > NOW();

    RETURN NEW;
  END IF;

  -- ------------------------------------------------------------------
  -- Path B: account (team) invitation carried through signup data.
  -- Unchanged from 042 — validate the /join/<token> value against
  -- account_invitations so a teammate signing up to join a team is
  -- admitted.
  -- ------------------------------------------------------------------
  IF NULLIF(NEW.raw_user_meta_data->>'invite_token', '') IS NOT NULL THEN
    v_token_hash := public.sha256_hex(NEW.raw_user_meta_data->>'invite_token');
    IF EXISTS (
      SELECT 1 FROM account_invitations
       WHERE token_hash = v_token_hash
         AND accepted_at IS NULL
         AND expires_at > NOW()
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'Public signup is invite-only. Please use an invitation link or contact us.';
END;
$$;

ALTER FUNCTION public.enforce_signup_gate() OWNER TO postgres;

-- ------------------------------------------------------------------
-- 3. Accept the invite on email confirmation.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_platform_invite_confirmed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Fire only on the transition to a non-null email_confirmed_at.
  IF NEW.email_confirmed_at IS NOT NULL
     AND NEW.email_confirmed_at IS DISTINCT FROM OLD.email_confirmed_at
  THEN
    UPDATE platform_customer_invites
       SET status = 'accepted',
           accepted_at = NEW.email_confirmed_at
     WHERE email = lower(NEW.email)
       AND status = 'pending'
       AND expires_at > NOW();
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.mark_platform_invite_confirmed() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.mark_platform_invite_confirmed();
