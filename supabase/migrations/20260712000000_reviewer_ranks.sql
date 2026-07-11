-- Watrloo: reviewer ranks ("the Grande Armée du Trône").
--
-- Reviewers climb Napoleonic ranks by review count — the app is named after
-- the battle, so contributors get to *win* their Waterloo. The ladder itself
-- (titles, thresholds) is client-side copy in src/lib/ranks.ts; the database
-- only publishes the number it hangs off: live reviews per profile.
--
-- Same shape as bathroom_stats: a security_invoker view over public data,
-- fetched in a second query and merged in JS (PostgREST can't embed a view
-- with no visible FK). Soft-deleted reviews are filtered in the view itself,
-- not just via the reader's RLS, so a moderator's rank math matches everyone
-- else's and removed content never counts toward a rank.

create view public.reviewer_stats
with (security_invoker = on) as
select
  p.id           as profile_id,
  count(r.id)::int as review_count
from public.profiles p
left join public.reviews r
  on r.author_id = p.id and r.deleted_at is null
group by p.id;

-- The view aggregates by author over live rows; the existing author index
-- carries deleted rows too, so give the hot path a partial one.
create index reviews_author_live_idx on public.reviews (author_id)
  where deleted_at is null;
