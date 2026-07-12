import type { FormEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/lib/supabase';
import { deleteMyAccount } from '@/lib/api/profiles';
import type { RemovedItemAppeal } from '@/lib/api/appeals';
import { fileAppeal, myRemovedContent } from '@/lib/api/appeals';
import { ServiceRecord } from '@/components/review/ServiceRecord';
import { ConsentSettings } from '@/components/growth/ConsentSettings';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

const REMOVED_CONTENT_KEY = ['myRemovedContent'] as const;
const APPEAL_MAX = 2000;

function removedDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function appealErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Could not submit your appeal. Try again.';
}

/**
 * Per-item appeal state machine: no appeal → button + expanding form;
 * open/granted/denied → status chip (plus the admin's note when denied).
 */
function AppealActions({
  target,
  appeal,
}: {
  target: { review_id: string } | { bathroom_id: string };
  appeal: RemovedItemAppeal | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const file = useMutation({
    mutationFn: (trimmed: string) => fileAppeal(target, trimmed),
    onSuccess: () => {
      setSubmitted(true);
      setOpen(false);
      setReason('');
      setFormError(null);
      void qc.invalidateQueries({ queryKey: REMOVED_CONTENT_KEY });
    },
    onError: (err: unknown) => setFormError(appealErrorMessage(err)),
  });

  const submittedNote = (
    <p className="text-sm text-green-600" role="status">
      Appeal submitted — an admin will review it.
    </p>
  );

  if (appeal) {
    return (
      <div className="flex flex-col gap-1.5">
        {appeal.status === 'open' && (
          <span className="self-start rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
            Appeal pending
          </span>
        )}
        {appeal.status === 'granted' && (
          <span className="self-start rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600">
            Appeal granted — restored
          </span>
        )}
        {appeal.status === 'denied' && (
          <>
            <span className="self-start rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500">
              Appeal denied
            </span>
            {appeal.decision_note && (
              <blockquote className="border-l-2 border-app pl-3 text-sm text-muted">
                “{appeal.decision_note}”
              </blockquote>
            )}
          </>
        )}
        {appeal.status === 'open' && submitted && submittedNote}
      </div>
    );
  }

  if (submitted) return submittedNote;

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setOpen(true);
            setFormError(null);
          }}
        >
          Appeal
        </Button>
      </div>
    );
  }

  function onSubmitAppeal(e: FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) {
      setFormError('Please explain why this should be restored.');
      return;
    }
    if (trimmed.length > APPEAL_MAX) {
      setFormError(`Appeals are limited to ${APPEAL_MAX} characters.`);
      return;
    }
    setFormError(null);
    file.mutate(trimmed);
  }

  return (
    <form onSubmit={onSubmitAppeal} className="flex flex-col gap-3">
      <Textarea
        label="Why should this be restored?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={APPEAL_MAX}
        rows={3}
        error={formError ?? undefined}
        hint={`Required. Max ${APPEAL_MAX} characters.`}
        autoFocus
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={file.isPending} disabled={file.isPending}>
          Submit appeal
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={file.isPending}
          onClick={() => {
            setOpen(false);
            setReason('');
            setFormError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Removed reviews/bathrooms the signed-in user owns, with per-item appeals.
 * Renders nothing at all when there is nothing removed — a normal profile
 * shouldn't carry moderation noise.
 */
function RemovedContentSection() {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: REMOVED_CONTENT_KEY,
    queryFn: myRemovedContent,
    enabled: user != null,
  });

  if (!data || (data.reviews.length === 0 && data.bathrooms.length === 0)) {
    return null;
  }

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-app">Removed content &amp; appeals</h2>
      <p className="mt-1 text-sm text-muted">
        A moderator removed the items below. If you think that was a mistake,
        you can appeal each one once.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {data.reviews.map((r) => (
          <li
            key={`review-${r.id}`}
            className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-4"
          >
            <p className="text-sm text-app">
              <span className="font-medium">Review of {r.bathroom_name}</span>{' '}
              <span className="text-muted">
                · {r.rating}/5 · removed {removedDate(r.deleted_at)}
              </span>
            </p>
            {r.body && (
              <p className="line-clamp-3 whitespace-pre-line text-sm text-app">{r.body}</p>
            )}
            <p className="text-sm text-red-500">
              {r.removal_reason ? `Removed: ${r.removal_reason}` : 'Removed by a moderator'}
            </p>
            <AppealActions target={{ review_id: r.id }} appeal={r.appeal} />
          </li>
        ))}
        {data.bathrooms.map((b) => (
          <li
            key={`bathroom-${b.id}`}
            className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-4"
          >
            <p className="text-sm text-app">
              <span className="font-medium">{b.name}</span>{' '}
              <span className="text-muted">· removed {removedDate(b.deleted_at)}</span>
            </p>
            <p className="text-sm text-muted">{b.address}</p>
            <p className="text-sm text-red-500">
              {b.removal_reason ? `Removed: ${b.removal_reason}` : 'Removed by a moderator'}
            </p>
            <AppealActions target={{ bathroom_id: b.id }} appeal={b.appeal} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-app px-4 py-4 last:border-b-0">
      <dt className="w-24 shrink-0 pt-1.5 text-sm font-medium text-muted">{label}</dt>
      <dd className="flex-1">{children}</dd>
    </div>
  );
}

export function ProfilePage() {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Account deletion is two-step: reveal, then type the username to confirm.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) setDraft(profile.username);
  }, [profile]);

  // RequireAuth guarantees a user, but this keeps the types honest.
  if (!user) return null;

  if (!profile) {
    return (
      <div
        className="mx-auto max-w-lg py-12 text-center text-sm text-muted"
        role="status"
        aria-live="polite"
      >
        Loading your profile…
      </div>
    );
  }

  // Capture the narrowed values so the closures below don't see them re-widened
  // back to `| null` across the function boundary.
  const userId = user.id;
  const currentUsername = profile.username;

  const joined = new Date(profile.created_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const next = draft.trim();
    if (!USERNAME_RE.test(next)) {
      setError(
        'Username must be 3–30 characters, using only letters, numbers, and underscores.',
      );
      return;
    }
    if (next === currentUsername) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: dbError } = await supabase
        .from('profiles')
        .update({ username: next })
        .eq('id', userId);
      if (dbError) {
        if (dbError.code === '23505' || /duplicate|unique/i.test(dbError.message)) {
          setError('That username is taken. Try another.');
        } else {
          setError(dbError.message);
        }
        return;
      }
      await refreshProfile();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteMyAccount(userId);
      // The account (and this session) no longer exist; clear it and leave.
      await signOut().catch(() => {});
      navigate('/', { replace: true });
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'Could not delete your account. Try again.',
      );
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg py-8">
      <h1 className="text-2xl font-bold text-app">Your profile</h1>

      <div className="mt-6">
        <ServiceRecord profileId={userId} />
      </div>

      <dl className="mt-6 overflow-hidden rounded-xl border border-app bg-raised">
        <Row label="Username">
          {editing ? (
            <form onSubmit={onSave} className="flex w-full flex-col gap-3">
              <Input
                label="Username"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                hint="3–30 characters. Letters, numbers, and underscores."
                error={error ?? undefined}
                autoFocus
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={saving} disabled={saving}>
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                    setDraft(profile.username);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="font-medium text-app">{profile.username}</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                  setError(null);
                }}
              >
                Edit
              </Button>
            </div>
          )}
        </Row>

        <Row label="Email">
          <span className="text-app">{user.email ?? '—'}</span>
        </Row>

        <Row label="Joined">
          <span className="text-app">{joined}</span>
        </Row>
      </dl>

      <div className="mt-6">
        <ConsentSettings userId={userId} />
      </div>

      <section className="mt-10 rounded-xl border border-red-500/40 bg-red-500/5 p-5">
        <h2 className="text-base font-semibold text-app">Delete account</h2>
        <p className="mt-1 text-sm text-muted">
          Permanently deletes your account, your reviews, and your uploaded
          photos. Bathrooms you added stay on the map but are no longer linked to
          you. This can’t be undone.
        </p>

        {!confirmingDelete ? (
          <Button
            variant="danger"
            size="sm"
            className="mt-4"
            onClick={() => {
              setConfirmingDelete(true);
              setDeleteError(null);
            }}
          >
            Delete account
          </Button>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <Input
              label={`Type your username (${currentUsername}) to confirm`}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              error={deleteError ?? undefined}
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={deleting}
                disabled={deleting || deleteConfirmText !== currentUsername}
                onClick={() => void handleDeleteAccount()}
              >
                Permanently delete
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={deleting}
                onClick={() => {
                  setConfirmingDelete(false);
                  setDeleteConfirmText('');
                  setDeleteError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <RemovedContentSection />
    </div>
  );
}
