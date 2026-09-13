-- ============================================================
-- 044_signup_requests.sql
-- Public "Request Access" workflow.
--
-- An uninvited visitor submits an access request WITHOUT creating
-- an Auth user. A platform admin reviews pending requests and, on
-- approval, generates the existing secure platform customer
-- invitation URL (/signup?customer_invite=<token>). The requester
-- then signs up through that URL exactly like any other invited
-- customer.
--
-- Security invariants (all respected here):
--   * A request NEVER authorizes signup. Only a valid platform
--     customer invitation token (platform_customer_invites) does.
--   * No Auth user is created when a request is submitted.
--   * The referral_code is informational only — it never bypasses
--     invite validation.
--   * platform_customer_invites and account (team) invitations stay
--     fully independent; approval only ever inserts a platform
--     customer invite.
--   * Emails are normalized to lowercase.
--   * At most one PENDING request per normalized email.
--   * The table is RESTRICTIVE-RLS (always false) — end users can
--     neither read nor write it via PostgREST. Submission happens
--     through the server-only POST /api/access-requests endpoint
--     (service-role client, never exposed to the browser); reads and
--     writes for review happen through platform-admin server routes.
--
-- This is a NEW migration: 040–043 are treated as already deployed
-- and are not modified.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. signup_request_status_enum
-- ------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'signup_request_status_enum') THEN
    CREATE TYPE signup_request_status_enum AS ENUM
      ('pending', 'approved', 'rejected', 'converted', 'spam');
  END IF;
END
$$;

-- ------------------------------------------------------------------
-- 2. signup_requests
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signup_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name TEXT NOT NULL,
  -- Lowercased at write time; CHECK enforces it so a raw/unauthorised
  -- write can't bypass normalization.
  email TEXT NOT NULL,
  company_name TEXT,
  message TEXT,
  referral_code TEXT,
  status signup_request_status_enum NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  platform_invite_id UUID REFERENCES platform_customer_invites(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT signup_requests_email_lower CHECK (email = lower(email))
);

-- Generic status + email lookups for the platform review dashboard.
CREATE INDEX IF NOT EXISTS idx_signup_requests_status
  ON signup_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signup_requests_email
  ON signup_requests (email);

-- Partial index backing the "one pending request per email" rule and
-- fast pending-request listing (the platform notification cue).
CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_requests_email_pending
  ON signup_requests (email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_signup_requests_platform_invite
  ON signup_requests (platform_invite_id);

-- ------------------------------------------------------------------
-- 3. RLS: RESTRICTIVE always-false.
-- ------------------------------------------------------------------
-- Mirrors platform_customer_invites. Invoked emails are PII-ish
-- platform data; the end-user client (anon / authenticated) must
-- never enumerate or mutate them. The public POST route writes via
-- the service-role client; platform routes read/write via the
-- service-role client as well. Both bypass RLS legitimately.
ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signup_requests_block_client_access"
  ON signup_requests;
CREATE POLICY "signup_requests_block_client_access"
  ON signup_requests
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- ------------------------------------------------------------------
-- 4. updated_at maintenance
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_signup_request_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.touch_signup_request_updated_at() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_signup_requests_touch_updated_at ON signup_requests;
CREATE TRIGGER trg_signup_requests_touch_updated_at
  BEFORE UPDATE ON signup_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_signup_request_updated_at();

-- ------------------------------------------------------------------
-- 5. Approval idempotency at the DB layer.
-- ------------------------------------------------------------------
-- Guarantees at most ONE pending platform customer invite per email.
-- The existing API route already enforces this in app code; the
-- index makes an approve-vs-approve race impossible and lets an
-- approval that collides surface as a unique_violation (caught by
-- the route and turned into a 409 instead of a second invite).
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_invites_email_pending
  ON platform_customer_invites (email)
  WHERE status = 'pending';

-- ------------------------------------------------------------------
-- 6. Convert the request when its invitation is accepted.
-- ------------------------------------------------------------------
-- The 043 confirmation trigger flips a platform_customer_invite to
-- 'accepted' on email confirmation. When that happens to an invite
-- produced from a signup request (link set on approval), mark the
-- request 'converted' to close the loop: submitted → approved →
-- converted.
CREATE OR REPLACE FUNCTION public.convert_signup_request_on_invite_accept()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'accepted'
     AND OLD.status IS DISTINCT FROM 'accepted'
  THEN
    UPDATE signup_requests
       SET status = 'converted'
     WHERE platform_invite_id = NEW.id
       AND status = 'approved';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.convert_signup_request_on_invite_accept() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_customer_invite_accept_converts_request
  ON platform_customer_invites;
CREATE TRIGGER trg_customer_invite_accept_converts_request
  AFTER UPDATE OF status ON platform_customer_invites
  FOR EACH ROW EXECUTE FUNCTION public.convert_signup_request_on_invite_accept();
