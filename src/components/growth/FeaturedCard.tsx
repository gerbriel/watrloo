import { Link } from 'react-router-dom';
import type { AdOfferItem } from '@/lib/api/adserving';
import { useAdOffer } from './useAdOffer';
import { ReportButton } from '@/components/moderation/ReportButton';

/**
 * A paid placement in the Explore list. Clearly labeled ("Sponsored" — per the
 * FTC native-advertising guidance in docs/growth/INAPP_ADS.md), visually
 * adjacent to organic cards but never disguised as one, and it renders nothing
 * when there's no active placement so the layout is unaffected.
 */
export function FeaturedCard({ item }: { item: AdOfferItem }) {
  const { ref, onAdClick } = useAdOffer(item.offer_id ?? null);
  const inner = (
    <div
      ref={ref}
      className="card card-hover relative overflow-hidden p-4 ring-1 ring-flush-500/20"
    >
      <span className="absolute right-3 top-3 rounded-full bg-flush-600/10 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-flush-500 ring-1 ring-flush-500/30">
        Sponsored
      </span>
      <p className="pr-24 text-sm font-semibold text-app">
        {item.creative.title ?? item.business_name}
      </p>
      <p className="mt-0.5 text-xs text-muted">{item.business_name}</p>
      {item.creative.body && (
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted">
          {item.creative.body}
        </p>
      )}
    </div>
  );

  // The clickable ad plus a quiet report affordance below it (outside the
  // link, so reporting never counts as an ad click).
  let linked = inner;
  if (item.bathroom_id) {
    linked = (
      <Link
        to={`/bathrooms/${item.bathroom_id}`}
        aria-label={`Sponsored: ${item.business_name}`}
        onClick={onAdClick}
      >
        {inner}
      </Link>
    );
  } else if (item.creative.link) {
    linked = (
      <a
        href={item.creative.link}
        target="_blank"
        rel="noreferrer nofollow sponsored"
        aria-label={`Sponsored: ${item.business_name}`}
        onClick={onAdClick}
      >
        {inner}
      </a>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {linked}
      <ReportButton target={{ ad_campaign_id: item.campaign_id }} className="self-end" />
    </div>
  );
}
