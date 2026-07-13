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
  /** The real rank (or historical title) this one puns on — shown 1:1. */
  realRank: string;
  /** Live reviews required to hold the rank. */
  min: number;
  /** One-liner shown on promotion and on the profile's service record. */
  motto: string;
  /** 'gold' dresses the badge up for the top of the ladder. */
  tier: 'standard' | 'gold';
}

/**
 * The ladder passes through EVERY unit command rank at exactly the campaign
 * count that `battalion_echelons` demands for the matching post — hold the
 * rank and you hold the commission (Sergeant-at-Latrines commands a Squad,
 * Loo-tenant a Platoon … Supreme Allied Commode-r a Field Army). Above
 * General, the last four are prestige ranks beyond any post.
 */
export const RANKS: readonly Rank[] = [
  {
    title: 'Recruit',
    realRank: 'Recruit',
    min: 0,
    motto: 'Enlisted. The porcelain front awaits your first report.',
    tier: 'standard',
  },
  {
    title: 'Private',
    realRank: 'Private',
    min: 1,
    motto: 'The army’s most fitting rank — your first stall probably was one.',
    tier: 'standard',
  },
  {
    title: 'The Little Corporal',
    realRank: 'Corporal',
    min: 3,
    motto: 'Napoleon’s own nickname. Qualifies you for a Squad officer post.',
    tier: 'standard',
  },
  {
    title: 'Sergeant-at-Latrines',
    realRank: 'Sergeant',
    min: 7,
    motto: 'Order in the ranks. Order in the stalls. Fit to command a Squad.',
    tier: 'standard',
  },
  {
    title: 'Loo-tenant',
    realRank: 'Second Lieutenant',
    min: 15,
    motto: 'The rank this army was founded on — and a Platoon needs one.',
    tier: 'standard',
  },
  {
    title: 'Captain of the Head',
    realRank: 'Captain',
    min: 30,
    motto: 'In the navy they call it the head. A Company calls it yours.',
    tier: 'standard',
  },
  {
    title: 'Commode-ant',
    realRank: 'Commandant (Major)',
    min: 40,
    motto: 'You command respect. Also commodes.',
    tier: 'standard',
  },
  {
    title: 'Loo-tenant Colonel',
    realRank: 'Lieutenant Colonel',
    min: 50,
    motto: 'Half this rank is “loo.” You’ve earned every letter — and a Battalion.',
    tier: 'standard',
  },
  {
    title: 'Colon-el',
    realRank: 'Colonel',
    min: 100,
    motto: 'The pun writes itself. The Brigade doesn’t.',
    tier: 'standard',
  },
  {
    title: 'Major General Relief',
    realRank: 'Major General',
    min: 150,
    motto: 'The very model of a modern Major General Relief. Divisions salute.',
    tier: 'standard',
  },
  {
    title: 'Loo-tenant General',
    realRank: 'Lieutenant General',
    min: 250,
    motto: 'Three stars. Zero splashback. A Corps awaits your command.',
    tier: 'standard',
  },
  {
    title: 'Supreme Allied Commode-r',
    realRank: 'General',
    min: 400,
    motto: 'Every theater of operations has working plumbing now. Take the Field Army.',
    tier: 'gold',
  },
  {
    title: 'Flush Marshal',
    realRank: 'Field Marshal',
    min: 500,
    motto: 'Discipline. Precision. Water pressure.',
    tier: 'gold',
  },
  {
    title: 'Emperor of the Throne',
    realRank: 'Emperor of the French',
    min: 700,
    motto: 'Every throne in the city answers to you.',
    tier: 'gold',
  },
  {
    title: 'The Old Guard',
    realRank: 'Imperial Old Guard',
    min: 850,
    motto: 'Beyond rank now. The Guard flushes; it never surrenders.',
    tier: 'gold',
  },
  {
    title: 'Victor of Watrloo',
    realRank: 'Duke of Wellington',
    min: 1000,
    motto: 'Napoleon lost his. You’ve won a thousand.',
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
