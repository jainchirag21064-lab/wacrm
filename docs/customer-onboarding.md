# Customer onboarding (invite-only)

Phase 2 of the SaaS buildout replaces **unrestricted public signup**
with an **invite-only onboarding** model. A customer can no longer
just visit `/signup` and create an account — a platform admin must
first approve/rove the email address.

## Signup behavior: before vs after

| | Before (migrations ≤ 041) | After (migrations 042 + 043) |
|---|---|---|
| `/signup` | Anyone could create an account | Only **platform-invited** emails may register |
| Direct `supabase.auth.signUp()` from a raw client | Always succeeded | Rejected by the DB unless invited (secure, not client-only) |
| Invited teammate via `/join/<token>` | Worked (token was the credential) | Still works — the gate recognizes the team-invite token |
| New customer account | Created for every signup | Created only for invited emails |
| Invite consumed | — | Only when the invited email is actually **confirmed**; abandoned signups stay pending (043) |

## Two invite surfaces (both preserved)

1. **Platform customer invites** (`platform_customer_invites`, new):
   a platform admin approves an email; that email may register a
   customer account. Managed under `/platform/customer-invites`.
2. **Account / team invitations** (`account_invitations`, existing):
   a customer-owner/admin invites a teammate via a shareable
   `/join/<token>` link.

## The signup gate (`enforce_signup_gate`)

A `BEFORE INSERT` trigger on `auth.users` (migration 042, rewritten in
043) is the single server-side enforcement point — a "Before User
Created" hook implemented in Postgres. It fires for **every**
`auth.users` insert (including a raw `signUp()` from a script) and
admits the signup iff either:

- **Platform invite** — `NEW.email` has a **pending, un-expired** row in
  `platform_customer_invites`. When signup metadata carries a
  `customer_invite_token` (the token in the admin's `/signup?
  customer_invite=<token>` link), the token is resolved by hash and the
  *invited email must equal the signup email* — a revoked, expired,
  already-accepted, or email-mismatched token is rejected outright.
  Token-less signup for an approved (pending, unexpired) email still
  works as a fallback. **or**
- **Team invite** — `NEW.raw_user_meta_data->>'invite_token'` hashes to a
  **valid, un-used, un-expired** `account_invitation` row.

Otherwise it raises `42501` (`Public signup is invite-only`) and the
row insert fails, so no account/profile is created.

## Invite lifecycle (migration 043)

Rather than marking an invite `accepted` the moment a user row is
created (the 042 behaviour), the gate now records that signup **began**
(`signup_started_at`) and leaves the invite `pending` until the email
is **actually confirmed**:

```
pending → (signup started) → email confirmed → accepted
```

A second server-side hook — `mark_platform_invite_confirmed()`, an
`AFTER UPDATE OF email_confirmed_at` trigger on `auth.users` — flips
the matching pending invite to `accepted` only on real confirmation. An
abandoned / unverified signup therefore does **not** permanently
consume the invite: status stays `pending` and a platform admin can
revoke or re-issue it.

## Signup flow & the invite URL

A platform admin creating an invite receives a **complete shareable
URL** — `https://<canonical-site>/signup?customer_invite=<token>` — and
the UI shows that link, never the bare token. The canonical origin is
`NEXT_PUBLIC_SITE_URL` with a safe request-origin fallback for local
dev (`resolvePublicOrigin` / `customerInviteUrl` in
`src/lib/auth`).

The customer signs up on `/signup` by entering the **invited email**
(their email must match the invite). The signup page carries the token
through `signUp({ data: { customer_invite_token } })` so the gate can
validate it, and points email confirmation at `/auth/callback`.

## Every signup confirmation goes through `/auth/callback`

`emailRedirectTo` for both channels lands at `/auth/callback`, which
exchanges the one-time `?code` into a session and then forwards to a
**safe** `next` (open-redirect protected):

- **Platform invite** → `next=/dashboard` (account/profile already
  exist; confirmation completes onboarding).
- **Team invite** → `next=/join/<token>` (they still must accept the
  invitation).

Both invite contexts are preserved; `type=recovery` continues to go to
`/reset-password`.

### Bootstrap escape hatch

Creating the very first platform admin (or recovering a locked-out
owner) requires creating an `auth.users` row that the gate would
otherwise reject. Set the session GUC in the SQL editor / service
context to bypass once:

```sql
SET "app.bypass_signup_gate" = 'true';
INSERT INTO auth.users (...) VALUES (...); -- or admin.createUser path
```

This is not reachable from the end-user client.

## Platform API

| Route | Method | Purpose |
|---|---|---|
| `/api/platform/customer-invites` | `GET` | List customer invites (incl. soft state) |
| `/api/platform/customer-invites` | `POST` | Create/invite an email (returns a complete invite URL, one-time) |
| `/api/platform/customer-invites/[id]` | `DELETE` | Revoke a pending invite |

All are platform-admin-only (`requirePlatformAdmin()` first, then the
service-role client). The one-time plaintext token is embedded once in
the returned `inviteUrl`; the DB stores only its SHA-256 hash.

## Platform UI

`/platform/customer-invites` (sidebar: **Customer Invites**) lets a
platform admin create, list, **copy the complete invite link** (one-time),
and revoke invites, with loading / empty / error / forbidden / confirmation
states. Pending invites with a started-but-unconfirmed signup show
"Signup in progress". The account table under `/platform/accounts` is
unchanged.

## Security

- `platform_customer_invites` has RESTRICTIVE always-false RLS, so the
  end-user client cannot enumerate invited emails via PostgREST.
- Invited-email matches are case-insensitive (stored lowercase).
- Tokens are 32-byte CSPRNG, SHA-256-hashed at rest (shared utilities
  with `src/lib/auth/invitations.ts`).

## Required Supabase settings

See `docs/supabase-config.md` — invite-only onboarding assumes
**Email confirmation is ON**, the **Site URL** and
**`NEXT_PUBLIC_SITE_URL`** match, and the **Redirect URLs** include
`/auth/callback` and `/join/*`.

## Auth callback (`/auth/callback`)

Phase 1 added the missing callback route for Supabase's post-email /
post-reset redirects. It:

- exchanges `?code` for a session,
- sends `type=recovery` flows to `/reset-password`,
- validates `?next` to prevent open redirects (`src/app/auth/callback/route.ts`),
- supports email-confirmation redirects.

`/reset-password` (in the `(auth)` group) lets a recovered user set a
new password via `updateUser`.
