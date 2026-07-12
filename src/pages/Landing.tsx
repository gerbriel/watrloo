import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { AMENITY_LABELS } from '@/types/db';
import { RANKS, RANKS_TAGLINE } from '@/lib/ranks';

/** Small inline icons — no icon dependency, no emoji. */
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
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 22l-5.2-2.7 1-5.8-4.3-4.1 5.9-.9z',
  pin: 'M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  sparkle: 'M12 3v6M12 15v6M3 12h6M15 12h6',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z',
  access:
    'M12 6a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 12 6zM9 9h6M10.5 9l-1 6 4 3M13.5 9l1 4',
  plus: 'M12 5v14M5 12h14',
} as const;

const AMENITY_ORDER = [
  'wheelchair_accessible',
  'gender_neutral',
  'changing_table',
  'requires_key',
] as const;

function SampleCard() {
  return (
    <div className="card w-full max-w-sm p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-semibold text-app">
            River Park
          </p>
          <p className="text-sm text-muted">Fresno, CA</p>
        </div>
        <span className="rounded-full bg-flush-600/10 px-2.5 py-1 text-xs font-medium text-flush-500 ring-1 ring-flush-500/20">
          Open now
        </span>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Stars value={4.5} size={18} />
        <span className="font-display text-lg font-semibold text-app">4.5</span>
        <span className="text-sm text-muted">· 128 reviews</span>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
        {[
          ['Clean', '4.7'],
          ['Privacy', '4.2'],
          ['Access', '5.0'],
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

      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className="rounded-full border border-app px-2.5 py-1 text-xs text-muted">
          Wheelchair accessible
        </span>
        <span className="rounded-full border border-app px-2.5 py-1 text-xs text-muted">
          Changing table
        </span>
      </div>
    </div>
  );
}

export function Landing() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-24 pb-16">
      {/* Hero */}
      <section className="relative isolate pt-10 sm:pt-16">
        {/* Atmosphere: fading grid + two soft color glows. */}
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
              The No. 1 app for finding a No. 2 place
            </span>

            <h1
              className="rise font-display text-[2.75rem] font-bold leading-[1.05] tracking-tight text-app sm:text-6xl"
              style={{ '--rise-delay': '0.05s' } as CSSProperties}
            >
              Find a good bathroom,{' '}
              <span className="text-gradient">wherever you are.</span>
            </h1>

            <p
              className="rise max-w-md text-lg leading-relaxed text-muted"
              style={{ '--rise-delay': '0.12s' } as CSSProperties}
            >
              A map of public restrooms rated by the people who’ve used them — on
              the things that actually matter when nature declares war and
              you need somewhere to make your last stand.
            </p>

            <div
              className="rise flex flex-wrap gap-3"
              style={{ '--rise-delay': '0.18s' } as CSSProperties}
            >
              <Button size="lg" variant="primary" onClick={() => navigate('/browse')}>
                Browse bathrooms
              </Button>
              <Button size="lg" variant="secondary" onClick={() => navigate('/map')}>
                Open the map
              </Button>
            </div>

            <p
              className="rise text-sm text-muted"
              style={{ '--rise-delay': '0.24s' } as CSSProperties}
            >
              Free, and no account needed to browse. We won’t give you the runaround.
            </p>
          </div>

          <div
            className="rise flex justify-center md:justify-end"
            style={{ '--rise-delay': '0.15s' } as CSSProperties}
          >
            <SampleCard />
          </div>
        </div>
      </section>

      {/* What you can rate */}
      <section className="flex flex-col gap-10">
        <div className="max-w-2xl">
          <h2 className="font-display text-3xl font-bold tracking-tight text-app">
            Ratings that tell you what to expect
          </h2>
          <p className="mt-3 text-lg text-muted">
            A single star score hides the details. Watrloo breaks a bathroom down
            into what you’d actually want to know before walking in.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          {[
            {
              icon: ICONS.sparkle,
              title: 'Cleanliness',
              body: 'The difference between a 2 and a 5 here is the whole point.',
            },
            {
              icon: ICONS.shield,
              title: 'Privacy',
              body: 'Full stalls or gaps you could drive through — know before you commit.',
            },
            {
              icon: ICONS.access,
              title: 'Accessibility',
              body: 'Step-free access, grab bars, and room to actually turn around.',
            },
          ].map((f) => (
            <div key={f.title} className="card card-hover flex flex-col gap-3 p-6">
              <span className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-flush-500/15 to-cyan-500/15 text-flush-500 ring-1 ring-flush-500/20">
                <Icon path={f.icon} />
              </span>
              <h3 className="font-display text-lg font-semibold text-app">
                {f.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="card p-6">
          <p className="font-display font-semibold text-app">Know before you go</p>
          <p className="mt-1 text-sm text-muted">
            Every listing flags the things that make or break a trip:
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {AMENITY_ORDER.map((key) => {
              const caution = key === 'requires_key';
              return (
                <span
                  key={key}
                  className={
                    caution
                      ? 'rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-app'
                      : 'rounded-full border border-app bg-sunken px-3 py-1.5 text-sm text-muted'
                  }
                >
                  {AMENITY_LABELS[key]}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="flex flex-col gap-10">
        <h2 className="font-display text-3xl font-bold tracking-tight text-app">
          How it works
        </h2>
        <ol className="grid gap-8 sm:grid-cols-3">
          {[
            {
              n: 1,
              icon: ICONS.search,
              title: 'Search or open the map',
              body: 'Browse the directory or scan the map for restrooms near you.',
            },
            {
              n: 2,
              icon: ICONS.star,
              title: 'Read real reviews',
              body: 'Overall scores, sub-ratings, amenities, and photos from other people.',
            },
            {
              n: 3,
              icon: ICONS.plus,
              title: 'Add what you find',
              body: 'Rate a place or drop a new one on the map. It helps the next person.',
            },
          ].map((s) => (
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
      {/* Reviewer ranks — the Grande Armée du Trône */}
      <section className="flex flex-col gap-10">
        <div className="max-w-2xl">
          <h2 className="font-display text-3xl font-bold tracking-tight text-app">
            Enlist in the <span className="text-gradient">Grande Armée du Trône</span>
          </h2>
          <p className="mt-3 text-lg text-muted">
            Watrloo is named for Napoleon’s last stand — so every review you file
            is a <span className="font-medium text-app">campaign</span>, and enough
            campaigns march you up the ranks of his army. {RANKS_TAGLINE}
          </p>
        </div>

        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {RANKS.map((rank, i) => (
            <li
              key={rank.title}
              className={
                rank.tier === 'gold'
                  ? 'flex flex-col gap-1.5 rounded-xl border border-amber-500/40 bg-gradient-to-br from-amber-500/10 to-transparent p-4'
                  : 'flex flex-col gap-1.5 rounded-xl border border-app bg-raised p-4'
              }
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-display text-xs font-bold text-muted">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  className={
                    rank.tier === 'gold'
                      ? 'rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-amber-600'
                      : 'rounded-full bg-sunken px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted'
                  }
                >
                  {rank.min === 0
                    ? 'day one'
                    : `${rank.min} review${rank.min === 1 ? '' : 's'}`}
                </span>
              </div>
              <p
                className={
                  rank.tier === 'gold'
                    ? 'font-display text-base font-bold text-amber-600'
                    : 'font-display text-base font-bold text-app'
                }
              >
                {rank.title}
              </p>
              <p className="text-xs leading-relaxed text-muted">{rank.motto}</p>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" variant="primary" onClick={() => navigate('/signup')}>
            Enlist — it’s free
          </Button>
          <span className="text-sm text-muted">
            Your first review earns a promotion on the spot. No boot camp, just bathrooms.
          </span>
        </div>
      </section>

      <section className="relative isolate overflow-hidden rounded-3xl border border-app bg-raised px-6 py-16 text-center">
        <div
          className="glow-blob -z-10 left-1/2 top-0 h-64 w-[36rem] -translate-x-1/2"
          aria-hidden="true"
        />
        <div className="grid-fade absolute inset-0 -z-10" aria-hidden="true" />
        <h2 className="mx-auto max-w-xl font-display text-3xl font-bold tracking-tight text-app sm:text-4xl">
          The next bathroom you review could save someone’s afternoon.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-lg text-muted">
          Start browsing, add a throne you know, and rest assured: when you
          gotta go, this is the way to go.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button size="lg" variant="primary" onClick={() => navigate('/browse')}>
            Browse bathrooms
          </Button>
          <Button size="lg" variant="secondary" onClick={() => navigate('/bathrooms/new')}>
            Add a bathroom
          </Button>
        </div>
      </section>
    </div>
  );
}
