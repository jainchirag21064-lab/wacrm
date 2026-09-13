# Request Access (public signup intake, migration 044)

Phase 3 of the SaaS buildout adds a **public intake path** on top of the
invite-only model: an uninvited visitor can request access without
creating any Auth user. A platform admin reviews the request and, if
approved, the system generates the same **platform customer invite**
that the invite-only flow uses — so the existing signup gate, RLS, and
suspension checks are unchanged and are never weakened.

This is deliberately **not** a bypass: a submitted request never admits
a signup on its own. Only an admin approval converts a request into the
standard `platform_customer_invites` invite.

## Flow

### Visitor (no account needed)

```
/platform/referral or login → "Request access" → /request-access
→ fill form (name, email, company, message, referral code)
→ submit → generic { ok: true } (success AND duplicate)
```

- `POST /api/access-requests` (public).
- No Auth user is created and none is required.
- Success and duplicate both return `{ ok: true, ... }` — an attacker
  cannot tell whether an email already has a pending request.
- `23505` (the one-pending-per-email partial unique index) is treated as
  success, not an error.
- Email is normalized to lowercase; required fields are bounded and
  optional fields are trimmed/clamped (see
  `src/lib/access-requests/validation.ts`).

### Platform review

```
Sidebar "Access Requests" (badge = pending count)
→ /platform/access-requests
→ filter by status, search (name/email/company/referral), paginate
→ Approve / Reject (reason) / Spam
```

All review routes are `requirePlatformAdmin()`-guarded, then use the
service-role client (never exposed to the browser):

| Route | Method | Action |
|---|---|---|
| `/api/platform/access-requests` | `GET` | List (status filter, search, pagination) |
| `/api/platform/access-requests/[id]/approve` | `POST` | Approve → create platform invite |
| `/api/platform/access-requests/[id]/reject` | `POST` | Reject (optional reason ≤ 500 chars) |
| `/api/platform/access-requests/[id]/spam` | `POST` | Mark as spam |
| `/api/platform/access-requests/pending-count` | `GET` | Badge count for the sidebar |

#### Approval → invitation

- Requires the request to be `pending` and **no other pending platform
  invite** for that email (else `409`).
- Creates one `platform_customer_invites` row (7-day expiry) and links it
  via `signup_requests.platform_invite_id`.
- Returns the **complete invite URL**
  (`https://<origin>/signup?customer_invite=<token>`) — the raw token is
  never returned separately; the DB stores only the SHA-256 hash.
- Idempotency: re-approving a non-pending request → `409`. A concurrent
  approve race surfaces the unique partial index
  (`idx_customer_invites_email_pending`) as `23505` → `409`.

#### Conversion

When the invited email confirms and the platform invite becomes
`accepted` (per migration 043's `mark_platform_invite_confirmed()`), a
new trigger — `convert_signup_request_on_invite_accept()` — flips the
linked request `approved → converted`.

```
request: pending  → approved  → converted
invite : (─ created ─) pending → accepted   (per 043 lifecycle)
```

Requests that are `rejected` or `spam` are terminal and do not convert.

## Request lifecycle & statuses

`signup_request_status_enum`: `pending`, `approved`, `rejected`,
`converted`, `spam`.

- One pending request per normalized email (partial unique index
  `idx_signup_requests_email_pending`).
- `signup_requests` has RESTRICTIVE always-false RLS — the end-user
  client can never read or mutate it via PostgREST.
- `touch_signup_request_updated_at()` bumps `updated_at` on change.

## Platform vs team invites — keep them separate

- **Platform invite** (`platform_customer_invites`) — what approval
  creates. Unlocks `/signup` for the invited email.
- **Account/team invite** (`account_invitations` + `/join/<token>`) — an
  *unrelated* teammate invitation mechanism. Approval never touches it.

## Security notes

- Service-role key stays server-only; all action routes call
  `requirePlatformAdmin()` first.
- Rate limiting is the bot protection (the repo ships no CAPTCHA
  provider, so one is added only if such a provider is introduced):
  - `accessRequest`: 5 / 10 min per IP
  - `accessRequestPerEmail`: 3 / 60 min per normalized email
- No passwords or invite tokens are stored in plaintext.
- Generic `{ ok: true }` / generic error responses prevent account/email
  enumeration, and the invalid-status filter is a generic `400`.
- Referral code is stored informational only and has no access effect.

## Required Supabase settings

Identical to the invite-only flow — see `docs/supabase-config.md`.
Approval relies on the same `customerInviteUrl` /
`resolvePublicOrigin` logic and the exact `origin` must match the
configured Site URL / `NEXT_PUBLIC_SITE_URL`.

## Schema / data

- Table: `public.signup_requests`
- Enum: `public.signup_request_status_enum`
- Triggers: `touch_signup_request_updated_at`,
  `convert_signup_request_on_invite_accept`
- Indexes: `idx_signup_requests_status_created_at`,
  `idx_signup_requests_email`, `idx_signup_requests_email_pending`
  (partial unique), `idx_signup_requests_platform_invite_id`,
  `idx_customer_invites_email_pending` (partial unique on
  `platform_customer_invites`)
