import { useState } from 'react';
import type { ComponentType, CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/auth/AuthProvider';
import { InteractionOptions } from '@/components/business/InteractionOptions';
import { DashboardPreview } from '@/components/business/previews/DashboardPreview';
import { ClaimPreview } from '@/components/business/previews/ClaimPreview';
import { ListingEditPreview } from '@/components/business/previews/ListingEditPreview';
import { ReviewResponsePreview } from '@/components/business/previews/ReviewResponsePreview';
import { CsvImportPreview } from '@/components/business/previews/CsvImportPreview';
import { TeamPreview } from '@/components/business/previews/TeamPreview';
import { AnalyticsPreview } from '@/components/business/previews/AnalyticsPreview';
import { StorefrontPreview } from '@/components/business/previews/StorefrontPreview';
import { PromotionsPreview } from '@/components/business/previews/PromotionsPreview';

/** Small inline icons — no icon dependency, no emoji. Mirrors Landing.tsx. */
function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? 'size-5'}
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  pin: 'M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  verified: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zM9 12l2 2 4-4',
  doc: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M9 13h6M9 17h4',
  upload: 'M12 15V4M8 8l4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  chat: 'M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6a8.5 8.5 0 0 1-.9-3.9A8.4 8.4 0 0 1 12.5 3a8.4 8.4 0 0 1 8.5 8.5z',
  chart: 'M4 20V4M4 20h16M8 20v-6M13 20V9M18 20v-9',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 22l-5.2-2.7 1-5.8-4.3-4.1 5.9-.9z',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-6.2-6.2A2 2 0 0 1 4 13V5a2 2 0 0 1 2-2h7.6a2 2 0 0 1 1.4.6l6.2 6.2a2 2 0 0 1 0 2.6zM7.5 7.5h.01',
} as const;

const FEATURES = [
  {
    icon: ICONS.verified,
    title: 'Claim your locations',
    body: 'Verify ownership and light up every listing with an Official badge people trust.',
    badge: 'Official',
  },
  {
    icon: ICONS.doc,
    title: 'Keep facts accurate',
    body: 'Own the hours, amenities, and access notes so what visitors see is always current.',
  },
  {
    icon: ICONS.upload,
    title: 'Bulk-import a chain',
    body: 'Bring a whole fleet online in minutes by uploading a single CSV of your locations.',
  },
  {
    icon: ICONS.chat,
    title: 'Respond to reviews',
    body: 'Reply publicly to feedback, thank regulars, and address issues in the open.',
  },
  {
    icon: ICONS.chart,
    title: 'Analytics on your listings',
    body: 'See views, ratings, and trends across every location on one dashboard.',
  },
  {
    icon: ICONS.star,
    title: 'Featured placement',
    body: 'Rise to the top of search and the map with sponsored and featured slots.',
  },
  {
    icon: ICONS.tag,
    title: 'Promotions & coupons',
    body: 'Publish offers on your listings to turn nearby searches into foot traffic.',
  },
] as const;

const STEPS = [
  {
    n: 1,
    title: 'Request access',
    body: 'Tell us who you are and which locations you represent. It takes a minute.',
  },
  {
    n: 2,
    title: 'We set you up',
    body: 'We verify ownership and provision your business account and dashboard.',
  },
  {
    n: 3,
    title: 'Claim & manage',
    body: 'Claim your locations, tidy the details, respond to reviews, and start promoting.',
  },
] as const;

/**
 * The public product tour: hard-coded preview windows grouped into steps.
 * Each preview is a self-contained, prop-less "app window" mock. They read
 * top-to-bottom as: overview → claim → edit → respond → import → team →
 * analytics → storefront → promotions.
 */
interface TierPreview {
  caption: string;
  Component: ComponentType;
}

interface Tier {
  key: string;
  name: string;
  price: string;
  per: string;
  tagline: string;
  popular?: boolean;
  features: readonly string[];
  showcaseTitle: string;
  showcaseBlurb: string;
  previews: readonly TierPreview[];
}

/**
 * Real tiers from docs/growth/PRICING.md (also seeded in the plans table).
 * Selecting a tier swaps in hard-coded examples of what THAT plan feels like.
 */
const TIERS: readonly Tier[] = [
  {
    key: 'solo',
    name: 'Solo',
    price: '$10',
    per: '/mo · $100/yr',
    tagline: 'One location, done right.',
    features: [
      '1 claimed location + Official badge',
      'Edit facts, hours & amenities',
      'Respond to reviews in public',
      '1 featured placement / week',
      'Basic analytics · 2 team seats',
    ],
    showcaseTitle: 'What Solo feels like',
    showcaseBlurb:
      'Claim your spot, perfect the details, and answer your reviewers — the essentials for a single location.',
    previews: [
      { caption: 'Claim your location and get verified', Component: ClaimPreview },
      { caption: 'Take control of the details', Component: ListingEditPreview },
      { caption: 'Reply where visitors can see it', Component: ReviewResponsePreview },
    ],
  },
  {
    key: 'growth',
    name: 'Growth',
    price: '$39',
    per: '/mo · $390/yr',
    tagline: 'A handful of locations, one console.',
    popular: true,
    features: [
      'Up to 5 locations (+$6/extra to 15)',
      'Everything in Solo',
      '3 featured placements / week',
      'Standard analytics · CSV import',
      '5 team seats · 1 newsletter slot/mo',
    ],
    showcaseTitle: 'What Growth feels like',
    showcaseBlurb:
      'Run several locations from one dashboard, bring in your team, and see which spots pull their weight.',
    previews: [
      { caption: 'Every location on one screen', Component: DashboardPreview },
      { caption: 'Your whole team, scoped access', Component: TeamPreview },
      { caption: 'Know which locations perform', Component: AnalyticsPreview },
    ],
  },
  {
    key: 'chain',
    name: 'Chain',
    price: '$149',
    per: '/mo · $1,490/yr',
    tagline: 'A fleet at scale.',
    features: [
      'Up to 25 locations (+$4/extra to 100)',
      'Everything in Growth',
      '3 featured placements / week per location',
      'Advanced analytics · API read access',
      '15 seats · 3 newsletter slots/mo · priority support',
    ],
    showcaseTitle: 'What Chain feels like',
    showcaseBlurb:
      'Import the whole footprint from a CSV, promote every storefront, and keep the brand consistent everywhere.',
    previews: [
      { caption: 'Bring the fleet online in minutes', Component: CsvImportPreview },
      { caption: 'Promotions that drive foot traffic', Component: PromotionsPreview },
      { caption: 'Every listing a verified storefront', Component: StorefrontPreview },
    ],
  },
];


/** A verified "storefront" preview that echoes Landing's SampleCard styling. */
function StorefrontCard() {
  return (
    <div className="card w-full max-w-sm p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-semibold text-app">
            Golden Bear Gas
          </p>
          <p className="text-sm text-muted">42 locations · California</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-flush-600/10 px-2.5 py-1 text-xs font-medium text-flush-500 ring-1 ring-flush-500/20">
          <Icon path={ICONS.verified} className="size-3.5" />
          Official
        </span>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
        {[
          ['Listings', '42'],
          ['Avg rating', '4.6'],
          ['Reviews', '1.2k'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-sunken py-2.5">
            <dt className="text-[0.7rem] uppercase tracking-wide text-muted">
              {label}
            </dt>
            <dd className="font-display text-base font-semibold text-app">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 rounded-xl border border-app bg-sunken p-4">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-flush-500/15 to-cyan-500/15 text-flush-500 ring-1 ring-flush-500/20">
            <Icon path={ICONS.tag} className="size-4" />
          </span>
          <p className="text-sm font-medium text-app">Free coffee with any fill-up</p>
        </div>
        <p className="mt-2 text-xs text-muted">
          Live promotion · shown to nearby searchers
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className="rounded-full border border-app px-2.5 py-1 text-xs text-muted">
          Wheelchair accessible
        </span>
        <span className="rounded-full border border-app px-2.5 py-1 text-xs text-muted">
          Customers only
        </span>
      </div>
    </div>
  );
}

export function ForBusiness() {
  const navigate = useNavigate();
  const [selectedTier, setSelectedTier] = useState('growth');
  const { isBusinessMember } = useAuth();

  const primary = isBusinessMember
    ? { label: 'Go to your dashboard', to: '/business/dashboard' }
    : { label: 'Request business access', to: '/business/request' };

  return (
    <div className="flex flex-col gap-24 pb-16">
      {/* Hero */}
      <section className="relative isolate pt-10 sm:pt-16">
        <div className="grid-fade absolute inset-x-0 -top-16 -z-10 h-[420px]" aria-hidden="true" />
        <div
          className="glow-blob -z-10 left-[-10%] top-[-6%] h-72 w-72 sm:h-96 sm:w-96"
          aria-hidden="true"
        />
        <div
          className="glow-blob glow-blob-2 -z-10 right-[-6%] top-[10%] h-72 w-72 sm:h-96 sm:w-96"
          aria-hidden="true"
        />

        <div className="grid items-center gap-12 md:grid-cols-2">
          <div className="flex flex-col gap-6">
            <span className="rise inline-flex w-fit items-center gap-2 rounded-full border border-app bg-raised/70 px-3 py-1 text-xs font-medium text-muted backdrop-blur">
              <Icon path={ICONS.pin} className="size-3.5 text-flush-500" />
              Watrloo for business
            </span>

            <h1
              className="rise font-display text-[2.75rem] font-bold leading-[1.05] tracking-tight text-app sm:text-6xl"
              style={{ '--rise-delay': '0.05s' } as CSSProperties}
            >
              Own your restrooms{' '}
              <span className="text-gradient">on Watrloo.</span>
            </h1>

            <p
              className="rise max-w-md text-lg leading-relaxed text-muted"
              style={{ '--rise-delay': '0.12s' } as CSSProperties}
            >
              Turn a plain listing into a verified storefront. Keep the details
              right, answer your reviews, and run promotions that turn nearby
              searches into foot traffic.
            </p>

            <div
              className="rise flex flex-wrap gap-3"
              style={{ '--rise-delay': '0.18s' } as CSSProperties}
            >
              <Button size="lg" variant="primary" onClick={() => navigate(primary.to)}>
                {primary.label}
              </Button>
              <Button size="lg" variant="secondary" onClick={() => navigate('/browse')}>
                See a live listing
              </Button>
            </div>

            <p
              className="rise text-sm text-muted"
              style={{ '--rise-delay': '0.24s' } as CSSProperties}
            >
              No commitment — we’ll walk you through setup.
            </p>
          </div>

          <div
            className="rise flex justify-center md:justify-end"
            style={{ '--rise-delay': '0.15s' } as CSSProperties}
          >
            <StorefrontCard />
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section className="flex flex-col gap-10">
        <div className="max-w-2xl">
          <h2 className="font-display text-3xl font-bold tracking-tight text-app">
            Everything you need to run your presence
          </h2>
          <p className="mt-3 text-lg text-muted">
            One dashboard for every location — verified, accurate, and working to
            bring customers through your door.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card card-hover flex flex-col gap-3 p-6">
              <div className="flex items-center justify-between">
                <span className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-flush-500/15 to-cyan-500/15 text-flush-500 ring-1 ring-flush-500/20">
                  <Icon path={f.icon} />
                </span>
                {'badge' in f && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-flush-600/10 px-2.5 py-1 text-xs font-medium text-flush-500 ring-1 ring-flush-500/20">
                    <Icon path={ICONS.verified} className="size-3.5" />
                    {f.badge}
                  </span>
                )}
              </div>
              <h3 className="font-display text-lg font-semibold text-app">
                {f.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing + tier-driven showcase */}
      <section className="flex flex-col gap-10">
        <div className="max-w-2xl">
          <h2 className="font-display text-3xl font-bold tracking-tight text-app">
            Plans &amp; pricing
          </h2>
          <p className="mt-3 text-lg text-muted">
            Every paid plan starts with a 14-day trial. Pick a tier to see real
            examples of what it feels like — no account needed to look around.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {TIERS.map((t) => {
            const selected = t.key === selectedTier;
            return (
              <button
                key={t.key}
                type="button"
                aria-pressed={selected}
                onClick={() => setSelectedTier(t.key)}
                className={`relative flex flex-col gap-3 rounded-2xl border p-6 text-left transition-all ${
                  selected
                    ? 'border-flush-500 bg-raised shadow-lg shadow-flush-500/10'
                    : 'border-app bg-surface hover:border-strong hover:bg-raised'
                }`}
              >
                {t.popular && (
                  <span className="absolute -top-2.5 right-4 rounded-full bg-flush-600 px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-white">
                    Most popular
                  </span>
                )}
                <div>
                  <p className="font-display text-lg font-bold text-app">{t.name}</p>
                  <p className="mt-1">
                    <span className="font-display text-3xl font-bold text-app">
                      {t.price}
                    </span>
                    <span className="text-sm text-muted"> {t.per}</span>
                  </p>
                  <p className="mt-1 text-sm text-muted">{t.tagline}</p>
                </div>
                <ul className="flex flex-col gap-1.5 text-sm text-muted">
                  {t.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <span aria-hidden="true" className="text-flush-500">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <span
                  className={`mt-auto text-sm font-medium ${
                    selected ? 'text-flush-600' : 'text-muted'
                  }`}
                >
                  {selected ? 'Showing examples below ↓' : 'See examples →'}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-sm text-muted">
          Need more than 25 locations, custom limits, or write API access?{' '}
          <span className="font-medium text-app">Enterprise</span> starts around
          $500/mo —{' '}
          <button
            type="button"
            onClick={() => navigate('/business/request')}
            className="font-medium text-flush-600 hover:underline"
          >
            tell us what you need
          </button>
          . Billing is handled personally after approval — no card required to start.
        </p>

        {/* The selected tier's hard-coded product examples */}
        {(() => {
          const tier = TIERS.find((t) => t.key === selectedTier) ?? TIERS[1];
          return (
            <div className="flex flex-col gap-8 rounded-3xl border border-app bg-raised/50 p-6 sm:p-10">
              <div className="max-w-2xl">
                <h3 className="font-display text-2xl font-bold tracking-tight text-app">
                  {tier.showcaseTitle}
                </h3>
                <p className="mt-2 text-muted">{tier.showcaseBlurb}</p>
              </div>
              <div className="grid gap-6 lg:grid-cols-3">
                {tier.previews.map(({ caption, Component }) => (
                  <div key={caption} className="flex flex-col gap-3">
                    <p className="text-sm font-medium text-app">{caption}</p>
                    <Component />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="lg" variant="primary" onClick={() => navigate(primary.to)}>
                  {primary.label}
                </Button>
                <span className="text-sm text-muted">
                  Start on {tier.name} — upgrade any time as you grow.
                </span>
              </div>
            </div>
          );
        })()}

        {/* What you can do once approved (self-contained, brings its own heading) */}
        <InteractionOptions />
      </section>

      {/* How it works */}
      <section className="flex flex-col gap-10">
        <h2 className="font-display text-3xl font-bold tracking-tight text-app">
          How it works
        </h2>
        <ol className="grid gap-8 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-flush-500 to-cyan-500 font-display text-sm font-bold text-white shadow-lg shadow-flush-500/25">
                  {s.n}
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
              </div>
              <h3 className="font-display text-lg font-semibold text-app">
                {s.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Final CTA */}
      <section className="relative isolate overflow-hidden rounded-3xl border border-app bg-raised px-6 py-16 text-center">
        <div
          className="glow-blob -z-10 left-1/2 top-0 h-64 w-[36rem] -translate-x-1/2"
          aria-hidden="true"
        />
        <div className="grid-fade absolute inset-0 -z-10" aria-hidden="true" />
        <h2 className="mx-auto max-w-xl font-display text-3xl font-bold tracking-tight text-app sm:text-4xl">
          Put your locations to work on Watrloo.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-lg text-muted">
          Get verified, take control of your listings, and start driving foot
          traffic today.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button size="lg" variant="primary" onClick={() => navigate(primary.to)}>
            {primary.label}
          </Button>
        </div>
      </section>
    </div>
  );
}
