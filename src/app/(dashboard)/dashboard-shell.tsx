'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban, UserX } from 'lucide-react';
import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { AccountAccessAlert } from '@/components/layout/account-access-alert';
import { PresenceHeartbeat } from '@/components/presence/presence-heartbeat';

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function SuspendedScreen() {
  const t = useTranslations('SuspendedAccount');
  const { signOut } = useAuth();
  return (
    <div className="bg-background flex h-screen items-center justify-center p-4">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="bg-destructive/10 text-destructive flex h-12 w-12 items-center justify-center rounded-full">
          <Ban className="h-6 w-6" />
        </div>
        <h1 className="text-foreground text-xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-primary mt-2 text-sm font-medium hover:underline"
        >
          {t('signOut')}
        </button>
      </div>
    </div>
  );
}

function DeactivatedScreen() {
  const t = useTranslations('DeactivatedAccount');
  const { signOut } = useAuth();
  return (
    <div className="bg-background flex h-screen items-center justify-center p-4">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="bg-muted text-muted-foreground flex h-12 w-12 items-center justify-center rounded-full">
          <UserX className="h-6 w-6" />
        </div>
        <h1 className="text-foreground text-xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-primary mt-2 text-sm font-medium hover:underline"
        >
          {t('signOut')}
        </button>
      </div>
    </div>
  );
}

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const {
    user,
    loading,
    profileLoading,
    accountStatus,
    account,
    isSuspended,
    isDeactivated,
  } = useAuth();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      // Full-page navigation, not router.push. The middleware decides
      // /login ↔ /dashboard from the CURRENT request cookies, so a soft
      // client-side nav that races a session write/clear (right after
      // sign-in or sign-out) can carry stale cookie state into the
      // middleware and get bounced back — a visible ERR_TOO_MANY_REDIRECTS
      // flash that only settles once the cookies do (issue #365). A full
      // load re-derives state from the cookies on each hop, so the chain
      // cannot ping-pong.
      window.location.assign('/login');
    }
  }, [user, loading]);

  // The Supabase session resolves before the profile/account lookup. Keep the
  // dashboard hidden until that second phase is complete so a suspended
  // account cannot briefly render the normal app after login or refresh.
  const accountResolutionPending =
    profileLoading ||
    accountStatus === 'loading' ||
    (accountStatus === 'ready' && !account);

  if (loading || accountResolutionPending) {
    return (
      <div className="bg-background flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="border-primary h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" />
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Suspended accounts get a full-screen blocked state instead of the
  // dashboard. Signing out stays available so the user can leave.
  if (isSuspended) {
    return <SuspendedScreen />;
  }

  // Deactivated members (migration 045) are locked out of the app the
  // same way — every account-scoped RLS policy rejects them, so without
  // a screen this renders an empty dashboard that saves nothing.
  if (isDeactivated) {
    return <DeactivatedScreen />;
  }

  return (
    <div className="bg-background flex h-screen overflow-hidden">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {children}
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
