'use client';

// ============================================================
// useIsPlatformAdmin — whether the signed-in user is a platform
// administrator (platform_admins table, independent of account
// role).
//
// Lightweight, memoised, and purely cosmetic: it only drives UI
// affordances like the sidebar link. Real authorization is
// enforced server-side on every /api/platform/* route via
// requirePlatformAdmin(), so this hook is never a security
// boundary.
//
// The RPC is_platform_admin(uid) is a SECURITY DEFINER function
// callable by authenticated users (granted in migration 040). It
// checks platform_admins for the caller's auth.uid().
// ============================================================

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';

interface State {
  isPlatformAdmin: boolean;
  loading: boolean;
}

// Module-level cache: the flag is stable within a signed-in
// session. Reset only happens on a full page load (the hook
// re-runs), which is fine for a cosmetic UI gate.
let cached: State | null = null;

export function useIsPlatformAdmin(): State {
  // Initialise from the cache so a cached resolve never needs to
  // synchronously setState inside the effect.
  const [state, setState] = useState<State>(
    cached ?? { isPlatformAdmin: false, loading: true }
  );

  useEffect(() => {
    if (cached) return;

    const supabase = createClient();
    let mounted = true;

    const resolve = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!mounted) return;
      if (!user) {
        cached = { isPlatformAdmin: false, loading: false };
        setState(cached);
        return;
      }

      const { data, error } = await supabase.rpc('is_platform_admin', {
        uid: user.id,
      });
      if (!mounted) return;
      if (error) {
        // Cosmetic probe — fail closed (treat as "not an admin"). An
        // RPC failure is not an app error: it typically means the
        // connected Supabase is missing migration 040 (is_platform_admin
        // not present) or hit a transient PostgREST hiccup. Keep it at
        // debug level so routine non-admin sessions stay silent.
        console.debug(
          '[useIsPlatformAdmin] rpc error — assuming not an admin:',
          error.message ?? error,
        );
        cached = { isPlatformAdmin: false, loading: false };
        setState(cached);
        return;
      }
      cached = { isPlatformAdmin: data === true, loading: false };
      setState(cached);
    };

    void resolve();
    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
