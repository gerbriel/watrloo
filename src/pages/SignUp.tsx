import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function signUpErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/already registered|already exists/i.test(msg)) {
    return 'An account with that email already exists. Try signing in instead.';
  }
  if (hasCode(err, '23505') || /duplicate key|unique/i.test(msg)) {
    return 'That username is taken. Try another.';
  }
  return msg || 'Something went wrong. Please try again.';
}

export function SignUp() {
  const { signUp, session } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Signed in already (and not mid email-confirmation): nothing to do here.
  if (session && !sentTo) return <Navigate to="/browse" replace />;

  if (sentTo) {
    return (
      <div className="mx-auto max-w-sm py-12 text-center">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="mx-auto size-10 text-flush-500"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
        <h1 className="mt-3 text-2xl font-bold text-app">Check your email</h1>
        <p className="mt-2 text-sm text-muted">
          We sent a confirmation link to{' '}
          <span className="font-medium text-app">{sentTo}</span>. Click it to confirm
          your account — you’ll be signed in automatically and taken to the app.
        </p>
        <Link
          to="/signin"
          className="mt-6 inline-block text-sm font-medium text-flush-500 hover:underline"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!USERNAME_RE.test(username)) {
      setError(
        'Username must be 3–30 characters, using only letters, numbers, and underscores.',
      );
      return;
    }
    if (!email.trim()) {
      setError('Enter your email.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await signUp(email.trim(), password, username);
      if (needsEmailConfirmation) setSentTo(email.trim());
      else navigate('/browse', { replace: true });
    } catch (err) {
      setError(signUpErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <h1 className="text-2xl font-bold text-app">Create your account</h1>
      <p className="mt-1 text-sm text-muted">
        Join Watrloo to rate and add public bathrooms.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        <Input
          label="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          hint="3–30 characters. Letters, numbers, and underscores."
          required
        />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 6 characters."
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
          Create account
        </Button>
      </form>

      <p className="mt-4 text-sm text-muted">
        Already have an account?{' '}
        <Link to="/signin" className="font-medium text-flush-500 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
