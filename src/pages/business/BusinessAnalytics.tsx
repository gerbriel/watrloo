import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { getBathroom, listBusinessListings } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import type { BathroomWithStats, ClaimedListing } from '@/types/db';
import { Stars } from '@/components/ui/Stars';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/** A single headline number with a caption, laid out as a card in the KPI grid. */
function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-app bg-raised p-4">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="text-2xl font-bold text-app">{value}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

/** A small pill used to flag the best/worst listing in the ranked bar list. */
function Flag({ tone, children }: { tone: 'good' | 'warn'; children: string }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'good'
          ? 'bg-flush-500/10 text-flush-600'
          : 'bg-red-500/10 text-red-500',
      )}
    >
      {children}
    </span>
  );
}

/**
 * One row of the ranked list: the listing's name, its average rating, a CSS bar
 * scaled to rating/5, and its review count. Unrated listings render an empty
 * track so the eye can still tell them apart from a genuine one-star.
 */
function ListingBar({
  listing,
  isBest,
  isWorst,
}: {
  listing: BathroomWithStats;
  isBest: boolean;
  isWorst: boolean;
}) {
  const { stats } = listing;
  const rated = stats.review_count > 0 && stats.avg_rating != null;
  const rating = stats.avg_rating ?? 0;
  const pct = rated ? (rating / 5) * 100 : 0;

  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-xl border bg-raised p-4',
        isBest ? 'border-flush-500' : isWorst ? 'border-red-500/40' : 'border-app',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to={`/bathrooms/${listing.id}`}
          className="text-sm font-medium text-app hover:text-flush-600 hover:underline"
        >
          {listing.name}
        </Link>
        <div className="flex items-center gap-2">
          {isBest && <Flag tone="good">Top rated</Flag>}
          {isWorst && <Flag tone="warn">Lowest</Flag>}
          {rated ? (
            <span className="flex items-center gap-1.5">
              <Stars value={rating} size={14} />
              <span className="text-sm font-semibold text-app">
                {rating.toFixed(1)}
              </span>
            </span>
          ) : (
            <span className="text-xs text-muted">No reviews yet</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-sunken"
          role="img"
          aria-label={rated ? `${rating.toFixed(1)} out of 5` : 'No rating yet'}
        >
          <div
            className={cn('h-full rounded-full', rated && 'bg-flush-500')}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-20 shrink-0 text-right text-xs text-muted">
          {stats.review_count} review{stats.review_count === 1 ? '' : 's'}
        </span>
      </div>
    </li>
  );
}

export function BusinessAnalytics() {
  const { businessId } = useParams<{ businessId: string }>();

  // One query does the whole fan-out: list the business's claims, keep only the
  // verified ones (claimed/pending confer no ownership yet), then pull each
  // bathroom's aggregated stats in parallel. Keyed off the listings key so a
  // claim change invalidates this view too.
  const query = useQuery({
    queryKey: [...queryKeys.businessListings(businessId ?? ''), 'analytics'],
    enabled: Boolean(businessId),
    queryFn: async (): Promise<BathroomWithStats[]> => {
      const claims: ClaimedListing[] = await listBusinessListings(businessId ?? '');
      const verified = claims.filter((c) => c.status === 'verified');
      const detailed = await Promise.all(
        verified.map((c) => getBathroom(c.bathroom.id)),
      );
      return detailed.filter((b): b is BathroomWithStats => b !== null);
    },
  });

  const listings = useMemo(() => query.data ?? [], [query.data]);

  const derived = useMemo(() => {
    const sorted = [...listings].sort(
      (a, b) => (b.stats.avg_rating ?? -1) - (a.stats.avg_rating ?? -1),
    );
    const rated = sorted.filter(
      (l) => l.stats.review_count > 0 && l.stats.avg_rating != null,
    );
    const totalReviews = listings.reduce((sum, l) => sum + l.stats.review_count, 0);
    // Weighted by review count so a busy listing pulls the average more than a
    // single-review one — the honest "overall" a business owner expects.
    const overall =
      rated.length > 0
        ? rated.reduce(
            (sum, l) => sum + (l.stats.avg_rating as number) * l.stats.review_count,
            0,
          ) / totalReviews
        : null;

    return {
      sorted,
      totalReviews,
      overall,
      noReviews: listings.length - rated.length,
      bestId: rated[0]?.id ?? null,
      worstId: rated.length > 1 ? rated[rated.length - 1].id : null,
    };
  }, [listings]);

  if (!businessId) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-sm text-red-500">No business selected.</p>
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-raised" />
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl border border-app bg-raised"
            />
          ))}
        </div>
        <div className="mt-6 h-40 animate-pulse rounded-xl border border-app bg-raised" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-start gap-3 px-4 py-8">
        <p className="text-sm text-red-500">
          {query.error instanceof Error
            ? query.error.message
            : 'Could not load analytics.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold text-app">Analytics</h1>
        <p className="mt-1 text-sm text-muted">
          Review performance across your verified listings.
        </p>
      </header>

      {listings.length === 0 ? (
        <div className="rounded-xl border border-app bg-raised p-8 text-center">
          <p className="font-medium text-app">No verified listings yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Once a claim on one of your bathrooms is verified, its review
            performance will show up here.
          </p>
          <Link
            to={`/business/${businessId}`}
            className="mt-4 inline-block text-sm font-medium text-flush-600 hover:underline"
          >
            Back to dashboard →
          </Link>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Verified listings" value={String(listings.length)} />
            <Kpi label="Total reviews" value={String(derived.totalReviews)} />
            <Kpi
              label="Overall rating"
              value={derived.overall != null ? derived.overall.toFixed(1) : '—'}
              hint={derived.overall != null ? 'weighted by reviews' : 'no reviews yet'}
            />
            <Kpi
              label="Awaiting reviews"
              value={String(derived.noReviews)}
              hint="listings with none"
            />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-app">Listings by rating</h2>
            <ul className="flex flex-col gap-3">
              {derived.sorted.map((listing) => (
                <ListingBar
                  key={listing.id}
                  listing={listing}
                  isBest={listing.id === derived.bestId}
                  isWorst={listing.id === derived.worstId}
                />
              ))}
            </ul>
          </section>
        </>
      )}

      <section className="rounded-xl border border-dashed border-app bg-sunken p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Coming with the full plan
        </p>
        <p className="mt-2 text-sm text-muted">
          Listing impressions, “near me” appearances, and direction taps. We
          don’t collect that telemetry yet — it lands with the paid analytics
          add-on.
        </p>
      </section>
    </div>
  );
}
