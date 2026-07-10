import type { FormEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/lib/supabase';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-app px-4 py-4 last:border-b-0">
      <dt className="w-24 shrink-0 pt-1.5 text-sm font-medium text-muted">{label}</dt>
      <dd className="flex-1">{children}</dd>
    </div>
  );
}

export function ProfilePage() {
  const { user, profile, refreshProfile } = useAuth();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  return (
    <div className="mx-auto max-w-lg py-8">
      <h1 className="text-2xl font-bold text-app">Your profile</h1>

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
    </div>
  );
}
