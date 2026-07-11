import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listMyMessages, markMessageRead } from '@/lib/api/growth';
import type { InAppMessage } from '@/lib/api/growth';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from '@/auth/AuthProvider';

/**
 * The in-app message center — the delivery surface for promotional blasts and
 * the newsletter. A message is a `campaign_sends` row the recipient owns; there
 * is no email channel. Every message is visibly labeled as promotional.
 */

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function MessageCard({ m, onRead }: { m: InAppMessage; onRead: () => void }) {
  const unread = m.read_at === null;
  return (
    <article
      className={`rounded-xl border p-4 transition-colors ${
        unread ? 'border-flush-500/40 bg-raised' : 'border-app bg-surface'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {unread && (
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-flush-500" />
          )}
          <span className="truncate text-sm font-semibold text-app">
            {m.business_name}
          </span>
          <span className="shrink-0 rounded-full border border-app px-2 py-0.5 text-[0.65rem] uppercase tracking-wide text-muted">
            Promotion
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted">{timeAgo(m.created_at)}</span>
      </div>

      {m.creative.title && (
        <h3 className="mt-2 text-base font-semibold text-app">{m.creative.title}</h3>
      )}
      {m.creative.body && (
        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted">
          {m.creative.body}
        </p>
      )}

      <div className="mt-3 flex items-center gap-4">
        {m.creative.link && (
          <a
            href={m.creative.link}
            target="_blank"
            rel="noreferrer nofollow sponsored"
            className="text-sm font-medium text-flush-500 hover:underline"
            onClick={onRead}
          >
            View offer
          </a>
        )}
        {unread && (
          <button
            onClick={onRead}
            className="text-xs text-muted hover:text-app hover:underline"
          >
            Mark as read
          </button>
        )}
      </div>
    </article>
  );
}

export function MessagesPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? '';

  const { data: messages, isPending, isError, refetch } = useQuery({
    queryKey: queryKeys.myMessages(userId),
    queryFn: listMyMessages,
    enabled: userId !== '',
  });

  async function read(sendId: string) {
    await markMessageRead(sendId).catch(() => {});
    await queryClient.invalidateQueries({ queryKey: queryKeys.myMessages(userId) });
  }

  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight text-app">
        Messages
      </h1>
      <p className="mt-1 text-sm text-muted">
        Offers and updates from businesses you've chosen to hear from. Manage this
        in{' '}
        <Link to="/profile" className="text-flush-500 hover:underline">
          your profile
        </Link>
        .
      </p>

      <div className="mt-6 flex flex-col gap-3">
        {isPending && (
          <div className="h-28 animate-pulse rounded-xl border border-app bg-raised" />
        )}
        {isError && (
          <div className="rounded-xl border border-app bg-raised p-6 text-center">
            <p className="text-sm text-muted">Couldn’t load your messages.</p>
            <button
              onClick={() => void refetch()}
              className="mt-2 text-sm font-medium text-flush-500 hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        {messages && messages.length === 0 && (
          <div className="rounded-xl border border-dashed border-app bg-raised px-6 py-14 text-center">
            <p className="font-medium text-app">No messages</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
              When you opt in to promotional messages, offers from local
              businesses land here — never in your email.
            </p>
          </div>
        )}
        {messages?.map((m) => (
          <MessageCard key={m.send_id} m={m} onRead={() => void read(m.send_id)} />
        ))}
      </div>
    </div>
  );
}
