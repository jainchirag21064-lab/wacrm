-- ============================================================
-- 042_customer_onboarding.sql
-- PHASE 2: Invite-only customer onboarding.
--
-- Preface: an invite-only model replaced unrestricted public
-- signup. Two independent invite surfaces coexist; BOTH are
-- allowed through the signup gate and both are preserved:
--
--   1. PLATFORM CUSTOMER INVITES (new, this migration) — a
--      platform admin approves an email; that person may register
--      a customer account. This is the "customer signup-request /
--      approval" model.
--
--   2. ACCOUNT (TEAM) INVITATIONS (existing, account_invitations,
--      migration 019) — a customer-account owner/admin invites a
--      teammate via a shareable /join/<token> link. The teammate
--      signs up through /signup?invite=<token> and joins the
--      account. This is untouched; only the signup gate now needs
--      to *recognize* the invite token so it doesn't reject the
--      teammate.
--
-- The signup gate is a BEFORE INSERT trigger on auth.users — the
-- "Auth Before User Created" hook implemented in Postgres. It is
-- the single, central, server-side enforcement point. No client
-- validation is relied upon anywhere.
--
--   /signup                            → allowed iff email has a
--                                        pending platform invite OR
--                                        raw_user_meta_data carries a
--                                        valid account token_hash.
--   direct supabase.auth.signUp()      → same gate, so a raw client
--                                        cannot bypass it.
--
-- Escape hatch: bootstrap roles (creating the very first platform
-- admin, restoring a locked-out owner) can set the session GUC
-- `app.bypass_signup_gate` to 'true' in the SQL editor / service
-- role context. Documented; not exposed to end users.
--
-- Invite token hashing matches the app's Node-side SHA-256 hex
-- (src/lib/auth/invitations.ts uses
-- createHash('sha256').update(t).digest('hex'); this file uses the
-- equivalent sha256_hex helper below, which calls pgcrypto's digest()
-- fully qualified so it works regardless of which schema the project
-- installed pgcrypto into). Both are the hex
-- SHA-256 of the raw UTF-8 token.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. platform_customer_invites
-- ============================================================
-- Status lifecycle: pending → accepted | revoked. `expired` is a
-- derivable state (expires_at < now() while still pending) but kept
-- as an explicit status value for the platform UI; the gate treats a
-- pending-but-past-expiry invite as invalid and, when it observes
-- one, flips it to `expired` so the UI reflects reality.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'customer_invite_status_enum') THEN
    CREATE TYPE customer_invite_status_enum AS ENUM ('pending', 'accepted', 'revoked', 'expired');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS platform_customer_invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Lowercased at write time so the signup gate matches case-insensitively.
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status customer_invite_status_enum NOT NULL DEFAULT 'pending',
  created_by_platform_admin UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_customer_invites_email_lower CHECK (email = lower(email))
);

-- Lookups from the signup gate and the platform list are by email and
-- status; this index carries both.
CREATE INDEX IF NOT EXISTS idx_customer_invites_email_status
  ON platform_customer_invites (email, status);

CREATE INDEX IF NOT EXISTS idx_customer_invites_status_created
  ON platform_customer_invites (status, created_at DESC);

-- RLS: RESTRICTIVE + always-false, mirroring platform_admins. Invited
-- emails are PII-ish platform data; the end-user client (anon /
-- authenticated) must never be able to enumerate them via PostgREST.
-- Platform routes read/write through the service-role client (which
-- bypasses RLS), and the signup gate runs SECURITY DEFINER (also
-- bypasses RLS), so neither legitimate path is affected.
ALTER TABLE platform_customer_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_invites_block_client_access"
  ON platform_customer_invites;
CREATE POLICY "customer_invites_block_client_access"
  ON platform_customer_invites
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- ------------------------------------------------------------------
-- 1b. Schema-independent SHA-256 helper.
--
-- The signup gate must hash invite tokens presented at signup so they
-- can be matched against the stored token_hash (SHA-256 hex). pgcrypto's
-- digest() is not guaranteed to be visible from a SECURITY DEFINER
-- trigger: projects install pgcrypto into `public`, `extensions`, or any
-- schema, and the trigger's narrow search_path makes an unqualified call
-- raise 42883 ("function does not exist"). This helper locates pgcrypto
-- by its extension owner schema and calls digest() fully qualified.
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
-- 2. Signup gate: BEFORE INSERT on auth.users
-- ------------------------------------------------------------------
-- Fires for every new auth.users row and decides whether the signup
-- is admissible. Marking the invite accepted here (not deferred to
-- email confirmation) is a deliberate simplification: the trigger
-- cannot observe the async email-confirmation event, so "accepted"
-- means "a user was created from this invite." A would-be customer
-- who abandons verification can simply be re-invited.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_signup_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email TEXT;
  v_invite_token TEXT;
  v_token_hash TEXT;
BEGIN
  -- Escape hatch for bootstrapping (first platform admin, recovery).
  IF current_setting('app.bypass_signup_gate', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- A user row must always carry an email; if not, reject to stay
  -- strictly invite-only.
  IF NEW.email IS NULL OR NEW.email = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Public signup is invite-only.';
  END IF;

  v_email := lower(NEW.email);

  -- Path A: platform customer invite for this email.
  -- A pending, un-expired platform invite admits the signup.
  IF EXISTS (
    SELECT 1 FROM platform_customer_invites
    WHERE email = v_email
      AND status = 'pending'
      AND expires_at > NOW()
  ) THEN
    -- Flip any expired-but-pending invite for this email to `expired`
    -- (defensive housekeeping; normally the gate would find none).
    UPDATE platform_customer_invites
       SET status = 'expired'
     WHERE email = v_email
       AND status = 'pending'
       AND expires_at <= NOW();

    -- Mark this invitation accepted with the new user's id.
    UPDATE platform_customer_invites
       SET status = 'accepted',
           accepted_at = NOW()
     WHERE email = v_email
       AND status = 'pending'
       AND expires_at > NOW();

    RETURN NEW;
  END IF;

  -- Path B: account (team) invitation carried through signup data.
  -- The signup page passes the /join/<token> value in the `data`
  -- payload; we validate its hash against account_invitations so a
  -- teammate signing up to join a team is admitted.
  v_invite_token := NULLIF(NEW.raw_user_meta_data->>'invite_token', '');
  IF v_invite_token IS NOT NULL THEN
    v_token_hash := public.sha256_hex(v_invite_token);
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

DROP TRIGGER IF EXISTS on_auth_user_signup_gate ON auth.users;
CREATE TRIGGER on_auth_user_signup_gate
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_signup_gate();
