import { useEffect, useState } from 'react';
import type { NewReview, Score } from '@/types/db';
import { getMyReview, upsertReview } from '@/lib/api/reviews';
import { getReviewerStats } from '@/lib/api/profiles';
import { uploadReviewPhoto } from '@/lib/api/photos';
import type { Rank } from '@/lib/ranks';
import { campaigns, nextRankFor, rankFor, RANKS_TAGLINE } from '@/lib/ranks';
import { StarInput } from '@/components/ui/Stars';
import { Textarea } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { PhotoUploader } from '@/components/review/PhotoUploader';

type Celebration =
  | { kind: 'promoted'; rank: Rank; count: number }
  | { kind: 'logged'; count: number };

/**
 * The payoff for contributing: a fresh review is a "campaign" in the Grande
 * Armée du Trône (src/lib/ranks.ts), and crossing a rank threshold gets a
 * promotion banner. Rendered inside the form, right where the user just acted.
 */
function CampaignBanner({ celebration }: { celebration: Celebration }) {
  if (celebration.kind === 'promoted') {
    return (
      <div className="rounded-lg border border-star/40 bg-star/10 p-3">
        <p className="font-display font-bold text-app">
          <span aria-hidden="true">⚜ </span>Promoted! You are now{' '}
          {celebration.rank.title}.
        </p>
        <p className="mt-0.5 text-sm text-muted italic">
          “{celebration.rank.motto}”
        </p>
      </div>
    );
  }

  const next = nextRankFor(celebration.count);
  return (
    <div className="rounded-lg border border-flush-500/30 bg-flush-600/10 p-3">
      <p className="text-sm font-medium text-app">
        Campaign logged — {campaigns(celebration.count)} served.
        {next && ` ${next.min - celebration.count} more to make ${next.title}.`}
      </p>
      <p className="mt-0.5 text-xs text-muted">{RANKS_TAGLINE}</p>
    </div>
  );
}

function SubRating({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Score | null;
  onChange: (v: Score) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-app">{label}</span>
      <StarInput name={label} value={value} onChange={onChange} size={20} />
    </div>
  );
}

/**
 * One review per user per bathroom (DB unique constraint), so a user who has
 * already reviewed is *editing*: we fetch their existing review on mount,
 * prefill, and upsert on submit. Photos upload only after the row exists.
 */
export function ReviewForm({
  bathroomId,
  userId,
  onSaved,
}: {
  bathroomId: string;
  userId: string;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState<Score | null>(null);
  const [cleanliness, setCleanliness] = useState<Score | null>(null);
  const [privacy, setPrivacy] = useState<Score | null>(null);
  const [accessibility, setAccessibility] = useState<Score | null>(null);
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Campaign count at mount, so a save knows whether it earned a promotion.
  const [myCount, setMyCount] = useState<number | null>(null);
  const [celebration, setCelebration] = useState<Celebration | null>(null);

  useEffect(() => {
    let active = true;
    getReviewerStats(userId)
      .then((s) => {
        if (active) setMyCount(s.review_count);
      })
      .catch(() => {
        /* Non-fatal: the review still saves; only the fanfare is lost. */
      });
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getMyReview(bathroomId, userId)
      .then((mine) => {
        if (!active || !mine) return;
        setEditing(true);
        setRating(mine.rating);
        setCleanliness(mine.cleanliness);
        setPrivacy(mine.privacy);
        setAccessibility(mine.accessibility);
        setBody(mine.body ?? '');
      })
      .catch(() => {
        /* Non-fatal: fall back to a blank "create" form. */
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bathroomId, userId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rating == null) {
      setError('Please choose an overall rating.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const input: NewReview = {
        bathroom_id: bathroomId,
        rating,
        cleanliness,
        privacy,
        accessibility,
        body: body.trim() ? body.trim() : null,
      };
      const review = await upsertReview(input, userId);
      // Upload photos sequentially now that we have review.id.
      for (const file of photos) {
        await uploadReviewPhoto(file, userId, review.id);
      }
      setPhotos([]);
      setEditing(true);

      // Refetch the count rather than assuming +1: an edit upserts in place
      // (count unchanged, stay quiet), and only a genuinely new campaign
      // should trigger the fanfare or a promotion.
      if (myCount != null) {
        try {
          const { review_count: newCount } = await getReviewerStats(userId);
          if (newCount > myCount) {
            setCelebration(
              rankFor(newCount).min !== rankFor(myCount).min
                ? { kind: 'promoted', rank: rankFor(newCount), count: newCount }
                : { kind: 'logged', count: newCount },
            );
          }
          setMyCount(newCount);
        } catch {
          /* Non-fatal: the review saved; only the fanfare is lost. */
        }
      }

      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save your review.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-app bg-raised" />
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 rounded-xl border border-app bg-raised p-4"
    >
      {celebration && (
        <div role="status" aria-live="polite">
          <CampaignBanner celebration={celebration} />
        </div>
      )}

      <h3 className="font-semibold text-app">
        {editing ? 'Update your review' : 'Write a review'}
      </h3>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-app">
          Overall rating <span className="text-red-500">*</span>
        </span>
        <StarInput name="Overall rating" value={rating} onChange={setRating} />
      </div>

      <fieldset className="flex flex-col gap-2 rounded-lg border border-app p-3">
        <legend className="px-1 text-xs font-medium text-muted">
          Optional sub-scores
        </legend>
        <SubRating label="Cleanliness" value={cleanliness} onChange={setCleanliness} />
        <SubRating label="Privacy" value={privacy} onChange={setPrivacy} />
        <SubRating
          label="Accessibility"
          value={accessibility}
          onChange={setAccessibility}
        />
      </fieldset>

      <Textarea
        label="Your review"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Clean? Easy to find? Did you need a code?"
        maxLength={4000}
      />

      <PhotoUploader value={photos} onChange={setPhotos} disabled={saving} />

      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}

      <div>
        <Button type="submit" loading={saving}>
          {editing ? 'Update review' : 'Post review'}
        </Button>
      </div>
    </form>
  );
}
