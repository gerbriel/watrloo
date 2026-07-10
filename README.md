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
- **Leaflet** + OpenStreetMap for maps
- **React Router v7**

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
