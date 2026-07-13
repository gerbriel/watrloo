-- The Grande Armée speaks French: battalion names must accept accented
-- letters. The original CHECK was ASCII-only ([A-Za-z0-9]), which rejected
-- 'Grande Armée du Trône' — the first name anyone actually tried to raise.
-- [[:alnum:]] is locale-aware (the database is UTF-8), so é, ô, ñ, etc.
-- qualify while the shape rules stay: 3–40 chars, starts alphanumeric,
-- then letters/numbers/spaces/apostrophes/hyphens/exclamation points.

alter table public.battalions drop constraint if exists battalions_name_check;
alter table public.battalions add constraint battalions_name_check
  check (name ~ '^[[:alnum:]][[:alnum:] ''!-]{2,39}$');
