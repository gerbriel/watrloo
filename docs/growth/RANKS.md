# Reviewer ranks — the Grande Armée du Trône

Watrloo is named after Napoleon's last battle, so contributors don't collect
"points" — they enlist. Every live review is a **campaign**, and campaigns
promote you through the ranks of the porcelain army. The framing is the
retention hook: reviewers are heroes, and the line that carries it everywhere
is *"Every review helps a stranger win their own Watrloo."*

Non-financial by design: ranks buy nothing, unlock nothing, and cost nothing.
They are pure bragging rights, which keeps them out of scope for payments,
tax, and fairness complaints.

## The ladder

| Campaigns | Rank | Motto |
| --- | --- | --- |
| 0 | Recruit | Enlisted. The porcelain front awaits your first report. |
| 1 | Private | The army's most fitting rank — your first stall probably was one. |
| 3 | The Little Corporal | Napoleon's own nickname. He started small too. |
| 7 | Sergeant-at-Latrines | Order in the ranks. Order in the stalls. |
| 15 | Loo-tenant | The rank this entire army was founded on. |
| 30 | Commode-ant | You command respect. Also commodes. |
| 50 | Flush Marshal ⚜ | Discipline. Precision. Water pressure. |
| 100 | Emperor of the Throne ⚜ | Every throne in the city answers to you. |

Thresholds are front-loaded so a new user is promoted twice in their first
week (1 → 3), then stretch toward a top rank worth bragging about. ⚜ marks
the gold tier, which gets a dressed-up badge.

## Mechanics

- **Source of truth**: `reviewer_stats` view (migration
  `20260712000000_reviewer_ranks.sql`) — live (non-soft-deleted) reviews per
  profile. Moderation removal therefore *demotes* automatically; restore
  re-promotes. No stored rank, no drift.
- **Ladder + copy**: `src/lib/ranks.ts`. Client-side only; renaming a rank is
  a copy change, not a migration.
- **Badge**: `RankBadge` on every review card (hover = count + motto).
  Recruits show nothing — the badge is earned.
- **Profile**: `ServiceRecord` card — current rank, motto, progress bar, and
  campaigns remaining to the next promotion.
- **The moment**: after posting a new review, `ReviewForm` shows "Campaign
  logged — N more to make ⟨rank⟩", or a gold promotion banner when a
  threshold is crossed. Edits are upserts and stay silent.

## Shipped after v1

- **Leaderboard** ("Hall of Marshals", `/leaderboard`, migration
  `20260714000000`) — public top-25 by live review count via the
  `leaderboard` view. Usernames + counts only (both already public on review
  cards); PII stays in `profile_private`. The viewer's own row is highlighted.

## Deliberately not in v1

- **Streaks** — punishing lapses fits a language app, not a bathroom app; a
  "weeks on campaign" streak could come later if retention data wants it.
- **Medals** for specific feats (first photo, first review in a neighborhood,
  reviewing during Oktoberfest…) — the fun ceiling is high, the schema cost
  is a `medals` table; later.
