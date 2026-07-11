import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';

export function ForgotPassword() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter the email you signed up with.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(trimmed);
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send the reset email.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-sm py-8">
        <h1 className="text-2xl font-bold text-app">Check your inbox</h1>
        <p className="mt-2 text-sm text-muted">
          If an account exists for <span className="font-medium text-app">{email.trim()}</span>,
          we&rsquo;ve sent a link to reset your password. The link opens a page
          where you can choose a new one.
        </p>
        <p className="mt-4 text-sm text-muted">
          <Link to="/signin" className="font-medium text-flush-500 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <h1 className="text-2xl font-bold text-app">Forgot your password?</h1>
      <p className="mt-1 text-sm text-muted">
        Enter your email and we&rsquo;ll send you a reset link.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
          Send reset link
        </Button>
      </form>

      <p className="mt-4 text-sm text-muted">
        Remembered it?{' '}
        <Link to="/signin" className="font-medium text-flush-500 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
