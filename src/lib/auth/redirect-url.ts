// ============================================================
// Client-side canonical base-URL resolution for auth redirects.
//
// auth pages (signup / forgot-password) build `redirectTo` URLs
// that Supabase bakes into its confirmation / reset emails. Those
// must point at the PUBLIC origin — the one the email link lands
// on — not the origin the browser happened to be using when the
// form was submitted (which can be a localhost dev box, an internal
// hostname, or a tunnel URL).
//
// Resolution order:
//   1. `NEXT_PUBLIC_SITE_URL` — the operator's explicit canonical
//      origin. Trumps everything; set this in production.
//   2. `window.location.origin` — dev / same-origin default.
//
// `NEXT_PUBLIC_SITE_URL` is inlined at build time on the server AND
// embedded into the client bundle, so it is safe to read here in a
// "use client" component. NEVER put a server-only secret in a
// NEXT_PUBLIC_* var.
// ============================================================

/**
 * Return the canonical public origin for auth redirect URLs, without
 * a trailing slash. Prefers NEXT_PUBLIC_SITE_URL so email links
 * resolve to the real domain even when requests arrive via localhost
 * or a tunnel.
 *
 * This helper only runs in the browser (window). Callers that need a
 * server-side URL (route handlers) should use the request-relative
 * resolution in src/lib/auth/redirect-url.ts (resolvePublicOrigin) instead.
 */
export function clientAuthRedirectOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  return origin.replace(/\/+$/, "");
}

/**
 * Server-side canonical public origin for building shareable /
 * redirect URLs in route handlers.
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL — the operator's explicit canonical origin.
 *      Trumps everything, so production links never leak a localhost /
 *      tunnel / internal hostname even when the request arrives via one.
 *   2. The request's own origin (Host + protocol headers) — the dev /
 *      same-origin default. The IPv4/6 plus bracket logic guards against
 *      an empty/partial host string producing a malformed origin.
 *
 * Returns an origin WITHOUT a trailing slash.
 */
export function resolvePublicOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  // Use the request URL's host when the forwarded header is absent; it
  // already strips ports and preserves IPv6 brackets correctly.
  const host = forwardedHost || new URL(request.url).host;
  if (!host) return "";

  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const proto =
    forwardedProto && forwardedProto.length > 0
      ? forwardedProto
      : new URL(request.url).protocol.replace(":", "");

  return `${proto}://${host}`.replace(/\/+$/, "");
}
