import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import type { NewAccessRequest } from '@/types/db';
import { fileAccessRequest } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { Input, Textarea } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RequestAccess() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [businessName, setBusinessName] = useState('');
  const [website, setWebsite] = useState('');
  const [contactEmail, setContactEmail] = useState(user?.email ?? '');
  const [message, setMessage] = useState('');
  const [locationsNote, setLocationsNote] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);

  const mutation = useMutation({
    mutationFn: async (input: NewAccessRequest) => {
      await fileAccessRequest(input, user?.id ?? null);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = businessName.trim();
    const trimmedEmail = contactEmail.trim();

    let hasError = false;
    if (!trimmedName) {
      setNameError('Business name is required.');
      hasError = true;
    } else {
      setNameError(undefined);
    }

    // Signed-out visitors have no account we can tie the request to, so a
    // reachable contact email is the only way we can follow up.
    if (!user) {
      if (!trimmedEmail) {
        setEmailError('Contact email is required so we can reach you.');
        hasError = true;
      } else if (!EMAIL_RE.test(trimmedEmail)) {
        setEmailError('Enter a valid email address.');
        hasError = true;
      } else {
        setEmailError(undefined);
      }
    } else {
      setEmailError(undefined);
    }

    if (hasError) return;

    const input: NewAccessRequest = {
      business_name: trimmedName,
      website: website.trim() ? website.trim() : null,
      contact_email: trimmedEmail ? trimmedEmail : null,
      message: message.trim() ? message.trim() : null,
      locations_note: locationsNote.trim() ? locationsNote.trim() : null,
    };
    mutation.mutate(input);
  }

  if (mutation.isSuccess) {
    return (
      <div className="mx-auto max-w-lg px-4 py-8">
        <div className="flex flex-col items-start gap-4 rounded-2xl border border-app bg-raised p-6">
          <h1 className="text-xl font-semibold text-app">Request received</h1>
          <p className="text-sm text-muted">
            We&rsquo;ll be in touch to set up your account.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => navigate('/browse')}>Browse bathrooms</Button>
            <Button variant="secondary" onClick={() => navigate('/')}>
              Back home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-6 flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-app">Request business access</h1>
        <p className="text-sm text-muted">
          Claim your locations, keep their info accurate, bulk-import a whole chain,
          and respond to reviews from one place. No Watrloo account required &mdash;
          just tell us how to reach you and we&rsquo;ll take it from there.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <Input
          label="Business name"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          error={nameError}
          placeholder="e.g. Riverside Cafés"
          maxLength={200}
          required
        />

        <Input
          label="Website"
          type="url"
          inputMode="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          hint="Optional."
          placeholder="https://example.com"
        />

        <Input
          label="Contact email"
          type="email"
          inputMode="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          error={emailError}
          hint={
            user
              ? 'Optional. How we’ll reach you about this request.'
              : 'So we can reach you about your request.'
          }
          placeholder="you@business.com"
          required={!user}
        />

        <Textarea
          label="Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          hint="Optional. Anything you'd like us to know."
          maxLength={1000}
        />

        <Textarea
          label="Your locations"
          value={locationsNote}
          onChange={(e) => setLocationsNote(e.target.value)}
          hint="List your locations or describe your chain — you can bulk-import a CSV after approval."
          maxLength={2000}
        />

        {mutation.isError && (
          <p role="alert" className="text-sm text-red-500">
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Could not send your request. Try again.'}
          </p>
        )}

        <div>
          <Button type="submit" size="lg" loading={mutation.isPending}>
            Request access
          </Button>
        </div>
      </form>
    </div>
  );
}
