import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/auth/AuthProvider';

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

/** A verified "storefront" preview that echoes Landing's SampleCard styling. */
function StorefrontCard() {
  return (
    <div className="card w-full max-w-sm p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-semibold text-app">
            Bean &amp; Bar Coffee
          </p>
          <p className="text-sm text-muted">6 locations · Fresno, CA</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-flush-600/10 px-2.5 py-1 text-xs font-medium text-flush-500 ring-1 ring-flush-500/20">
          <Icon path={ICONS.verified} className="size-3.5" />
          Official
        </span>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
        {[
          ['Listings', '6'],
          ['Avg rating', '4.6'],
          ['Reviews', '312'],
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
          <p className="text-sm font-medium text-app">Free coffee with any pastry</p>
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
