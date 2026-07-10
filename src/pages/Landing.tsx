import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { AMENITY_LABELS } from '@/types/db';

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

/** Amenity flags, in a marketing-friendly order with the caution last. */
const AMENITY_ORDER = [
  'wheelchair_accessible',
  'gender_neutral',
  'changing_table',
  'requires_key',
] as const;

function SampleCard() {
  return (
    <div className="w-full max-w-sm rounded-2xl border border-app bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-app">Ferry Building Marketplace</p>
          <p className="text-sm text-muted">San Francisco, CA</p>
        </div>
        <span className="rounded-full bg-flush-600/10 px-2 py-0.5 text-xs font-medium text-flush-600">
          Open
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Stars value={4.5} size={18} />
        <span className="text-sm font-medium text-app">4.5</span>
        <span className="text-sm text-muted">· 128 reviews</span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        {[
          ['Clean', 4.7],
          ['Privacy', 4.2],
          ['Access', 5.0],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-raised py-2">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="text-sm font-semibold text-app">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className="rounded-full border border-app px-2 py-0.5 text-xs text-muted">
          Wheelchair accessible
        </span>
        <span className="rounded-full border border-app px-2 py-0.5 text-xs text-muted">
          Changing table
        </span>
      </div>
    </div>
  );
}

export function Landing() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-20 py-6">
      {/* Hero */}
      <section className="grid items-center gap-10 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-raised px-3 py-1 text-xs font-medium text-muted">
            <Icon path={ICONS.pin} className="size-3.5 text-flush-500" />
            Community-sourced restroom reviews
          </span>

          <h1 className="text-4xl font-bold tracking-tight text-app sm:text-5xl">
            Find a good bathroom,{' '}
            <span className="text-flush-500">wherever you are.</span>
          </h1>

          <p className="max-w-md text-lg text-muted">
            Watrloo is a map of public restrooms rated by the people who’ve used
            them — on the things that actually matter when you’re out and need
            one now.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button size="lg" variant="primary" onClick={() => navigate('/browse')}>
              Browse bathrooms
            </Button>
            <Button size="lg" variant="secondary" onClick={() => navigate('/map')}>
              Open the map
            </Button>
          </div>

          <p className="text-sm text-muted">
            Free, no account needed to browse. Add a review in seconds.
          </p>
        </div>

        <div className="flex justify-center md:justify-end">
          <SampleCard />
        </div>
      </section>

      {/* What you can rate */}
      <section className="flex flex-col gap-8">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-bold tracking-tight text-app">
            Ratings that tell you what to expect
          </h2>
          <p className="mt-2 text-muted">
            A single star score hides the details. Watrloo breaks a bathroom down
            into what you’d actually want to know before walking in.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: ICONS.sparkle,
              title: 'Cleanliness',
              body: 'Because the difference between a 2 and a 5 here is the whole point.',
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
            <div
              key={f.title}
              className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-5"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-flush-600/10 text-flush-600">
                <Icon path={f.icon} />
              </span>
              <h3 className="font-semibold text-app">{f.title}</h3>
              <p className="text-sm text-muted">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-app bg-surface p-5">
          <p className="text-sm font-medium text-app">Know before you go</p>
          <p className="mt-1 text-sm text-muted">
            Every listing flags the things that make or break a trip:
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {AMENITY_ORDER.map((key) => {
              const caution = key === 'requires_key';
              return (
                <span
                  key={key}
                  className={
                    caution
                      ? 'rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm text-app'
                      : 'rounded-full border border-app px-3 py-1 text-sm text-muted'
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
      <section className="flex flex-col gap-8">
        <h2 className="text-2xl font-bold tracking-tight text-app">
          How it works
        </h2>
        <ol className="grid gap-6 sm:grid-cols-3">
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
              body: 'See overall scores, sub-ratings, amenities, and photos from other people.',
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
                <span className="flex size-8 items-center justify-center rounded-full bg-flush-600 text-sm font-bold text-white">
                  {s.n}
                </span>
                <span className="text-muted">
                  <Icon path={s.icon} />
                </span>
              </div>
              <h3 className="font-semibold text-app">{s.title}</h3>
              <p className="text-sm text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Final CTA */}
      <section className="flex flex-col items-center gap-5 rounded-2xl border border-app bg-raised px-6 py-12 text-center">
        <h2 className="max-w-xl text-2xl font-bold tracking-tight text-app sm:text-3xl">
          The next bathroom you find could save someone’s afternoon.
        </h2>
        <p className="max-w-md text-muted">
          Start browsing, or add the first review for a place you know.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
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
