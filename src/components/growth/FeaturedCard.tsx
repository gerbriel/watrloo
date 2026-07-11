import { Link } from 'react-router-dom';
import type { FeaturedItem } from '@/lib/api/growth';

/**
 * A paid placement in the Explore list. Clearly labeled ("Sponsored" — per the
 * FTC native-advertising guidance in docs/growth/INAPP_ADS.md), visually
 * adjacent to organic cards but never disguised as one, and it renders nothing
 * when there's no active placement so the layout is unaffected.
 */
export function FeaturedCard({ item }: { item: FeaturedItem }) {
  const inner = (
    <div className="card card-hover relative overflow-hidden p-4 ring-1 ring-flush-500/20">
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

  if (item.bathroom_id) {
    return (
      <Link to={`/bathrooms/${item.bathroom_id}`} aria-label={`Sponsored: ${item.business_name}`}>
        {inner}
      </Link>
    );
  }
  if (item.creative.link) {
    return (
      <a
        href={item.creative.link}
        target="_blank"
        rel="noreferrer nofollow sponsored"
        aria-label={`Sponsored: ${item.business_name}`}
      >
        {inner}
      </a>
    );
  }
  return inner;
}
