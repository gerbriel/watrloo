import { Link } from 'react-router-dom';
import type { BathroomWithStats } from '@/types/db';
import { Stars } from '@/components/ui/Stars';
import { AmenityBadges } from '@/components/bathroom/AmenityBadges';

export function BathroomCard({ bathroom }: { bathroom: BathroomWithStats }) {
  const { stats } = bathroom;
  const rated = stats.review_count > 0 && stats.avg_rating != null;

  return (
    <Link
      to={`/bathrooms/${bathroom.id}`}
      className="group flex flex-col gap-3 rounded-xl border border-app bg-raised p-4 transition-shadow transition-colors hover:border-flush-500 hover:shadow-md focus-visible:border-flush-500"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-app group-hover:text-flush-600">
            {bathroom.name}
          </h3>
          <p className="mt-0.5 truncate text-sm text-muted">{bathroom.address}</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {rated ? (
          <>
            <Stars value={stats.avg_rating as number} size={16} />
            <span className="text-sm font-medium text-app">
              {(stats.avg_rating as number).toFixed(1)}
            </span>
            <span className="text-sm text-muted">
              ({stats.review_count} review{stats.review_count === 1 ? '' : 's'})
            </span>
          </>
        ) : (
          <span className="text-sm text-muted">No reviews yet</span>
        )}
      </div>

      <AmenityBadges amenities={bathroom} compact />
    </Link>
  );
}
