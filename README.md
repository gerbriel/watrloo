# Watrloo

Find and rate public bathrooms. Like Yelp, but for the room you actually need
right now.

Rate a place overall, then on the things that matter — cleanliness, privacy,
accessibility — and flag the facts you want to know before you walk in: is it
wheelchair accessible, is it gender neutral, is there a changing table, do you
have to ask someone for a key.

## Stack

- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS v4** (tokens in `src/index.css`, no config file)
- **Supabase** — Postgres, auth, storage, row level security
- **MapLibre GL** + a self-hosted [PMTiles](https://docs.protomaps.com/pmtiles/) basemap
- **TanStack Query** for server state
- **React Router v7**

Watrloo calls no third-party APIs. The map is a static file you host rather
than a tile service, search and duplicate detection run inside Postgres, and
photos are compressed in the browser. Supabase is the only backend.
See [docs/BASEMAP.md](docs/BASEMAP.md) for why, and how.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase URL + publishable key
npm run dev
```

Both env values are safe to ship in a browser bundle: the publishable key is
constrained by row level security. **Never put the `service_role` key in a
`VITE_`-prefixed variable** — Vite inlines those into the client bundle.

## Database

Schema lives in `supabase/migrations/`. To apply it to a fresh project:

```bash
supabase link --project-ref <your-ref>
supabase db push
```

Optional sample data: `supabase/seed.sql`.

### Model

| table            | what it holds                                                       |
| ---------------- | ------------------------------------------------------------------- |
| `profiles`       | public identity, 1:1 with `auth.users`, created by a trigger        |
| `bathrooms`      | the rated place — location + the four amenity flags                 |
| `reviews`        | one per (bathroom, author); overall score + three optional subscores |
| `review_photos`  | pointers into the `review-photos` storage bucket                    |
| `bathroom_stats` | a view: review count and average scores per bathroom                |

Amenities live on `bathrooms` rather than on `reviews` because they are facts
about the place, not opinions about it.

Two RPCs do work the client shouldn't: `search_bathrooms` ranks a trigram-indexed
fuzzy match over name and address, and `nearby_bathrooms` uses a PostGIS
`ST_DWithin` lookup against a generated `geog` column to warn about duplicate
entries before you add one.

## Documentation

| doc | what's in it |
| --- | --- |
| [BASEMAP.md](docs/BASEMAP.md) | Building and hosting the self-contained basemap |
| [TECH_EVALUATION.md](docs/TECH_EVALUATION.md) | Dependency choices, with licenses and rejections |
| [ops/SECURITY.md](docs/ops/SECURITY.md) | RLS audit: attacks, findings, hardening SQL |
| [ops/RATE_LIMITING.md](docs/ops/RATE_LIMITING.md) | Abuse surfaces and in-Postgres throttling |
| [ops/SCALING.md](docs/ops/SCALING.md) | Where this breaks first, with the arithmetic |
| [ops/AVAILABILITY.md](docs/ops/AVAILABILITY.md) | Failure modes, backups, and the restore drill |
| [ops/OBSERVABILITY.md](docs/ops/OBSERVABILITY.md) | Error capture without a third-party SaaS |
| [ops/USERS_AND_ROLES.md](docs/ops/USERS_AND_ROLES.md) | Role model and the privilege-escalation trap |
| [legal/PRIVACY_NOTES.md](docs/legal/PRIVACY_NOTES.md) | Data inventory and compliance analysis |
| [legal/PRIVACY_POLICY.md](docs/legal/PRIVACY_POLICY.md) | Draft policy — **not legal advice** |

### Security

Row level security is on for every table. Reads are public — it's a directory,
anonymous users have to be able to browse. Writes require authentication and are
scoped to the acting user: you can only insert a review whose `author_id` is
your own uid, and you can only edit or delete your own rows. Storage uploads are
confined to a `<user_id>/` prefix, so one user cannot overwrite another's photos.

The `bathroom_stats` view is declared `security_invoker`, so it evaluates the
querying user's policies rather than the view owner's and cannot be used to read
around RLS.

## Scripts

| command             | does                         |
| ------------------- | ---------------------------- |
| `npm run dev`       | dev server                   |
| `npm run build`     | typecheck + production build |
| `npm run typecheck` | types only, no emit          |
| `npm run lint`      | oxlint                       |

## License

MIT
