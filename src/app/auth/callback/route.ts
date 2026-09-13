// ============================================================
// GET /auth/callback
//
// Supabase's magic callback endpoint. Supabase redirects here after:
//   - email confirmation            (?code + type=signup)
//   - password reset                (?code + type=recovery)
//   - magic-link / OAuth flow       (?code)
//
// We exchange the one-time `code` for a session (writing the auth
// cookies) and then redirect the browser to a safe `next` path.
//
// SECURITY: open-redirect prevention. The `next` query parameter is
// attacker-influenceable (e.g. someone forwards a doomed link with
// ?next=https://evil.example). We NEVER trust it blindly. It must
// resolve to a same-origin, same-host relative path — no scheme, no
// authority, no protocol-relative `//`, no backslashes — otherwise
// we fall back to the default landing page.
// ============================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

const DEFAULT_LANDING = '/dashboard';
const MAX_REDIRECT_LENGTH = 2048;

/**
 * Validate a user-supplied `next` redirect target for open-redirect
 * safety. Returns a normalized same-origin path+search+hash string,
 * or null when the input is absent or unsafe.
 *
 * Accepts only root-relative paths (/dashboard, /settings?tab=x).
 * Rejects any input carrying a scheme or host (https://evil.com,
 * //evil.com), backslashes, control characters, or absolute URLs
 * that could be interpreted cross-origin.
 */
export function safeNextPath(next: string | null): string | null {
  if (!next) return null;
  if (next.length > MAX_REDIRECT_LENGTH) return null;

  let value: string;
  try {
    value = decodeURIComponent(next);
  } catch {
    return null; // malformed percent-encoding
  }

  // Control chars + backslash (browsers treat `\` as a path
  // separator, which can smuggle an origin) are always rejected.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;

  // Protocol-relative URL → treat as hostile.
  if (value.startsWith('//')) return null;

  // Reject path-traversal attempts. Check the RAW decoded value, not
  // the normalized one: `new URL` collapses `/../../etc/passwd` to
  // `/etc/passwd`, silently erasing the `..` — so inspecting the
  // normalized path lets a traversal slip through.
  if (/(^|\/)\.\.(\/|$)/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value, 'https://wacrm.invalid');
  } catch {
    return null;
  }

  // The input must be root-relative: it must not carry its own scheme
  // or host. new URL gives absolute inputs a real host; relative
  // inputs keep the dummy base host, which is how we tell them apart.
  if (parsed.origin !== 'https://wacrm.invalid') return null;

  // Reject API/storage endpoints as landing pages.
  const path = parsed.pathname + parsed.search + parsed.hash;
  if (path.startsWith('/api/') || path.startsWith('/auth/')) return null;

  return path;
}

interface CallbackClientOptions {
  getAll: () => Promise<{ name: string; value: string }[]>;
  setAll: (
    list: { name: string; value: string; options: Record<string, unknown> }[],
  ) => Promise<void>;
}

function createCallbackClient() {
  const cookieStore = () => cookies();
  const opts: CallbackClientOptions = {
    getAll: async () => {
      const store = await cookieStore();
      return store
        .getAll()
        .map((c) => ({ name: c.name, value: c.value }));
    },
    setAll: async (list) => {
      const store = await cookieStore();
      for (const { name, value, options } of list) {
        store.set(name, value, options);
      }
    },
  };

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: opts },
  );
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const type = requestUrl.searchParams.get('type');
  const rawNext = requestUrl.searchParams.get('next');

  // Exchange the one-time code for a session. This writes the auth
  // cookies onto the response via setAll above; the redirect below is
  // a fresh object but the cookie writes land on the response we
  // return (Next.js applies cookies() mutations to the outgoing
  // response for a Route Handler). A missing or failed code just
  // falls through to a redirect.
  if (code) {
    try {
      const supabase = createCallbackClient();
      await supabase.auth.exchangeCodeForSession(code);
    } catch (err) {
      console.error('[auth/callback] code exchange failed:', err);
    }
  }

  // Password-recovery always lands on the reset-password form so the
  // user can set a new password before anything else.
  if (type === 'recovery') {
    return NextResponse.redirect(
      new URL('/reset-password', requestUrl.origin),
    );
  }

  const landing = safeNextPath(rawNext) ?? DEFAULT_LANDING;
  return NextResponse.redirect(new URL(landing, requestUrl.origin));
}
