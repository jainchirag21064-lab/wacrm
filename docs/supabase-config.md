# Supabase project configuration

This project relies on a handful of **Supabase Auth** settings that
cannot be expressed in a migration — they live in the Supabase
Dashboard (Authentication → URL Configuration and Email Templates),
or in project-level email/smtp settings. Getting them wrong produces
subtle breakages (confirmation links erroring, password-reset loops,
open-redirect-prone email links), so they're documented here in one
place.

> These are **dashboard settings, not code**. They are not covered by
> `supabase/ci/verify-schema.sql` (which only validates the database
> schema). When you provision a new Supabase project for this repo,
> apply them by hand.

## 1. Site URL

Location: **Authentication → URL Configuration → Site URL**

Set this to the canonical public origin of the app, **with no
trailing slash** and no path:

- Production: `https://your-domain.example`
- Local dev with `supabase` CLI: keep the default `http://localhost:3000`
  (or whatever port you run the app on).

Keep this in sync with `NEXT_PUBLIC_SITE_URL` in `.env.local.example`.
The two serve different purposes:

- **Site URL (dashboard)** — Supabase uses it as the default base for
  auth redirects and as the prefix for auto-generated email links.
- **`NEXT_PUBLIC_SITE_URL` (app)** — the app's own canonical origin,
  used by `src/lib/auth/redirect-url.ts` (client auth pages) and
  `src/lib/auth/invitations.ts` (server-generated invite links).

They should normally be identical.

## 2. Redirect URLs

Location: **Authentication → URL Configuration → Redirect URLs**

The auth flows in this repo redirect back into the app at:

| Path                  | Flow                                             |
| --------------------- | ------------------------------------------------ |
| `/auth/callback`      | Email confirmation, password reset, OAuth, magic |
| `/join/<token>`       | Customer-team invitation redemption              |

Add **exactly these two** to the allow-list (Supabase rejects any
redirect not listed):

```
https://your-domain.example/auth/callback
https://your-domain.example/join/*
```

For local development against a hosted Supabase project, also add:

```
http://localhost:3000/auth/callback
http://localhost:3000/join/*
```

> `NEXT_PUBLIC_SITE_URL` must be an **exact match** for the origin in
> these entries. Supabase compares the *scheme + host + path* of the
> redirect against the list — a mismatched origin (e.g. `https://app.`
> vs `https://www.`) breaks the callback.

## 3. Auth → `/auth/callback` security

The `/auth/callback` route in this repo handles open-redirect
prevention itself: any `?next=` it receives must resolve to a
same-origin relative path before the browser is redirected (see
`src/app/auth/callback/route.ts`). Even so, keep the Redirect URLs
list tight — a wildcard that admits arbitrary hosts would let a
compromised or misconfigured flow ship a user's session to an
attacker-controlled page. Only list the app's own origins.

## 4. Email confirmation

Location: **Authentication → Providers → Email**

- **Confirm email**: **ON**. The signup flow is invite-gated (see
  Phase 2) and every account expects a verified email. With
  confirmation off, `handle_new_user` still fires but the invite
  lifecycle never completes properly.
- **Double confirm email**: your call — leave off for a smoother
  signup; turn on for stricter deliverability checks.
- **Secure email change**: **ON** (recommended) and **Confirm email**
  for the email-change flow.

## 5. SMTP / custom email

Location: **Project Settings → Email → SMTP Settings**

Supabase's built-in mailer has deliverability limits. For a
production CRM that sends confirmation / reset links, connect a real
SMTP provider (Resend, Postmark, SES, Mailgun, …):

1. Set **Custom SMTP** with your provider's host, port (587 or 465),
   username, password, and sender address.
2. Use **TLS/SSL** — do not disable or relax it; Supabase/your
   provider may refuse plaintext auth.

There is no SMTP env var in this repo — this is a dashboard setting.

## 6. Email templates

Location: **Authentication → Email Templates**

Two templates matter for the Phases that touch auth:

- **Confirm signup** — the "Confirm your email" link. Make sure the
  link label uses Supabase's `{{ .ConfirmationURL }}` variable and
  keep the button text on-brand. The link resolves through the
  Redirect URLs above.
- **Invite user** — Supabase generates an invite URL with
  `{{ .ConfirmationURL }}` + the `invite_token`; this app routes
  those through `/join/<token>` for team invitations.
- **Reset password** — the recovery link. This app's flow points it
  at `/auth/callback?next=/reset-password` (built from the
  `redirectTo` in `forgot-password/page.tsx`), so the template's
  `{{ .ConfirmationURL }}` carries the code that `/auth/callback`
  exchanges.

Brand the email `From` name and logo under **Global** for consistency.

## 7. Restricting public signup (Phase 2)

Public email/password signup is gated on **invitation only** at the
database level — see `src/lib/auth/` and `supabase/migrations/042_*`.
A raw `supabase.auth.signUp()` from an uninvited email is rejected by
a `BEFORE INSERT` trigger on `auth.users` (a "Before User Created"
hook equivalent implemented in Postgres). Make sure **Confirm email**
is ON for that gate to make sense (the invite row is provisioned for
a pending signup, then accepted on actual verification).

## Checklist when creating a new environment

- [ ] Site URL = canonical origin
- [ ] Redirect URLs include `/auth/callback` and `/join/*` for both
      prod and localhost
- [ ] Confirm email = ON
- [ ] Custom SMTP configured (+ sender verified)
- [ ] Email templates point at `{{ .ConfirmationURL }}` and are
      on-brand for confirm-signup, invite, and reset-password
- [ ] `NEXT_PUBLIC_SITE_URL` matches the Site URL
