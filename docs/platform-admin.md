# Platform administration

Platform administration is the **SaaS-owner layer** of wacrm: a
separate authorization tier for managing customer accounts. Platform
admins can list every customer account and suspend or reactivate
them, without gaining any cross-account access inside the normal
customer-facing app.

> **Status:** new in milestone 1. The foundation — the
> `platform_admins` table, account `status`, the platform API, and
> the `/platform/accounts` UI — ships now. Billing, signup approval,
> and account deletion are explicitly **not** included.
>
> Migration `041_suspend_rls.sql` (same milestone) closes the loop and
> makes suspension a *database-enforced* boundary: every tenant RLS
> policy rejects members of suspended accounts at the row level, so
> suspension is no longer a server-only convention.

## How platform-admin authorization works

Platform-admin status is tracked in the `platform_admins` table,
**completely independent** of `profiles.account_role` and customer
account membership:

- A user's role in their own account (`owner`/`admin`/… ) says
  nothing about whether they're a platform admin.
- A customer account owner is **not** automatically a platform
  admin — nothing about account ownership grants platform powers.
- Being a platform admin does **not** grant any extra RLS row access
  in customer-facing routes. Platform admin powers exist only on
  the dedicated `/api/platform/*` routes, which run with the
  service-role client _after_ a server-side platform-admin check.

### Tenancy safety

Platform routes take a **service-role Supabase client** and are
reachable **only** after `requirePlatformAdmin()` passes. The
service-role client never touches `getCurrentAccount()`/RLS-scoped
code, and no platform-admin RLS policies were added to the tenant
tables — so a platform admin browsing the normal app sees exactly
the same rows any member sees. Tenant isolation is unchanged.

## The migrations (`040_platform_admin.sql`, `041_suspend_rls.sql`)

`supabase/migrations/040_platform_admin.sql` creates:

| Object                   | Purpose                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform_admins`        | `user_id` (PK → `auth.users`), `created_at`. RLS locked down — the anon/authenticated client roles cannot read or write it directly.                                                       |
| `accounts.status`        | Enumerated `active` / `suspended`, `NOT NULL DEFAULT 'active'` — existing rows are activated automatically.                                                                                |
| `is_platform_admin(uid)` | SECURITY DEFINER helper; resolves the caller via `auth.uid()` (the argument is accepted for signature readability but deliberately ignored, so one caller can't probe arbitrary user IDs). |

The table has a RESTRICTIVE always-false RLS policy for the Supabase
client roles. Server code and the client UI check admin status by
calling the `is_platform_admin()` function, which runs as the
function owner (postgres) and bypasses RLS.

`supabase/migrations/041_suspend_rls.sql` makes suspension a real
boundary:

| Object                         | Purpose                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `is_account_member()`          | Now joins `accounts` and requires `status = 'active'`. Since every tenant RLS policy on every account-scoped table calls this helper, **one change blocks all reads/writes for suspended accounts app-wide**. `service_role` still bypasses RLS, so webhook + engine + broadcast jobs are unaffected.              |
| `current_account_status()`     | SECURITY DEFINER API that returns the caller's *own* account status even though the `accounts` row is now RLS-hidden for suspended members. Server (`getCurrentAccount`) and client (`useAuth`) call this so the SuspendedScreen and the "This account has been suspended" 403 are still reachable.               |
| Storage write policies         | `chat-media` + `flow-media` account-path writes now require an active account (objects stay publicly readable so Meta can reach URLs). The legacy `auth.uid()`-folder flow-media branch is preserved.                                                                                                               |
| Member-management RPCs         | `set_member_role`, `deactivate_account_member`, `reactivate_account_member`, `delete_account_member`, `transfer_account_ownership` now refuse to run when the caller's account is suspended (`42501`), closing the SECURITY DEFINER bypass these functions would otherwise give a suspended owner.                                                                        |

## Member revocation + seat limits (migrations 045 + 046 + 047)

Member removal is a **two-action model**, and each account has a seat
cap. These two decisions work together: the seat limit is what forces
owners to permanently delete stale users instead of letting them pile
up.

- Migration 045 added a **global default** cap (default 3) in
  `platform_config`, configurable at `/platform/settings`.
- Migration 046 added **per-account overrides** (`accounts.member_limit`):
  the platform admin can cap one customer at 3 seats while another gets
  10, from **Platform → Accounts**. The effective limit for an account
  is `accounts.member_limit` when set, otherwise the global default.
- Migration 047 closes the invite-creation gap: creating an invitation
  is now rejected (`400 seat_full`) when the team has no free seat.
  A `BEFORE INSERT` trigger on `account_invitations` provides
  defense-in-depth so invites cannot bypass the cap through any path.

| Action               | Role    | Effect                                                                                                                                                                                                                                                             |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove** (deactivate) | Admin+  | Sets `profiles.deactivated_at`. Every tenant RLS policy funnels through `is_account_member()`, which now also requires `deactivated_at IS NULL`, so the member is locked out **instantly app-wide** — the same mechanism suspension uses, at the per-person level. Their auth login survives, their data is untouched, and `POST reactivate` restores them anytime. The seat stays occupied. |
| **Delete permanently** | Owner   | Purges the member entirely: `auth.users` row (cascades their profile, presence, notifications) plus any personal accounts they own. Account-scoped rows the member created (contacts, conversations, broadcasts, flows, templates, …) are **reassigned to the owner** first so the team keeps its data. Irreversible. The only way to **free a seat**.                                                                             |

Consequences of the model:

- **Seats include deactivated members.** `account_member_usage()`
  counts every non-owner member (active + deactivated) — the owner is
  the subscription itself, not a seat. A deactivated member keeps
  occupying their seat until an owner permanently deletes them.
- **The old `remove_account_member` behavior is gone.** It used to spin
  up a *fresh personal account* for the removed member, so a revoked
  teammate walked away owning a usable workspace. Migration 045 drops
  it; deactivation locks people out instead.
- **`redeem_invitation()` enforces the cap** — it's the single member
  admission path. Joining a team at its limit raises `22023` (the route
  maps it to a 400) telling the caller the owner must free a seat. It
  resolves the target's **effective** limit via
  `account_member_limit(account_id)`, so per-account overrides apply at
  admit time. It also refuses to let a **deactivated** member redeem
  into another team, so revocation follows the person until restored.
- **`POST /api/account/invitations` is also seat-gated** (migration 047):
  invite creation is rejected with `400 seat_full` when the team has no
  free seat. A `BEFORE INSERT` trigger on `account_invitations` provides
  the same check as defense-in-depth.
- **`platform_config`** holds the global default knob as
  `account_member_limit`; RLS is **enabled with no policies** (a locked
  table — only SECURITY DEFINER helpers and the service-role routes
  touch it, both of which bypass RLS). `0` = no members allowed; a large
  value effectively lifts the cap. `getCurrentAccount()` throws 403
  `Your access has been revoked` for deactivated members, and the client
  renders a "DeactivatedAccount" screen instead of the app.

## Creating the first platform admin

The table has no self-service front door, by design. Bootstrap the
first admin with the **service-role key** — in the Supabase SQL
editor (recommended) or via the Management API:

```sql
INSERT INTO platform_admins (user_id)
VALUES ('<the-user's-auth-uuid>');
```

To find a user's auth UUID:

```sql
-- by email
SELECT id FROM auth.users WHERE email = 'owner@example.com';

-- or by their profile
SELECT p.user_id, p.email
FROM profiles p
WHERE p.email = 'owner@example.com';
```

That user can now browse to **/platform/accounts** (a "Platform
Admin" item appears in the sidebar) and manage accounts. Additional
admins can be added the same way:

```sql
INSERT INTO platform_admins (user_id)
SELECT id FROM auth.users WHERE email = 'second-admin@example.com'
ON CONFLICT (user_id) DO NOTHING;
```

### Removing a platform admin

```sql
DELETE FROM platform_admins WHERE user_id = '<uuid>';
```

## Account suspension

Suspending an account sets `accounts.status = 'suspended'`. Effects:

- **Database (migration 041):** `is_account_member()` — the gate every
  tenant RLS policy funnels through — now also requires an active
  account, so a suspended account's rows are unreachable at the
  database level. Its own `accounts` row is hidden too, which is why
  `current_account_status()` exists to answer "is MY account
  suspended?" for the app.
- **Dashboard/mobile app:** every member sees a "Account suspended"
  screen. `useAuth` resolves the status (via the accounts row when
  active, via the RPC when the row is hidden) and renders the
  SuspendedScreen instead of the app.
- **Protected APIs:** every route that resolves the caller through
  `getCurrentAccount()`/`requireRole()` returns **403**
  (`This account has been suspended`). This includes the routes that
  previously hand-rolled `auth.getUser()` + a `profiles` lookup
  (WhatsApp config / templates / media mirror, Flows list + runs,
  Automations list + detail + runs): they now use the status-aware
  context too. The public API's `requireApiKey` performs the same
  check and returns the 403 envelope for keys bound to suspended
  accounts.
- **Media uploads:** storage writes for `chat-media` + `flow-media`
  reject suspended accounts at the policy level.
- **Not affected:** webhook ingestion and internal service-role jobs
  (the automation engine, broadcast dispatch) run with the
  service-role client and do **not** gate on `accounts.status`, so a
  suspension does not break background processing. This is
  intentional — a suspended account's inbound messages are still
  mirrored into history so that re-activation is lossless.

Reactivating an account restores full access immediately.

## Platform API (`/api/platform/*`)

All routes require the caller to be a platform admin. Authorization
is enforced **server-side on every route** — nothing trusts the UI.

| Route                                    | Method | Purpose                                                                                                              |
| ---------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `/api/platform/accounts`                 | `GET`  | List every customer account (id, name, status, created date, owner name + email, member count, WhatsApp configured, **member limit override**). Also returns `default_member_limit`. |
| `/api/platform/accounts/[id]/suspend`    | `POST` | Set the account to `suspended`.                                                                                      |
| `/api/platform/accounts/[id]/reactivate` | `POST` | Set the account to `active`.                                                                                         |
| `/api/platform/accounts/[id]/member-limit` | `POST`| Set or clear the per-account member limit (`{ "limit": 10 }` or `{ "limit": null }` to fall back to the default).      |
| `/api/platform/config/member-limit`      | `GET`  | Current **default** member (seat) limit.                                                                             |
| `/api/platform/config/member-limit`      | `POST` | Set the global default seat limit (integer 0–1000). Stored in `platform_config`, applied to accounts without an override. |

Notes:

- A platform admin **cannot suspend their own account** (the route
  returns 409); doing so would lock that admin out with no one left
  to restore it.
- The list route returns only the fields above. It never returns
  WhatsApp access tokens or other customer secrets — the service-role
  client reads them in memory only for the `whatsapp_configured`
  boolean, and discards them.

## Platform admin UI (`/platform/accounts`)

A server-rendered page that runs `requirePlatformAdmin()` (redirects
non-admins to `/dashboard`) and then renders an interactive table
with:

- loading, empty, error, and (defensive) forbidden states
- suspend / reactivate actions with a confirmation dialog
- your own account marked, with suspend disabled
- a per-account **member limit** column: shows the effective cap,
  flags accounts *over* their limit, and lets you set a custom limit
  or revert to the platform default

The sidebar "Platform Admin" link is rendered only for platform
admins (`useIsPlatformAdmin()`), but that link is a convenience — the
page and API both enforce authorization server-side.

## Running the migration

Standard migration flow for this repo (see CI
`.github/workflows/migrations.yml`):

```bash
# local: boot a clean Postgres and replay every migration
supabase db reset --local --no-seed

# verify the resulting schema (asserts platform_admins, accounts.status,
# is_account_member's status join, and current_account_status exist)
supabase db query --local --file supabase/ci/verify-schema.sql
```

Then apply to the real project with `supabase db push` (or the SQL
editor + the file above for the first admin insert).

## Environment variables

`040_platform_admin.sql` and the platform routes need **no new
environment variables**. They reuse the existing:

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the
  SSR + browser clients used for the `is_platform_admin` RPC check.
- `SUPABASE_SERVICE_ROLE_KEY` — the service-role client used by the
  platform API routes, only _after_ `requirePlatformAdmin()` passes.
  It must remain server-only, exactly as documented in
  `.env.local.example`.

## Testing

Focused Vitest suites ship with the milestone:

```bash
npx vitest run \
  src/lib/auth/platform-admin.test.ts \
  src/lib/auth/account.test.ts \
  src/lib/auth/api-context.test.ts \
  src/app/api/platform/accounts/route.test.ts \
  "src/app/api/platform/accounts/[id]/suspend/route.test.ts" \
  "src/app/api/platform/accounts/[id]/reactivate/route.test.ts"
```

Covered:

- non-platform users receive 403 on every platform route, before any
  service-role work
- platform admins can read the account list with the full response
  shape
- suspend and reactivate succeed for platform admins; a self-suspend
  is rejected (409)
- suspended accounts are rejected by `getCurrentAccount()` (the
  shared resolution path for the dashboard + protected APIs) — both
  when the row is visible and when the migration-041 RLS hides it
  (fallback through `current_account_status()`)
- public API keys bound to suspended accounts receive the 403
  envelope from `requireApiKey` (valid active keys still resolve)
- existing account-role RLS isolation behavior is unchanged
  (`account.test.ts` still guards the no-embedded-join account
  resolution)

Run the whole suite: `npm test`, typecheck `npm run typecheck`, lint
`npm run lint`.
