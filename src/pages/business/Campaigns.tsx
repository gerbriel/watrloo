import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import {
  createCampaign,
  listCampaigns,
  submitCampaign,
} from '@/lib/api/growth';
import type { AdCampaign } from '@/lib/api/growth';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';

const STATUS_STYLE: Record<AdCampaign['status'], string> = {
  draft: 'text-muted',
  pending_review: 'text-amber-500',
  approved: 'text-flush-500',
  running: 'text-green-500',
  paused: 'text-muted',
  done: 'text-muted',
  rejected: 'text-red-500',
};

function CampaignRow({
  c,
  onSubmit,
  submitting,
}: {
  c: AdCampaign;
  onSubmit: () => void;
  submitting: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sunken px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-muted">
            {c.type === 'in_app_blast' ? 'Message blast' : 'Featured'}
          </span>
          <span className={`text-xs font-medium capitalize ${STATUS_STYLE[c.status]}`}>
            {c.status.replace('_', ' ')}
          </span>
        </div>
        <p className="mt-1 truncate text-sm font-semibold text-app">
          {c.creative.title ?? '(untitled)'}
        </p>
        {c.creative.body && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted">{c.creative.body}</p>
        )}
        {c.status === 'rejected' && c.reject_reason && (
          <p className="mt-1 text-xs text-red-500">Rejected: {c.reject_reason}</p>
        )}
      </div>
      {(c.status === 'draft' || c.status === 'rejected') && (
        <Button size="sm" variant="secondary" onClick={onSubmit} loading={submitting}>
          Submit for review
        </Button>
      )}
    </div>
  );
}

export function Campaigns() {
  const { businessId = '' } = useParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [type, setType] = useState<'in_app_blast' | 'featured'>('in_app_blast');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: campaigns, isPending } = useQuery({
    queryKey: queryKeys.campaigns(businessId),
    queryFn: () => listCampaigns(businessId),
    enabled: businessId !== '' && !!user,
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.campaigns(businessId) });
  }

  async function onCreate() {
    if (!title.trim() || !body.trim()) {
      setError('A title and message are required.');
      return;
    }
    setBusy('create');
    setError(null);
    try {
      await createCampaign({
        businessId,
        type,
        creative: { title: title.trim(), body: body.trim(), link: link.trim() || undefined },
        region: region.trim() || undefined,
        surface: type === 'featured' ? 'browse' : undefined,
      });
      setTitle('');
      setBody('');
      setLink('');
      setRegion('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the campaign.');
    } finally {
      setBusy(null);
    }
  }

  async function onSubmitCampaign(id: string) {
    setBusy(id);
    setError(null);
    try {
      await submitCampaign(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit. Check your plan limits.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-app">
          Campaigns
        </h1>
        <p className="mt-1 text-sm text-muted">
          Reach opted-in users near your listings with an in-app message, or buy a
          featured placement. Every campaign is reviewed before it runs, and
          users see at most 3 promotions a week.
        </p>
      </div>

      <section className="flex flex-col gap-4 rounded-xl border border-app bg-raised p-5">
        <h2 className="text-sm font-semibold text-app">New campaign</h2>
        <div className="flex gap-2">
          {(['in_app_blast', 'featured'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                type === t
                  ? 'border-flush-500 bg-flush-600/10 text-app'
                  : 'border-app text-muted hover:text-app'
              }`}
            >
              {t === 'in_app_blast' ? 'Message blast' : 'Featured placement'}
            </button>
          ))}
        </div>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea
          label="Message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          hint="Keep it honest and specific. Reviewed before it runs."
        />
        <Input
          label="Link (optional)"
          type="url"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <Input
          label="Target region (optional)"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          hint="City or region name. Blank targets everyone opted-in."
        />
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <Button onClick={() => void onCreate()} loading={busy === 'create'} className="w-fit">
          Create draft
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-app">Your campaigns</h2>
        {isPending && <div className="h-20 animate-pulse rounded-xl border border-app bg-raised" />}
        {campaigns && campaigns.length === 0 && (
          <p className="rounded-xl border border-dashed border-app bg-raised px-4 py-8 text-center text-sm text-muted">
            No campaigns yet.
          </p>
        )}
        {campaigns?.map((c) => (
          <CampaignRow
            key={c.id}
            c={c}
            submitting={busy === c.id}
            onSubmit={() => void onSubmitCampaign(c.id)}
          />
        ))}
      </section>
    </div>
  );
}
