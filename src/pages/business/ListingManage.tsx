// AGENT UNIT — implement per instructions. Preserve the export name.
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBathroom,
  getReviewResponse,
  listReviewsForBathroom,
  respondToReview,
  updateListing,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { AMENITY_KEYS, AMENITY_LABELS } from '@/types/db';
import type {
  Amenities,
  BathroomWithStats,
  ListingUpdate,
  ReviewWithAuthor,
} from '@/types/db';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Checkbox } from '@/components/ui/Field';
import { Stars } from '@/components/ui/Stars';

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * The listing/response RPCs re-check that the caller manages the listing and
 * raise on failure. Surface that one case as a friendly, specific message
 * rather than the raw Postgres error text.
 */
function isNotAuthorized(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; message?: string };
  if (e.status === 403) return true;
  if (e.code === '42501') return true; // insufficient_privilege
  return (
    typeof e.message === 'string' &&
    /not authoriz|permission denied|forbidden|manage/i.test(e.message)
  );
}

function errorText(err: unknown, fallback: string): string {
  if (isNotAuthorized(err)) return "You don't manage this listing.";
  return err instanceof Error ? err.message : fallback;
}

/** Edit the listing's facts (never its reviews). Seeded from the loaded bathroom. */
function FactsForm({ bathroom }: { bathroom: BathroomWithStats }) {
  const qc = useQueryClient();
  const [name, setName] = useState(bathroom.name);
  const [address, setAddress] = useState(bathroom.address);
  const [description, setDescription] = useState(bathroom.description ?? '');
  const [amenities, setAmenities] = useState<Amenities>({
    wheelchair_accessible: bathroom.wheelchair_accessible,
    gender_neutral: bathroom.gender_neutral,
    changing_table: bathroom.changing_table,
    requires_key: bathroom.requires_key,
  });

  const save = useMutation({
    mutationFn: (patch: ListingUpdate) => updateListing(bathroom.id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.bathroom(bathroom.id) });
      // The name/facts show up in list and map views too.
      void qc.invalidateQueries({ queryKey: ['bathrooms'] });
    },
  });

  // Drop a stale "Saved" / error the moment the manager touches the form again.
  function clearSaved() {
    if (save.isSuccess || save.isError) save.reset();
  }

  function toggle(key: keyof Amenities) {
    setAmenities((a) => ({ ...a, [key]: !a[key] }));
    clearSaved();
  }

  const descTrimmed = description.trim();
  const dirty =
    name.trim() !== bathroom.name ||
    address.trim() !== bathroom.address ||
    descTrimmed !== (bathroom.description ?? '') ||
    AMENITY_KEYS.some((k) => amenities[k] !== bathroom[k]);

  const canSave = name.trim() !== '' && address.trim() !== '' && dirty;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    save.mutate({
      name: name.trim(),
      address: address.trim(),
      description: descTrimmed ? descTrimmed : null,
      ...amenities,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <Input
        label="Name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          clearSaved();
        }}
        maxLength={120}
      />

      <Input
        label="Address"
        value={address}
        onChange={(e) => {
          setAddress(e.target.value);
          clearSaved();
        }}
        maxLength={300}
      />

      <Textarea
        label="Description"
        value={description}
        onChange={(e) => {
          setDescription(e.target.value);
          clearSaved();
        }}
        hint="Optional. Anything worth knowing before you go."
        maxLength={2000}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-app">Amenities</legend>
        {AMENITY_KEYS.map((key) => (
          <Checkbox
            key={key}
            label={AMENITY_LABELS[key]}
            checked={amenities[key]}
            onChange={() => toggle(key)}
          />
        ))}
      </fieldset>

      {save.isError && (
        <p role="alert" className="text-sm text-red-500">
          {errorText(save.error, 'Could not save. Try again.')}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={save.isPending} disabled={!canSave}>
          Save changes
        </Button>
        {save.isSuccess && !dirty && (
          <span role="status" className="text-sm font-medium text-green-600">
            Saved ✓
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * One review plus the business's official reply. Businesses only ever respond —
 * they never edit or delete the review itself.
 */
function ReviewCard({ review }: { review: ReviewWithAuthor }) {
  const qc = useQueryClient();
  const { data: existing } = useQuery({
    queryKey: queryKeys.reviewResponse(review.id),
    queryFn: () => getReviewResponse(review.id),
  });

  const [body, setBody] = useState('');
  const [seeded, setSeeded] = useState(false);

  // Prefill the composer with the current reply once it loads, but never stomp
  // on text the manager is actively typing.
  useEffect(() => {
    if (!seeded && existing) {
      setBody(existing.body);
      setSeeded(true);
    }
  }, [existing, seeded]);

  const respond = useMutation({
    mutationFn: (text: string) => respondToReview(review.id, text),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.reviewResponse(review.id) });
    },
  });

  const trimmed = body.trim();
  const existingBody = existing?.body ?? '';
  const hasResponse = existing != null;
  const canSubmit = trimmed !== '' && trimmed !== existingBody;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    respond.mutate(trimmed);
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Stars value={review.rating} />
        <span className="text-xs text-muted">
          @{review.author?.username ?? 'unknown'} · {fmt(review.created_at)}
        </span>
      </div>

      {review.body && (
        <p className="whitespace-pre-line text-sm text-app">{review.body}</p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-app pt-3">
        <Textarea
          label="Owner response"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (respond.isSuccess || respond.isError) respond.reset();
          }}
          hint="Your reply is shown publicly under this review."
          maxLength={2000}
        />

        {respond.isError && (
          <p role="alert" className="text-sm text-red-500">
            {errorText(respond.error, 'Could not post your response. Try again.')}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            size="sm"
            loading={respond.isPending}
            disabled={!canSubmit}
          >
            {hasResponse ? 'Update response' : 'Post response'}
          </Button>
          {respond.isSuccess && (
            <span role="status" className="text-sm font-medium text-green-600">
              Saved ✓
            </span>
          )}
        </div>
      </form>
    </li>
  );
}

export function ListingManage() {
  const { bathroomId = '' } = useParams();

  const bathroomQuery = useQuery({
    queryKey: queryKeys.bathroom(bathroomId),
    queryFn: () => getBathroom(bathroomId),
    enabled: bathroomId !== '',
  });

  const reviewsQuery = useQuery({
    queryKey: queryKeys.reviews(bathroomId),
    queryFn: () => listReviewsForBathroom(bathroomId),
    enabled: bathroomId !== '',
  });

  if (bathroomId === '') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-sm text-muted">No listing selected.</p>
      </div>
    );
  }

  if (bathroomQuery.isPending) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-sm text-muted">Loading listing…</p>
      </div>
    );
  }

  if (bathroomQuery.isError) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-start gap-2 px-4 py-8">
        <p className="text-sm text-red-500">
          {bathroomQuery.error instanceof Error
            ? bathroomQuery.error.message
            : 'Could not load this listing.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void bathroomQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const bathroom = bathroomQuery.data;
  if (!bathroom) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Link
          to="/business/dashboard"
          className="text-sm font-medium text-flush-600 hover:underline"
        >
          ← Back to dashboard
        </Link>
        <p className="mt-4 text-sm text-muted">
          We couldn't find that listing. It may have been removed.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link
        to="/business/dashboard"
        className="text-sm font-medium text-flush-600 hover:underline"
      >
        ← Back to dashboard
      </Link>

      <header className="mt-2">
        <h1 className="text-2xl font-bold text-app">{bathroom.name}</h1>
        <p className="mt-0.5 text-sm text-muted">{bathroom.address}</p>
      </header>

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-app">Listing details</h2>
        <FactsForm bathroom={bathroom} />
      </section>

      <section className="mt-10">
        <h2 className="mb-1 text-lg font-semibold text-app">Reviews</h2>
        <p className="mb-4 text-sm text-muted">
          Respond to feedback. You can reply to a review, but you can't edit or
          delete it.
        </p>

        {reviewsQuery.isPending && (
          <p className="text-sm text-muted">Loading reviews…</p>
        )}

        {reviewsQuery.isError && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-red-500">
              {reviewsQuery.error instanceof Error
                ? reviewsQuery.error.message
                : 'Could not load reviews.'}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void reviewsQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        )}

        {reviewsQuery.data &&
          (reviewsQuery.data.length === 0 ? (
            <p className="text-sm text-muted">No reviews yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {reviewsQuery.data.map((review) => (
                <ReviewCard key={review.id} review={review} />
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}
