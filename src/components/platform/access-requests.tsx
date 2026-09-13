'use client';

// ============================================================
// PlatformAccessRequestsClient — the "Request Access" review queue on
// /platform/access-requests.
//
// Lists public submissions with status filters + search + pagination,
// and lets a platform admin approve / reject / mark-spam each one.
// Approving generates a platform customer invitation and returns its
// COMPLETE URL, which the admin copies. The raw token is never shown.
// Safe display: all user-supplied fields render through React escaping.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  Check,
  ClipboardCopy,
  Inbox,
  Loader2,
  RefreshCcw,
  Search,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { SignupRequest, SignupRequestStatus } from '@/types';

type StatusFilter = SignupRequestStatus | 'all';

const STATUS_FILTERS: StatusFilter[] = [
  'pending',
  'approved',
  'rejected',
  'converted',
  'spam',
];

const STATUS_META: Record<
  SignupRequestStatus,
  { label: string; variant: 'secondary' | 'destructive' | 'outline' | 'default' }
> = {
  pending: { label: 'Pending', variant: 'secondary' },
  approved: { label: 'Approved', variant: 'default' },
  rejected: { label: 'Rejected', variant: 'destructive' },
  converted: { label: 'Converted', variant: 'secondary' },
  spam: { label: 'Spam', variant: 'outline' },
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PAGE_SIZE = 10;

interface ListResponse {
  requests: SignupRequest[];
  total: number;
  page: number;
  page_size: number;
}

export function PlatformAccessRequestsClient() {
  const [requests, setRequests] = useState<SignupRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog states.
  const [detail, setDetail] = useState<SignupRequest | null>(null);
  const [rejecting, setRejecting] = useState<SignupRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [confirmSpam, setConfirmSpam] = useState<SignupRequest | null>(null);
  const [approveTarget, setApproveTarget] = useState<SignupRequest | null>(null);
  const [approving, setApproving] = useState(false);
  const [approvedUrl, setApprovedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = useCallback(
    async (opts: { page?: number; status?: StatusFilter; search?: string } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const p = opts.page ?? page;
        const s = opts.status ?? status;
        const q = opts.search ?? search;
        const params = new URLSearchParams({
          page: String(p),
          page_size: String(PAGE_SIZE),
          status: s === 'all' ? 'pending' : s,
        });
        if (q) params.set('search', q);
        const res = await fetch(`/api/platform/access-requests?${params}`, {
          cache: 'no-store',
        });
        if (res.status === 403) {
          setError('You do not have permission to view this page.');
          setRequests([]);
          setTotal(0);
          return;
        }
        if (!res.ok) {
          setError('Could not load access requests. Please try again.');
          setRequests([]);
          setTotal(0);
          return;
        }
        const data = (await res.json()) as ListResponse;
        setRequests(data.requests);
        setTotal(data.total);
        setPage(data.page);
      } catch {
        setError('Could not load access requests. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [page, status, search],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilter = (s: StatusFilter) => {
    setStatus(s);
    setPage(1);
    void load({ page: 1, status: s, search });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput);
    void load({ page: 1, status, search: searchInput });
  };

  const handleApprove = async () => {
    if (!approveTarget) return;
    setApproving(true);
    try {
      const res = await fetch(
        `/api/platform/access-requests/${approveTarget.id}/approve`,
        { method: 'POST' },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        inviteUrl?: string;
      };
      if (res.status === 403) {
        toast.error('You must be a platform admin to do that');
        return;
      }
      if (!res.ok || !payload.inviteUrl) {
        toast.error(payload.error || 'Could not approve the request');
        return;
      }
      setApprovedUrl(payload.inviteUrl);
      toast.success('Request approved');
      await load();
    } catch {
      toast.error('Could not approve the request');
    } finally {
      setApproving(false);
      setApproveTarget(null);
    }
  };

  const handleReject = async () => {
    if (!rejecting) return;
    const target = rejecting;
    setActioningId('reject');
    try {
      const res = await fetch(
        `/api/platform/access-requests/${target.id}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rejection_reason: rejectReason.trim() || undefined,
          }),
        },
      );
      if (res.status === 403) {
        toast.error('You must be a platform admin to do that');
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(payload.error || 'Could not reject the request');
        return;
      }
      toast.success('Request rejected');
      setRejectReason('');
      setRejecting(null);
      await load();
    } catch {
      toast.error('Could not reject the request');
    } finally {
      setActioningId(null);
    }
  };

  const handleSpam = async () => {
    if (!confirmSpam) return;
    const target = confirmSpam;
    setConfirmSpam(null);
    setActioningId('spam');
    try {
      const res = await fetch(
        `/api/platform/access-requests/${target.id}/spam`,
        { method: 'POST' },
      );
      if (res.status === 403) {
        toast.error('You must be a platform admin to do that');
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(payload.error || 'Could not mark as spam');
        return;
      }
      toast.success('Request marked as spam');
      await load();
    } catch {
      toast.error('Could not mark as spam');
    } finally {
      setActioningId(null);
    }
  };

  const handleCopyUrl = async () => {
    if (!approvedUrl) return;
    try {
      await navigator.clipboard.writeText(approvedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy the invite link');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Access requests</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review “Request Access” submissions. Approving sends a secure
          invite link to the requester&apos;s email — approval only creates an
          invitation; it never creates an account directly.
        </p>
      </div>

      {/* Status filters + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={status === 'all' ? 'default' : 'outline'}
            onClick={() => handleFilter('all')}
          >
            All
          </Button>
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? 'default' : 'outline'}
              onClick={() => handleFilter(s)}
              className="capitalize"
            >
              {s}
            </Button>
          ))}
        </div>
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <Input
            type="search"
            placeholder="Search name, email, company…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-64 bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <Button type="submit" size="icon" variant="outline">
            <Search className="h-4 w-4" />
          </Button>
        </form>
      </div>

      {/* List */}
      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-16">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm text-muted-foreground">
              Loading requests…
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
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No {status === 'all' ? '' : `${status} `}requests{status === 'all' ? ' at all' : ''} match this view.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => {
            const meta = STATUS_META[req.status];
            return (
              <Card key={req.id}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <button
                    type="button"
                    onClick={() => setDetail(req)}
                    className="flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {req.full_name}
                      </span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {req.email}
                      {req.company_name ? ` · ${req.company_name}` : ''}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Submitted {fmtDate(req.created_at)}
                      {req.referral_code ? ` · ref: ${req.referral_code}` : ''}
                    </div>
                  </button>
                  <div className="flex shrink-0 gap-2">
                    {req.status === 'pending' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => setApproveTarget(req)}
                          disabled={actioningId !== null}
                        >
                          <ThumbsUp className="size-3.5" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setRejecting(req)}
                          disabled={actioningId !== null}
                        >
                          <ThumbsDown className="size-3.5" />
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmSpam(req)}
                          disabled={actioningId !== null}
                        >
                          <Ban className="size-3.5" />
                          Spam
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {!loading && !error && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              const next = page - 1;
              setPage(next);
              void load({ page: next });
            }}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              const next = page + 1;
              setPage(next);
              void load({ page: next });
            }}
          >
            Next
          </Button>
        </div>
      )}

      {/* Detail dialog */}
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-foreground">{detail?.full_name}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {detail?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-muted-foreground">Company: </span>
              <span className="text-foreground">{detail?.company_name || '—'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Referral code: </span>
              <span className="text-foreground">{detail?.referral_code || '—'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Message: </span>
              <p className="mt-1 whitespace-pre-wrap text-foreground">
                {detail?.message || '—'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Status: </span>
              <span className="capitalize text-foreground">{detail?.status}</span>
            </div>
            {detail?.rejection_reason && (
              <div>
                <span className="text-muted-foreground">Rejection reason: </span>
                <span className="text-foreground">{detail.rejection_reason}</span>
              </div>
            )}
            {detail?.reviewed_at && (
              <div className="text-muted-foreground">
                Reviewed {fmtDate(detail.reviewed_at)}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve confirmation + resulting invite URL */}
      <Dialog
        open={approveTarget !== null || approvedUrl !== null}
        onOpenChange={(o) => {
          if (!o) {
            setApproveTarget(null);
            setApprovedUrl(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent>
          {approvedUrl ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-foreground">
                  Invitation ready
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Send this complete signup link to the requester. It is only
                  shown once — the raw token is never exposed.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-3">
                <code className="flex-1 truncate font-mono text-sm text-foreground">
                  {approvedUrl}
                </code>
                <Button size="sm" variant="outline" onClick={handleCopyUrl}>
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
                  onClick={() => {
                    setApprovedUrl(null);
                    setCopied(false);
                  }}
                  className="w-full"
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-foreground">
                  Approve access for {approveTarget?.email}?
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  This creates a secure platform invitation link (valid 7 days)
                  for that email. It does not create an account directly.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setApproveTarget(null)}>
                  Cancel
                </Button>
                <Button onClick={handleApprove} disabled={approving}>
                  {approving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Approving…
                    </>
                  ) : (
                    'Approve'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-foreground">
              Reject access request
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Optionally record a reason (shown on the request).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reject-reason" className="text-muted-foreground">
              Reason
            </Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="e.g. Not our target customer"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Spam confirmation */}
      <Dialog
        open={confirmSpam !== null}
        onOpenChange={(o) => !o && setConfirmSpam(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-foreground">
              Mark as spam?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Mark the request from {confirmSpam?.email} as spam. It will no
              longer appear in the pending queue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSpam(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleSpam}>
              Mark spam
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
