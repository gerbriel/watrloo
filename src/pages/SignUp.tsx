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

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Accepting the Terms is the single required consent at signup. Local
  // sponsored placements are contextual and disclosed in the Terms, so there's
  // no separate marketing opt-in to collect here. Pre-checked per the owner's
  // US-launch decision. (EU rollout will require this un-ticked by default.)
  const [termsAccepted, setTermsAccepted] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Signed in already (and not mid email-confirmation): nothing to do here.
  if (session && !sentTo) return <Navigate to="/explore" replace />;

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
    if (!firstName.trim() || !lastName.trim()) {
      setError('Enter your first and last name.');
      return;
    }
    if (phone.trim() && !/^[+()\-.\s\d]{7,20}$/.test(phone.trim())) {
      setError('That phone number doesn’t look right (digits, +, - only).');
      return;
    }
    if (!USERNAME_RE.test(username)) {
      setError(
        username.includes('@')
          ? 'Username isn’t your email — it’s a public display name. Use 3–30 letters, numbers, or underscores (your email goes in the Email field below).'
          : 'Username must be 3–30 characters, using only letters, numbers, and underscores.',
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
    if (!termsAccepted) {
      setError('You must accept the Terms & Conditions to create an account.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await signUp(email.trim(), password, username, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || undefined,
        termsAccepted,
      });
      // Confirmation is off, so signUp returns a live session and we go straight
      // into the app. The check-your-email branch stays as a safety net in case
      // confirmation is ever turned back on.
      if (needsEmailConfirmation) setSentTo(email.trim());
      else navigate('/explore', { replace: true });
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
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="First name"
            autoComplete="given-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
          <Input
            label="Last name"
            autoComplete="family-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />
        </div>
        <Input
          label="Phone (optional)"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          hint="Kept private — never shown on your public profile."
        />
        <Input
          label="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          hint="3–30 characters. Letters, numbers, and underscores. This is public."
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

        <div className="rounded-lg border border-app bg-raised p-3">
          <div className="flex items-start gap-2">
            <input
              id="terms-accept"
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-flush-600"
            />
            <label htmlFor="terms-accept" className="text-sm text-app select-none">
              I agree to the{' '}
              <Link to="/terms" className="font-medium text-flush-500 hover:underline">
                Terms & Conditions
              </Link>{' '}
              and the{' '}
              <Link to="/privacy" className="font-medium text-flush-500 hover:underline">
                Privacy Policy
              </Link>{' '}
              <span className="text-muted">(required)</span>
            </label>
          </div>
          <p className="mt-2 pl-6 text-xs text-muted">
            Watrloo is free and supported by local businesses, who can show
            “Sponsored” placements to people browsing in their area.
          </p>
        </div>

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
