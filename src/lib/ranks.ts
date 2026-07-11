/**
 * Reviewer ranks — the Grande Armée du Trône.
 *
 * The app is named after Napoleon's last battle, so contributors enlist and
 * climb his army's ranks by filing reviews ("campaigns"). Pure copy + math on
 * top of `reviewer_stats.review_count`; nothing here touches the network.
 *
 * Thresholds are front-loaded (1, 3, 7…) so a new user gets promoted twice in
 * their first week, then stretch out toward a top rank worth bragging about.
 * If you edit the ladder, keep it sorted ascending by `min` — every helper
 * below assumes that.
 */

export interface Rank {
  title: string;
  /** Live reviews required to hold the rank. */
  min: number;
  /** One-liner shown on promotion and on the profile's service record. */
  motto: string;
  /** 'gold' dresses the badge up for the top of the ladder. */
  tier: 'standard' | 'gold';
}

export const RANKS: readonly Rank[] = [
  {
    title: 'Recruit',
    min: 0,
    motto: 'Enlisted. The porcelain front awaits your first report.',
    tier: 'standard',
  },
  {
    title: 'Private',
    min: 1,
    motto: 'The army’s most fitting rank — your first stall probably was one.',
    tier: 'standard',
  },
  {
    title: 'The Little Corporal',
    min: 3,
    motto: 'Napoleon’s own nickname. He started small too.',
    tier: 'standard',
  },
  {
    title: 'Sergeant-at-Latrines',
    min: 7,
    motto: 'Order in the ranks. Order in the stalls.',
    tier: 'standard',
  },
  {
    title: 'Loo-tenant',
    min: 15,
    motto: 'The rank this entire army was founded on.',
    tier: 'standard',
  },
  {
    title: 'Commode-ant',
    min: 30,
    motto: 'You command respect. Also commodes.',
    tier: 'standard',
  },
  {
    title: 'Flush Marshal',
    min: 50,
    motto: 'Discipline. Precision. Water pressure.',
    tier: 'gold',
  },
  {
    title: 'Emperor of the Throne',
    min: 100,
    motto: 'Every throne in the city answers to you.',
    tier: 'gold',
  },
];

/** The line that sells the mission, reused wherever ranks appear. */
export const RANKS_TAGLINE =
  'Every review helps a stranger win their own Watrloo.';

/** The rank held at `reviewCount` live reviews. */
export function rankFor(reviewCount: number): Rank {
  let held = RANKS[0];
  for (const rank of RANKS) {
    if (reviewCount >= rank.min) held = rank;
  }
  return held;
}

/** The next rank above `reviewCount`, or null at the top of the ladder. */
export function nextRankFor(reviewCount: number): Rank | null {
  return RANKS.find((rank) => rank.min > reviewCount) ?? null;
}

/** "Campaign" is the in-universe word for a review; pluralize it once, here. */
export function campaigns(count: number): string {
  return `${count} campaign${count === 1 ? '' : 's'}`;
}
