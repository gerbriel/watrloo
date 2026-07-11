import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getMyConsent, setConsent } from '@/lib/api/growth';
import { queryKeys } from '@/lib/queryClient';

/**
 * The four consent toggles. Everything defaults OFF (no row = no consent) and
 * each change is written through the stamped set_consent RPC. Copy is honest:
 * it says what each toggle actually does, per docs/growth/COMPLIANCE.md —
 * unbundled, never pre-ticked.
 */

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-app">{label}</span>
        <span className="block text-xs leading-relaxed text-muted">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-flush-600"
      />
    </label>
  );
}

export function ConsentSettings({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: consent, isPending } = useQuery({
    queryKey: queryKeys.myConsent(userId),
    queryFn: () => getMyConsent(userId),
  });

  async function update(patch: Parameters<typeof setConsent>[0]) {
    setSaving(true);
    setError(null);
    try {
      await setConsent(patch);
      await queryClient.invalidateQueries({ queryKey: queryKeys.myConsent(userId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (isPending) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-app bg-raised" />
    );
  }

  const c = consent ?? {
    marketing_opt_in: false,
    location_opt_in: false,
    analytics_opt_in: false,
    newsletter_opt_out: false,
  };

  return (
    <section className="overflow-hidden rounded-xl border border-app bg-raised">
      <div className="border-b border-app px-4 py-3">
        <h2 className="text-sm font-semibold text-app">Privacy & messages</h2>
        <p className="mt-0.5 text-xs text-muted">
          Everything here is off unless you turn it on. Details in our{' '}
          <a href="/privacy" className="text-flush-500 hover:underline">
            privacy policy
          </a>
          .
        </p>
      </div>
      <div className="divide-y divide-[var(--border)]">
        <Toggle
          label="Promotional messages"
          hint="Local businesses can send you in-app offers — never email, capped at 3 per week total, at most 1 per business."
          checked={c.marketing_opt_in}
          disabled={saving}
          onChange={(v) => void update({ marketing: v })}
        />
        <Toggle
          label="In-app newsletter"
          hint="A periodic roundup of new and notable bathrooms near you, in your inbox here — not email."
          checked={c.marketing_opt_in && !c.newsletter_opt_out}
          disabled={saving || !c.marketing_opt_in}
          onChange={(v) => void update({ newsletterOptOut: !v })}
        />
        <Toggle
          label="Approximate location"
          hint="Lets us note your city (from your network address, never GPS) so nearby offers are relevant. The address itself is discarded immediately."
          checked={c.location_opt_in}
          disabled={saving}
          onChange={(v) => void update({ location: v })}
        />
        <Toggle
          label="Usage analytics"
          hint="Ties your product usage to your account to improve the app. Off: we only see anonymous, aggregate counts."
          checked={c.analytics_opt_in}
          disabled={saving}
          onChange={(v) => void update({ analytics: v })}
        />
      </div>
      {error && (
        <p role="alert" className="border-t border-app px-4 py-2 text-xs text-red-500">
          {error}
        </p>
      )}
    </section>
  );
}
