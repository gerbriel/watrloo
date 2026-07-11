import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Where the password-reset email link lands. Supabase redirects here with a
 * recovery token in the URL; `detectSessionInUrl` exchanges it for a session
 * before this page settles, so "signed in" here means "allowed to set a new
 * password". No session after loading = the link expired or was already used.
 */
export function ResetPassword() {
  const { session, loading, updatePassword } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center" role="status">
        <span
          className="size-8 animate-spin rounded-full border-2 border-current border-t-transparent text-flush-500"
          aria-hidden="true"
        />
        <span className="sr-only">Checking your reset link…</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-sm py-8">
        <h1 className="text-2xl font-bold text-app">Link expired</h1>
        <p className="mt-2 text-sm text-muted">
          This reset link is invalid or has already been used. Request a fresh
          one and try again.
        </p>
        <p className="mt-4 text-sm">
          <Link
            to="/forgot-password"
            className="font-medium text-flush-500 hover:underline"
          >
            Send a new reset link
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-sm py-8">
        <h1 className="text-2xl font-bold text-app">Password updated</h1>
        <p className="mt-2 text-sm text-muted">
          You&rsquo;re signed in with your new password.
        </p>
        <Button className="mt-4" onClick={() => navigate('/browse')}>
          Browse bathrooms
        </Button>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update the password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <h1 className="text-2xl font-bold text-app">Choose a new password</h1>

      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />

        <div role="alert" aria-live="assertive">
          {error && (
            <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {error}
            </p>
          )}
        </div>

        <Button type="submit" loading={submitting} disabled={submitting}>
          Update password
        </Button>
      </form>
    </div>
  );
}
