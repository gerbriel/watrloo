/**
 * Unit echelons — the Order of Battle.
 *
 * Units climb the real U.S. Army ladder (Squad → Field Army). The numbers
 * (member caps, promotion requirements) live in the `battalion_echelons`
 * table so the server enforces them; this file is the copy layer: names,
 * flavor, and the commander/officer titles. Every commanding rank is the real
 * one from the Army chart paired 1:1 with its punny twin, same joke as the
 * reviewer ladder in `ranks.ts`.
 *
 * Officers lead the sub-units, so an echelon's officer title is simply the
 * commander title of the echelon below — a Battalion's officers are its
 * Company commanders, exactly like the real org chart.
 */

export interface EchelonCopy {
  level: number;
  name: string;
  /** Punny commander title, and the real rank it puns on. */
  commanderTitle: string;
  commanderRealRank: string;
  flavor: string;
}

export const ECHELONS: readonly EchelonCopy[] = [
  {
    level: 1,
    name: 'Squad',
    commanderTitle: 'Stall Sergeant',
    commanderRealRank: 'Sergeant',
    flavor: 'Six brave souls and one shared plunger.',
  },
  {
    level: 2,
    name: 'Platoon',
    commanderTitle: 'Second Loo-tenant',
    commanderRealRank: 'Second Lieutenant',
    flavor: 'Big enough to hold formation — and the door.',
  },
  {
    level: 3,
    name: 'Company',
    commanderTitle: 'Captain of the Head',
    commanderRealRank: 'Captain',
    flavor: 'Now with matching regulation towels.',
  },
  {
    level: 4,
    name: 'Battalion',
    commanderTitle: 'Loo-tenant Colonel',
    commanderRealRank: 'Lieutenant Colonel',
    flavor: 'A name feared in every food court.',
  },
  {
    level: 5,
    name: 'Brigade',
    commanderTitle: 'Colon-el',
    commanderRealRank: 'Colonel',
    flavor: 'Several cities. One standard of porcelain.',
  },
  {
    level: 6,
    name: 'Division',
    commanderTitle: 'Major General Relief',
    commanderRealRank: 'Major General',
    flavor: 'Logistics now include a bulk TP contract.',
  },
  {
    level: 7,
    name: 'Corps',
    commanderTitle: 'Loo-tenant General',
    commanderRealRank: 'Lieutenant General',
    flavor: 'Your latrine doctrine is taught at the academy.',
  },
  {
    level: 8,
    name: 'Field Army',
    commanderTitle: 'Supreme Allied Commode-r',
    commanderRealRank: 'General',
    flavor: 'Last fielded in Desert Storm. And now, you.',
  },
];

/** Copy for a level; clamps so a bad value never crashes the render. */
export function echelonCopy(level: number): EchelonCopy {
  return ECHELONS[Math.min(Math.max(level, 1), ECHELONS.length) - 1];
}

export type UnitRole = 'commander' | 'officer' | 'member';

/** Officer title for a Squad, the one echelon with no sub-unit below it. */
const SQUAD_OFFICER = { title: 'Corporal Clog', realRank: 'Corporal' };

/** The title a member holds, given their unit's echelon. */
export function roleTitle(
  level: number,
  role: UnitRole,
): { title: string; realRank: string } | null {
  const e = echelonCopy(level);
  if (role === 'commander') {
    return { title: e.commanderTitle, realRank: e.commanderRealRank };
  }
  if (role === 'officer') {
    if (level <= 1) return SQUAD_OFFICER;
    const below = echelonCopy(level - 1);
    return { title: below.commanderTitle, realRank: below.commanderRealRank };
  }
  return null; // plain soldiers show their personal reviewer rank instead
}
