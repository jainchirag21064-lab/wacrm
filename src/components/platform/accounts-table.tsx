'use client';

// ============================================================
// PlatformAccountsClient — the interactive table on
// /platform/accounts.
//
// Fetches customer accounts from GET /api/platform/accounts and
// exposes suspend / reactivate actions (with confirmation) via
// POST /api/platform/accounts/[id]/suspend | /reactivate.
//
// Renders loading, empty, error, and (defensively) forbidden
// states. Server-side authorization on the APIs is the real gate.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Ban,
  CheckCircle2,
  Loader2,
  MessageCircle,
  RefreshCcw,
  Settings2,
  ShieldAlert,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import type { PlatformAccountListItem } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function PlatformAccountsClient() {
  const t = useTranslations('PlatformAccounts');
  const { accountId } = useAuth();

  const [accounts, setAccounts] = useState<PlatformAccountListItem[] | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pending action confirmation (account id + desired status).
  const [confirming, setConfirming] = useState<{
    account: PlatformAccountListItem;
    targetStatus: 'suspended' | 'active';
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Global default member limit, shown for accounts without an override.
  const [defaultLimit, setDefaultLimit] = useState<number | null>(null);

  // Pending per-account member-limit edit.
  const [editing, setEditing] = useState<{
    account: PlatformAccountListItem;
    useDefault: boolean;
    draft: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/platform/accounts', { cache: 'no-store' });
      if (res.status === 403) {
        setError(t('forbidden'));
        setAccounts([]);
        return;
      }
      if (!res.ok) {
        setError(t('loadFailed'));
        setAccounts([]);
        return;
      }
      const data = (await res.json()) as {
        accounts: PlatformAccountListItem[];
        default_member_limit: number;
      };
      setAccounts(data.accounts);
      setDefaultLimit(data.default_member_limit);
    } catch {
      setError(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (
      account: PlatformAccountListItem,
      status: 'suspended' | 'active'
    ) => {
      setConfirming(null);
      setBusyId(account.id);
      try {
        const action = status === 'suspended' ? 'suspend' : 'reactivate';
        const res = await fetch(
          `/api/platform/accounts/${account.id}/${action}`,
          { method: 'POST' }
        );
        if (res.status === 403) {
          toast.error(t('toastForbidden'));
          return;
        }
        if (res.status === 409) {
          toast.error(t('toastSelfSuspended'));
          return;
        }
        if (!res.ok) {
          toast.error(
            status === 'suspended'
              ? t('toastSuspendFailed')
              : t('toastReactivateFailed')
          );
          return;
        }
        toast.success(
          status === 'suspended' ? t('toastSuspended') : t('toastReactivated')
        );
        // Refresh so the table reflects the new status.
        await load();
      } catch {
        toast.error(
          status === 'suspended'
            ? t('toastSuspendFailed')
            : t('toastReactivateFailed')
        );
      } finally {
        setBusyId(null);
      }
    },
    [t, load]
  );

  const openEditor = useCallback((account: PlatformAccountListItem) => {
    setEditing({
      account,
      useDefault: account.member_limit === null,
      draft: account.member_limit === null ? '' : String(account.member_limit),
    });
  }, []);

  const saveLimit = useCallback(async () => {
    if (!editing) return;
    const { account, useDefault, draft } = editing;

    let limit: number | null = null;
    if (!useDefault) {
      const parsed = Number.parseInt(draft, 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 1000) {
        toast.error(t('invalidLimit'));
        return;
      }
      limit = parsed;
    }

    setBusyId(account.id);
    try {
      const res = await fetch(
        `/api/platform/accounts/${account.id}/member-limit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit }),
        }
      );
      if (res.status === 403) {
        toast.error(t('toastForbidden'));
        return;
      }
      if (!res.ok) {
        toast.error(t('toastLimitFailed'));
        return;
      }
      toast.success(t('toastLimitSaved'));
      setEditing(null);
      await load();
    } catch {
      toast.error(t('toastLimitFailed'));
    } finally {
      setBusyId(null);
    }
  }, [editing, t, load]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-16">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-muted-foreground text-sm">
              {t('loading')}
            </span>
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <ShieldAlert className="text-destructive h-8 w-8" />
            <p className="text-foreground text-sm font-medium">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCcw />
              {t('retry')}
            </Button>
          </CardContent>
        </Card>
      ) : !accounts || accounts.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('tableTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colAccount')}</TableHead>
                  <TableHead>{t('colOwner')}</TableHead>
                  <TableHead>{t('colMembers')}</TableHead>
                  <TableHead>{t('colLimit')}</TableHead>
                  <TableHead>{t('colWhatsApp')}</TableHead>
                  <TableHead>{t('colStatus')}</TableHead>
                  <TableHead>{t('colCreated')}</TableHead>
                  <TableHead className="text-right">
                    {t('colActions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => {
                  const suspended = a.status === 'suspended';
                  const isOwn = a.id === accountId;
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="max-w-56">
                        <span
                          className="block truncate font-medium"
                          title={a.name}
                        >
                          {a.name}
                        </span>
                        {isOwn && (
                          <span className="text-muted-foreground text-xs">
                            {t('ownAccount')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="block">{a.owner_name}</span>
                        <span className="text-muted-foreground block max-w-56 truncate text-xs">
                          {a.owner_email}
                        </span>
                      </TableCell>
                      <TableCell>{a.member_count}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-auto gap-1 px-1 py-0.5"
                          disabled={busyId !== null}
                          title={t('setLimit')}
                          onClick={() => openEditor(a)}
                        >
                          {a.member_limit ?? defaultLimit ?? 3}
                          {a.member_limit === null && (
                            <span className="text-muted-foreground text-xs">
                              ({t('defaultLimit')})
                            </span>
                          )}
                          <Settings2 className="h-3.5 w-3.5" />
                        </Button>
                        {a.member_count >
                          (a.member_limit ?? defaultLimit ?? 3) && (
                          <span className="text-destructive text-xs">
                            {t('overLimit')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {a.whatsapp_configured ? (
                          <Badge variant="secondary">
                            <MessageCircle />
                            {t('whatsappConfigured')}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            {t('whatsappNotConfigured')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {suspended ? (
                          <Badge variant="destructive">
                            <Ban />
                            {t('statusSuspended')}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            <CheckCircle2 />
                            {t('statusActive')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {fmtDate(a.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {suspended ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId !== null}
                            onClick={() =>
                              setConfirming({
                                account: a,
                                targetStatus: 'active',
                              })
                            }
                          >
                            {busyId === a.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            {t('reactivate')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busyId !== null || isOwn}
                            title={isOwn ? t('ownAccount') : undefined}
                            onClick={() =>
                              setConfirming({
                                account: a,
                                targetStatus: 'suspended',
                              })
                            }
                          >
                            {busyId === a.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            {t('suspend')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableCaption>{t('tableCaption')}</TableCaption>
            </Table>
          </CardContent>
        </Card>
      )}

      {confirming ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {confirming.targetStatus === 'suspended'
                  ? t('confirmSuspendTitle')
                  : t('confirmReactivateTitle')}
              </DialogTitle>
              <DialogDescription>
                {confirming.targetStatus === 'suspended'
                  ? t('confirmSuspendBody', { name: confirming.account.name })
                  : t('confirmReactivateBody', {
                      name: confirming.account.name,
                    })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant={
                  confirming.targetStatus === 'suspended'
                    ? 'destructive'
                    : 'default'
                }
                onClick={() =>
                  void run(confirming.account, confirming.targetStatus)
                }
              >
                {confirming.targetStatus === 'suspended'
                  ? t('confirmSuspend')
                  : t('confirmReactivate')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {editing ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('editLimitTitle', { name: editing.account.name })}
              </DialogTitle>
              <DialogDescription>{t('editLimitDesc')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={editing.useDefault}
                  onChange={(e) =>
                    setEditing({ ...editing, useDefault: e.target.checked })
                  }
                />
                {t('useDefault', { limit: defaultLimit ?? 3 })}
              </label>
              {!editing.useDefault && (
                <div className="space-y-1.5">
                  <Label htmlFor="limit-input">{t('limitLabel')}</Label>
                  <Input
                    id="limit-input"
                    type="number"
                    min={0}
                    max={1000}
                    value={editing.draft}
                    onChange={(e) =>
                      setEditing({ ...editing, draft: e.target.value })
                    }
                  />
                </div>
              )}
              <p className="text-muted-foreground text-xs">
                {editing.useDefault ? t('useDefaultHint') : t('limitHint')}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={busyId !== null}
                onClick={() => void saveLimit()}
              >
                {busyId === editing.account.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
