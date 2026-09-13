'use client';

// ============================================================
// usePendingAccessRequests — count of PENDING "Request Access"
// submissions, shown as a badge on the platform sidebar.
//
// Purely cosmetic: it only surfaces a visual cue. Authorization to
// read the actual list is enforced server-side on every
// /api/platform/access-requests* route via requirePlatformAdmin().
// ============================================================

import { useEffect, useState } from 'react';

export function usePendingAccessRequests(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/platform/access-requests/pending-count', {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { count: number };
        if (!cancelled) setCount(data.count ?? 0);
      } catch {
        // Ignore network failures — the badge is cosmetic.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}
