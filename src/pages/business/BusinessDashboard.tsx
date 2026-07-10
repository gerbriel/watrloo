import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type {
  ClaimStatus,
  ClaimedListing,
  MyBusiness,
  SubscriptionStatus,
} from '@/types/db';
import { listBusinessListings, listMyBusinesses } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

const CHIP_BASE = 'inline-block rounded-full px-2 py-0.5 text-xs font-medium';

// Per the spec, active and trialing both read as "healthy" green.
const SUB_CHIP: Record<SubscriptionStatus, string> = {
  active: 'bg-green-500/15 text-green-600',
  trialing: 'bg-green-500/15 text-green-600',
  past_due: 'bg-amber-500/15 text-amber-600',
  canceled: 'bg-red-500/15 text-red-600',
};
const SUB_LABEL: Record<SubscriptionStatus, string> = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  canceled: 'Canceled',
};

const LISTING_CHIP: Record<ClaimStatus, string> = {
  verified: 'bg-green-500/15 text-green-600',
  pending: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
};
const LISTING_LABEL: Record<ClaimStatus, string> = {
  verified: 'Verified',
  pending: 'Pending',
  rejected: 'Rejected',
};

function SubscriptionChip({ status }: { status: SubscriptionStatus | null }) {
  if (status == null) {
    return (
      <span className={cn(CHIP_BASE, 'bg-sunken text-muted')}>No plan</span>
    );
  }
  return <span className={cn(CHIP_BASE, SUB_CHIP[status])}>{SUB_LABEL[status]}</span>;
}

/** One claimed bathroom, as a compact row under its business. */
function ListingRow({ listing }: { listing: ClaimedListing }) {
  const { bathroom, status } = listing;
  return (
    <li className="flex items-center gap-3 rounded-xl border border-app bg-raised px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-app">{bathroom.name}</p>
        <p className="truncate text-xs text-muted">{bathroom.address}</p>
      </div>
      <span className={cn(CHIP_BASE, LISTING_CHIP[status])}>{LISTING_LABEL[status]}</span>
      <Link
        to={`/business/listings/${bathroom.id}`}
        className="shrink-0 text-sm font-medium text-flush-600 hover:underline"
      >
        Manage
      </Link>
    </li>
  );
}

/** Runs its own query for one business's claimed listings to keep hooks flat. */
function BusinessListings({ businessId }: { businessId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.businessListings(businessId),
    queryFn: () => listBusinessListings(businessId),
  });

  if (isPending) {
    return <p className="text-sm text-muted">Loading locations…</p>;
  }
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load locations.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted">
        No locations claimed yet — claim one from its page, or Import a CSV.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {data.map((listing) => (
        <ListingRow key={listing.claim_id} listing={listing} />
      ))}
    </ul>
  );
}

/** A single owned business: header, plan chip, role, quick links, listings. */
function BusinessCard({ business }: { business: MyBusiness }) {
  const links: { label: string; to: string }[] = [
    { label: 'Import CSV', to: '/business/import' },
    { label: 'Team', to: `/business/${business.id}/members` },
    { label: 'Analytics', to: `/business/${business.id}/analytics` },
    { label: 'Settings', to: `/business/${business.id}/settings` },
  ];

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-app bg-raised p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {business.logo_url && (
            <img
              src={business.logo_url}
              alt=""
              className="size-9 shrink-0 rounded-lg object-cover"
            />
          )}
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-app">{business.name}</h2>
            <p className="text-xs capitalize text-muted">Your role: {business.role}</p>
          </div>
        </div>
        <SubscriptionChip status={business.subscription?.status ?? null} />
      </div>

      <nav className="flex flex-wrap gap-x-4 gap-y-1 border-t border-app pt-3">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="text-sm font-medium text-flush-600 hover:underline"
          >
            {l.label}
          </Link>
        ))}
      </nav>

      <BusinessListings businessId={business.id} />
    </section>
  );
}

export function BusinessDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // RequireAuth guarantees a user, but this keeps the types honest.
  const userId = user?.id ?? '';

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.myBusinesses(userId),
    queryFn: () => listMyBusinesses(userId),
    enabled: userId !== '',
  });

  if (!user) return null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold text-app">Your businesses</h1>

      {isPending && <p className="text-sm text-muted">Loading your businesses…</p>}

      {isError && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-red-500">
            {error instanceof Error ? error.message : 'Could not load your businesses.'}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}

      {data && data.length === 0 && (
        <div className="flex flex-col items-start gap-4 rounded-xl border border-app bg-raised p-6">
          <p className="text-sm text-muted">You don't manage any businesses yet.</p>
          <Button onClick={() => navigate('/business/request')}>
            Request business access
          </Button>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="flex flex-col gap-6">
          {data.map((business) => (
            <BusinessCard key={business.id} business={business} />
          ))}
        </div>
      )}
    </div>
  );
}
