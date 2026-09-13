'use client';

// ============================================================
// PlatformCustomerInvitesClient — the customer-invite manager on
// /platform/customer-invites.
//
// Fetches invites from GET /api/platform/customer-invites, creates
// new ones via POST, and revokes pending ones via DELETE
// /api/platform/customer-invites/[id].
//
// The complete invite link (embedding the one-time token) is returned
// once at creation and shown with a copy button; the bare token is
// never surfaced. Server-side authorization on the APIs is the real
// gate; this UI is a convenience.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  Check,
  ClipboardCopy,
  Loader2,
  MailPlus,
  RefreshCcw,
  ShieldAlert,
  UserPlus,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PlatformCustomerInvite } from '@/types';
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

const STATUS_BADGE: Record<
  PlatformCustomerInvite['status'],
  { label: string; variant: 'secondary' | 'destructive' | 'outline' }
> = {
  pending: { label: 'Pending', variant: 'secondary' },
  accepted: { label: 'Accepted', variant: 'secondary' },
  revoked: { label: 'Revoked', variant: 'outline' },
  expired: { label: 'Expired', variant: 'destructive' },
};

// Distinct badge for a pending invite whose signup has started but is
// not yet confirmed (043 lifecycle). Not a real status value — derived
// from signup_started_at while status stays 'pending'.
function statusOf(inv: PlatformCustomerInvite): {
  label: string;
  variant: 'secondary' | 'destructive' | 'outline';
} {
  const base = STATUS_BADGE[inv.status];
  if (
    inv.status === 'pending' &&
    inv.signup_started_at &&
    !inv.accepted_at
  ) {
    return { label: 'Signup in progress', variant: 'outline' };
  }
  return base;
}

export function PlatformCustomerInvitesClient() {
  const [invites, setInvites] = useState<PlatformCustomerInvite[] | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state.
  const [email, setEmail] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('7');
  const [creating, setCreating] = useState(false);

  // Created invite (holds the one-time complete invite link).
  const [created, setCreated] = useState<{
    email: string;
    inviteUrl: string;
    expiresInDays: number | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Revoke confirmation.
  const [revoking, setRevoking] = useState<PlatformCustomerInvite | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/platform/customer-invites', {
        cache: 'no-store',
      });
      if (res.status === 403) {
        setError('You do not have permission to view this page.');
        setInvites([]);
        return;
      }
      if (!res.ok) {
        setError('Could not load customer invites. Please try again.');
        setInvites([]);
        return;
      }
      const data = (await res.json()) as { invites: PlatformCustomerInvite[] };
      setInvites(data.invites);
    } catch {
      setError('Could not load customer invites. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/platform/customer-invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
        }),
      });
      if (res.status === 403) {
        setError('You do not have permission to do that.');
        setCreating(false);
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(payload.error || 'Could not create the invitation');
        setCreating(false);
        return;
      }
      const data = (await res.json()) as {
        invite: PlatformCustomerInvite;
        inviteUrl: string;
        expiresInDays: number;
      };
      setEmail('');
      setCreated({
        email: data.invite.email,
        inviteUrl: data.inviteUrl,
        expiresInDays: data.expiresInDays,
      });
      setCopied(false);
      await load();
    } catch {
      toast.error('Could not create the invitation');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy the invite link');
    }
  };

  const handleRevoke = async () => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    setBusyId(target.id);
    try {
      const res = await fetch(
        `/api/platform/customer-invites/${target.id}`,
        { method: 'DELETE' },
      );
      if (res.status === 403) {
        toast.error('You must be a platform admin to do that');
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(payload.error || 'Could not revoke the invitation');
        return;
      }
      toast.success('Invitation revoked');
      await load();
    } catch {
      toast.error('Could not revoke the invitation');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-foreground">
          Customer invitations
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Approve email addresses for the invite-only onboarding. Invited
          emails can register a customer account; everyone else is blocked.
        </p>
      </div>

      {/* Create form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <MailPlus className="size-4 text-primary" />
            Invite a customer
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            The invited email address becomes eligible to sign up. The one-time
            token is shown once and never stored in plaintext.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1 flex flex-col gap-2">
              <Label htmlFor="invite-email" className="text-muted-foreground">
                Email
              </Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="customer@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="w-32 flex flex-col gap-2">
              <Label
                htmlFor="invite-expiry"
                className="text-muted-foreground"
              >
                Valid (days)
              </Label>
              <Input
                id="invite-expiry"
                type="number"
                min={1}
                max={365}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <Button
              type="submit"
              disabled={creating || !email.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <UserPlus className="size-4" />
                  Invite
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* List / states */}
      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-16">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm text-muted-foreground">
              Loading invitations…
            </span>
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <ShieldAlert className="h-8 w-8 text-destructive" />
            <p className="text-sm font-medium text-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCcw />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : !invites || invites.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              No customer invitations yet. Invite the first customer above.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((inv) => {
                  const badge = statusOf(inv);
                  return (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium text-foreground">
                        {inv.email}
                      </TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {fmtDate(inv.expires_at)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {fmtDate(inv.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {inv.status === 'pending' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId !== null}
                            onClick={() => setRevoking(inv)}
                          >
                            {busyId === inv.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Ban className="h-3.5 w-3.5" />
                            )}
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableCaption>Platform administration — handle with care.</TableCaption>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* One-time token dialog */}
      <Dialog
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-foreground">
              Invitation created
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {created?.email} can now sign up. Send them this invite
              link — it is only shown once and its token is never stored
              in plaintext.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-3">
            <code className="flex-1 truncate font-mono text-sm text-foreground">
              {created?.inviteUrl}
            </code>
            <Button size="sm" variant="outline" onClick={handleCopy}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <ClipboardCopy className="h-3.5 w-3.5" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreated(null)}
              className="w-full"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-foreground">Revoke invitation?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Revoke the invitation for{' '}
              <span className="text-foreground">{revoking?.email}</span>? That
              email will no longer be able to register.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevoke}>
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
