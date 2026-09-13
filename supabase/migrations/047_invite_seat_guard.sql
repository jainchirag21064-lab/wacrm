-- ============================================================
-- 047_invite_seat_guard.sql
--
-- Close the "create more invites while over the seat cap" gap.
--
-- 045/046 enforced the seat limit at REDEMPTION (redeem_invitation),
-- but invite CREATION was unguarded: an owner at/over the cap could
-- keep generating invite links, and only the offer's redemption would
-- fail — with confusing UX. This migration makes the cap bite at the
-- invite step too:
--
--   1. GRANT authenticated EXECUTE on account_member_usage() so the
--      invite API can check current usage server-side (it currently
--      has no grant; only the SECURITY DEFINER helpers use it).
--   2. A BEFORE INSERT trigger on account_invitations rejects any
--      insert that would create an invite for a team with no free
--      seat — defense-in-depth so invites cannot be created by ANY
--      path (console, future code) while over the cap.
--
-- Seat rule (identical to redemption): usage >= effective limit
-- (per-account override, else global default), where usage counts
-- active + deactivated non-owner members.
-- ============================================================

GRANT EXECUTE ON FUNCTION public.account_member_usage(UUID) TO authenticated;

-- ------------------------------------------------------------------
-- Trigger: block invite INSERTs for teams with no free seat
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_invite_seat_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF account_member_usage(NEW.account_id) >= account_member_limit(NEW.account_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'This team has reached its member limit. An owner must permanently delete a member to free a seat.';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_invite_seat_cap() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_invite_seat_cap() FROM PUBLIC;

CREATE TRIGGER trg_account_invitations_seat_cap
BEFORE INSERT ON public.account_invitations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_invite_seat_cap();