import { Link } from 'react-router-dom';
import type { ReviewWithAuthor, Score } from '@/types/db';
import { Stars } from '@/components/ui/Stars';
import { publicPhotoUrl } from '@/lib/api/photos';
import { Button } from '@/components/ui/Button';
import { ReportButton } from '@/components/moderation/ReportButton';
import { OwnerResponse } from '@/components/business/OwnerResponse';
import { RankBadge } from '@/components/review/RankBadge';
import { ReactionBar } from '@/components/review/ReactionBar';

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function SubScore({ label, value }: { label: string; value: Score | null }) {
  if (value == null) return null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      <Stars value={value} size={12} />
    </div>
  );
}

export function ReviewCard({
  review,
  isOwn = false,
  onDelete,
  deleting = false,
}: {
  review: ReviewWithAuthor;
  isOwn?: boolean;
  onDelete?: (review: ReviewWithAuthor) => void;
  deleting?: boolean;
}) {
  const edited = review.updated_at !== review.created_at;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/u/${encodeURIComponent(review.author.username)}`}
            className="font-medium text-app hover:underline"
          >
            @{review.author.username}
          </Link>
          <RankBadge reviewCount={review.author.review_count} />
          {isOwn && (
            <span className="rounded-full bg-flush-600/10 px-2 py-0.5 text-xs font-medium text-flush-600">
              Your review
            </span>
          )}
        </div>
        <time
          dateTime={review.updated_at}
          title={new Date(review.updated_at).toLocaleString()}
          className="shrink-0 text-xs text-muted"
        >
          {timeAgo(review.updated_at)}
          {edited && ' (edited)'}
        </time>
      </div>

      <div className="flex items-center gap-2">
        <Stars value={review.rating} size={16} />
        <span className="text-sm font-medium text-app">{review.rating.toFixed(1)}</span>
      </div>

      {(review.cleanliness != null ||
        review.privacy != null ||
        review.accessibility != null) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <SubScore label="Cleanliness" value={review.cleanliness} />
          <SubScore label="Privacy" value={review.privacy} />
          <SubScore label="Accessibility" value={review.accessibility} />
        </div>
      )}

      {review.body && (
        <p className="whitespace-pre-line text-sm text-app">{review.body}</p>
      )}

      {review.photos.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {review.photos.map((photo) => (
            <li key={photo.id}>
              <a
                href={publicPhotoUrl(photo.storage_path)}
                target="_blank"
                rel="noreferrer"
                className="block size-24 overflow-hidden rounded-lg border border-app"
              >
                <img
                  src={publicPhotoUrl(photo.storage_path)}
                  alt={`Photo from @${review.author.username}’s review`}
                  loading="lazy"
                  className="size-full object-cover transition-transform hover:scale-105"
                />
              </a>
            </li>
          ))}
        </ul>
      )}

      <OwnerResponse reviewId={review.id} />

      <ReactionBar reviewId={review.id} />

      {isOwn && onDelete ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            loading={deleting}
            onClick={() => onDelete(review)}
            className="text-red-500 hover:bg-red-500/10"
          >
            Delete
          </Button>
        </div>
      ) : (
        !isOwn && <ReportButton target={{ review_id: review.id }} />
      )}
    </article>
  );
}
