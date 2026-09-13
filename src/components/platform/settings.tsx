'use client';

// ============================================================
// PlatformSettingsClient — /platform/settings.
//
// Lets a platform admin view/edit product-wide configuration via
// GET/POST /api/platform/config/member-limit. Server-side
// authorization on the API is the real gate; this UI is a
// convenience.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Save, Settings2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const MIN_LIMIT = 0;
const MAX_LIMIT = 1000;

export function PlatformSettingsClient() {
  const t = useTranslations('PlatformSettings');

  const [limit, setLimit] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/platform/config/member-limit', {
        cache: 'no-store',
      });
      if (res.status === 403) {
        toast.error(t('forbidden'));
        return;
      }
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { limit: number };
      setLimit(data.limit);
      setDraft(String(data.limit));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = Number(draft);
  const draftValid =
    draft.trim() !== '' &&
    Number.isInteger(parsed) &&
    parsed >= MIN_LIMIT &&
    parsed <= MAX_LIMIT;

  async function handleSave() {
    if (!draftValid || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/platform/config/member-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: parsed }),
      });
      if (res.status === 403) {
        toast.error(t('forbidden'));
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      setLimit(parsed);
      toast.success(t('savedToast'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <div>
        <h1 className="text-foreground flex items-center gap-2 text-lg font-semibold">
          <Settings2 className="text-muted-foreground size-4" />
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('memberLimitLabel')}</CardTitle>
          <CardDescription>{t('memberLimitHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-xs items-center gap-2">
            <Input
              type="number"
              min={MIN_LIMIT}
              max={MAX_LIMIT}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave();
              }}
              placeholder={limit?.toString()}
            />
            <Button
              onClick={() => void handleSave()}
              disabled={!draftValid || saving}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {t('save')}
            </Button>
          </div>
          {!draftValid && draft.trim() !== '' && (
            <p className="text-destructive mt-2 text-xs">{t('invalidLimit')}</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
