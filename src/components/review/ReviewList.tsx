import type { ReviewWithAuthor } from '@/types/db';
import { ReviewCard } from '@/components/review/ReviewCard';

export function ReviewList({
  reviews,
  currentUserId = null,
  onDelete,
  deletingId = null,
}: {
  reviews: ReviewWithAuthor[];
  currentUserId?: string | null;
  onDelete?: (review: ReviewWithAuthor) => void;
  deletingId?: string | null;
}) {
  if (reviews.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-app bg-raised px-6 py-10 text-center">
        <p className="font-medium text-app">No reviews yet</p>
        <p className="mt-1 text-sm text-muted">
          Be the first to rate this bathroom.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {reviews.map((review) => (
        <li key={review.id}>
          <ReviewCard
            review={review}
            isOwn={currentUserId != null && review.author_id === currentUserId}
            onDelete={onDelete}
            deleting={deletingId === review.id}
          />
        </li>
      ))}
    </ul>
  );
}
