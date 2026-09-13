"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    // Production only. In development the service worker would control
    // every navigation, including HMR reloads and the auth redirect
    // boundary, which makes the app appear to briefly hang or crash
    // during login/logout. The cached TWA shell matters only for the
    // real build, so skip registration entirely in dev.
    if (process.env.NODE_ENV !== "production") return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failed — non-critical, app still works
      });
    }
  }, []);

  return null;
}