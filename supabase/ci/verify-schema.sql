-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- Platform administration (040).
  IF to_regclass('public.platform_admins') IS NULL THEN
    RAISE EXCEPTION 'public.platform_admins is missing — migration 040 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'accounts.status is missing — migration 040 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_platform_admin') THEN
    RAISE EXCEPTION 'is_platform_admin() is missing — migration 040 did not apply';
  END IF;

  -- Suspension boundary (041).
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_account_status') THEN
    RAISE EXCEPTION 'current_account_status() is missing — migration 041 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_functiondef('is_account_member(uuid, account_role_enum)'::regprocedure)
    WHERE pg_get_functiondef LIKE '%a.status = ''active''%'
  ) THEN
    RAISE EXCEPTION 'is_account_member() lacks the accounts.status=active join — migration 041 did not apply';
  END IF;

  -- Invite-only onboarding (042).
  IF to_regclass('public.platform_customer_invites') IS NULL THEN
    RAISE EXCEPTION 'public.platform_customer_invites is missing — migration 042 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_signup_gate') THEN
    RAISE EXCEPTION 'enforce_signup_gate() is missing — migration 042 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_signup_gate'
  ) THEN
    RAISE EXCEPTION 'on_auth_user_signup_gate trigger is missing — migration 042 did not apply';
  END IF;

  -- Invite lifecycle (043).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_customer_invites'
      AND column_name = 'signup_started_at'
  ) THEN
    RAISE EXCEPTION 'platform_customer_invites.signup_started_at is missing — migration 043 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mark_platform_invite_confirmed') THEN
    RAISE EXCEPTION 'mark_platform_invite_confirmed() is missing — migration 043 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_email_confirmed'
  ) THEN
    RAISE EXCEPTION 'on_auth_user_email_confirmed trigger is missing — migration 043 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_functiondef('public.enforce_signup_gate()'::regprocedure)
    WHERE pg_get_functiondef LIKE '%signup_started_at%'
  ) THEN
    RAISE EXCEPTION 'enforce_signup_gate() lacks the 043 lifecycle (no signup_started_at write)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sha256_hex') THEN
    RAISE EXCEPTION 'sha256_hex() helper is missing — the signup gate cannot hash invite tokens (043)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_functiondef('public.enforce_signup_gate()'::regprocedure)
    WHERE pg_get_functiondef LIKE '%public.sha256_hex(%'
  ) THEN
    RAISE EXCEPTION 'enforce_signup_gate() must use public.sha256_hex() (unqualified digest() breaks when pgcrypto is not in search_path)';
  END IF;

  -- Request Access (044).
  IF to_regclass('public.signup_requests') IS NULL THEN
    RAISE EXCEPTION 'public.signup_requests is missing — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'signup_request_status_enum') THEN
    RAISE EXCEPTION 'signup_request_status_enum is missing — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_signup_requests_email_pending'
  ) THEN
    RAISE EXCEPTION 'idx_signup_requests_email_pending missing — one-pending-per-email rule not applied (044)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'convert_signup_request_on_invite_accept') THEN
    RAISE EXCEPTION 'convert_signup_request_on_invite_accept() is missing — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_customer_invites_email_pending'
  ) THEN
    RAISE EXCEPTION 'idx_customer_invites_email_pending missing — approval idempotency index not applied (044)';
  END IF;

  -- Member revocation + seats (045).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'deactivated_at'
  ) THEN
    RAISE EXCEPTION 'profiles.deactivated_at is missing — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_functiondef('is_account_member(uuid, account_role_enum)'::regprocedure)
    WHERE pg_get_functiondef LIKE '%deactivated_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'is_account_member() lacks the deactivated_at guard — migration 045 did not apply';
  END IF;
  IF to_regclass('public.platform_config') IS NULL THEN
    RAISE EXCEPTION 'public.platform_config is missing — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'platform_config' AND rowsecurity
  ) THEN
    RAISE EXCEPTION 'platform_config must have RLS enabled (locked table) — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM platform_config
    WHERE key = 'account_member_limit'
      AND (value)::text::int = 3
  ) THEN
    RAISE EXCEPTION 'platform_config.account_member_limit default 3 is missing — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'account_member_limit') THEN
    RAISE EXCEPTION 'account_member_limit() is missing — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'account_member_usage') THEN
    RAISE EXCEPTION 'account_member_usage() is missing — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'deactivate_account_member') THEN
    RAISE EXCEPTION 'deactivate_account_member() is missing — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reactivate_account_member') THEN
    RAISE EXCEPTION 'reactivate_account_member() is missing — migration 045 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'delete_account_member') THEN
    RAISE EXCEPTION 'delete_account_member() is missing — migration 045 did not apply';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'remove_account_member') THEN
    RAISE EXCEPTION 'remove_account_member() must be dropped — migration 045 should supersede it';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_functiondef('public.redeem_invitation(text)'::regprocedure)
    WHERE pg_get_functiondef LIKE '%account_member_usage(%'
  ) THEN
    RAISE EXCEPTION 'redeem_invitation() lacks the seat-limit guard — migration 045 did not apply';
  END IF;
  -- 046: per-account member limits
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'member_limit'
  ) THEN
    RAISE EXCEPTION 'accounts.member_limit is missing — migration 046 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'account_member_limit' AND pronargs = 1
  ) THEN
    RAISE EXCEPTION 'account_member_limit(uuid) is missing — migration 046 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_functiondef('public.redeem_invitation(text)'::regprocedure)
    WHERE pg_get_functiondef LIKE '%account_member_limit(v_inv.account_id)%'
  ) THEN
    RAISE EXCEPTION 'redeem_invitation() must enforce the per-account limit — migration 046 did not apply';
  END IF;
  -- 047: invite-creation seat guard
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_account_invitations_seat_cap'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_account_invitations_seat_cap trigger is missing — migration 047 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'enforce_invite_seat_cap'
  ) THEN
    RAISE EXCEPTION 'enforce_invite_seat_cap() is missing — migration 047 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
