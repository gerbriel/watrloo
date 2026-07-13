import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import {
  battalionLeaderboard,
  battalionRoster,
  createBattalion,
  joinBattalion,
  leaveBattalion,
  assignBattalionReport,
  cancelJoinRequest,
  listDispatches,
  listEchelons,
  myBattalion,
  myJoinRequest,
  nameBattalionDetail,
  requestJoinBattalion,
  reviewCountsFor,
  setBattalionOfficer,
  setBattalionRecruitment,
  setDetailSecond,
  transferBattalionCommand,
} from '@/lib/api/social';
import { ApplicationsPanel, DisciplinePanel } from '@/components/battalion/UnitOps';
import type { BattalionStanding, EchelonRow, UnitRole } from '@/lib/api/social';
import { echelonCopy, roleTitle, secondTitle } from '@/lib/echelons';
import { RankBadge } from '@/components/review/RankBadge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * The Order of Battle. Every unit musters as a Squad and earns its way up the
 * real army ladder — each promotion (strength + campaigns, enforced by the
 * database) raises the member cap and opens officer posts. Commanders appoint
 * officers and can hand off command; the page just tells the story.
 */

/** PostgrestError isn't reliably an Error instance, so read .message off any
 *  object — and translate the constraint violations a user can actually hit. */
function errMsg(e: unknown): string {
  const msg =
    typeof e === 'object' && e != null && 'message' in e
      ? String((e as { message: unknown }).message)
      : '';
  if (msg.includes('battalions_name_key'))
    return 'That banner is already raised — pick another name.';
  if (msg.includes('battalions_name_check'))
    return 'That name won’t fit on a banner: 3–40 characters using letters (accents welcome), numbers, spaces, apostrophes, hyphens and exclamation points.';
  if (msg.includes('already enlisted'))
    return 'You are already enlisted in a battalion — desert it first.';
  return msg || 'Something went wrong.';
}

/** Share an invite link — the Web Share sheet where available (mobile),
 *  clipboard copy elsewhere. The link lands friends on a recruitment banner
 *  with a one-click enlist. */
function RecruitButton({ unitId, unitName }: { unitId: string; unitName: string }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = `${window.location.origin}/battalions?join=${unitId}`;
    const data = {
      title: `Join ${unitName} on Watrloo`,
      text: `${unitName} needs you, soldier. Enlist and campaign with us on the porcelain front.`,
      url,
    };
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(data);
      } catch {
        // user closed the share sheet — not an error
      }
    } else {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <Button variant="secondary" size="sm" onClick={() => void share()}>
      {copied ? 'Invite link copied!' : '📣 Recruit friends'}
    </Button>
  );
}

function EchelonBadge({ level, name }: { level: number; name: string }) {
  return (
    <span
      title={echelonCopy(level).flavor}
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide',
        level >= 6
          ? 'bg-amber-500/15 text-amber-600'
          : level >= 3
            ? 'bg-flush-600/10 text-flush-600'
            : 'bg-sunken text-muted',
      )}
    >
      {'★'.repeat(Math.min(level, 4))} {name}
    </span>
  );
}

function RoleChip({ level, role }: { level: number; role: UnitRole }) {
  const t = roleTitle(level, role);
  if (!t) return null;
  return (
    <span
      title={`Real-army equivalent: ${t.realRank}`}
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        role === 'commander'
          ? 'bg-amber-500/15 text-amber-600'
          : 'bg-flush-600/10 text-flush-600',
      )}
    >
      {role === 'commander' ? '⭐' : '✦'} {t.title}
    </span>
  );
}

function Roster({
  battalionId,
  level,
  viewerId,
  viewerIsCommander,
  officerNeed,
  commanderNeed,
  secondNeed,
}: {
  battalionId: string;
  level: number;
  viewerId?: string | null;
  viewerIsCommander?: boolean;
  /** Qualification bars for this unit's echelon (from battalion_echelons). */
  officerNeed?: number;
  commanderNeed?: number;
  /** Bar for a detail's second-in-command (officer bar of the echelon below). */
  secondNeed?: number;
}) {
  const qc = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ['battalionRoster', battalionId],
    queryFn: () => battalionRoster(battalionId),
  });
  const counts = useQuery({
    queryKey: ['rosterCounts', battalionId, data?.length ?? 0],
    queryFn: () => reviewCountsFor((data ?? []).map((m) => m.user_id)),
    enabled: data != null && data.length > 0,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['battalionRoster', battalionId] });
    void qc.invalidateQueries({ queryKey: ['myBattalion'] });
  };
  const officer = useMutation({
    mutationFn: ({ userId, on }: { userId: string; on: boolean }) =>
      setBattalionOfficer(userId, on),
    onSuccess: refresh,
  });
  const transfer = useMutation({
    mutationFn: (userId: string) => transferBattalionCommand(userId),
    onSuccess: refresh,
  });
  const assign = useMutation({
    mutationFn: ({ userId, officerId }: { userId: string; officerId: string | null }) =>
      assignBattalionReport(userId, officerId),
    onSuccess: refresh,
  });
  const rename = useMutation({
    mutationFn: ({ officerId, name }: { officerId: string; name: string | null }) =>
      nameBattalionDetail(officerId, name),
    onSuccess: refresh,
  });
  const second = useMutation({
    mutationFn: ({ userId, on }: { userId: string; on: boolean }) =>
      setDetailSecond(userId, on),
    onSuccess: refresh,
  });

  if (isPending) return <p className="text-sm text-muted">Mustering the roster…</p>;

  const roster = data ?? [];
  const commander = roster.find((m) => m.role === 'commander');
  const officers = roster.filter((m) => m.role === 'officer');
  const officerIds = new Set(officers.map((o) => o.user_id));
  // Seconds lead their detail's soldiers, so they list first.
  const soldiersOf = (officerId: string) =>
    roster
      .filter((m) => m.role === 'member' && m.reports_to === officerId)
      .sort((a, b) => Number(b.is_second) - Number(a.is_second));
  // Soldiers whose officer left/was dismissed fall back to the commander.
  const directSoldiers = roster.filter(
    (m) =>
      m.role === 'member' &&
      (m.reports_to == null || !officerIds.has(m.reports_to)),
  );

  // The chain ahead of the viewer, commander first.
  const me = roster.find((m) => m.user_id === viewerId);
  const viewerIsOfficer = me?.role === 'officer';
  const myOfficer =
    me?.role === 'member' && me.reports_to && officerIds.has(me.reports_to)
      ? roster.find((m) => m.user_id === me.reports_to)
      : undefined;
  const myDetailSecond =
    myOfficer && !me?.is_second
      ? soldiersOf(myOfficer.user_id).find((s) => s.is_second)
      : undefined;
  const isUnassigned = (m: (typeof roster)[number]) =>
    m.role === 'member' && (m.reports_to == null || !officerIds.has(m.reports_to));

  const row = (m: (typeof roster)[number]) => {
    const have = counts.data?.get(m.user_id) ?? 0;
    const officerOk = officerNeed == null || have >= officerNeed;
    const commandOk = commanderNeed == null || have >= commanderNeed;
    const secondOk = secondNeed == null || have >= secondNeed;
    const isViewer = m.user_id === viewerId;
    // Second controls: the commander anywhere, or an officer within their own detail.
    const canSetSecond =
      m.role === 'member' &&
      m.reports_to != null &&
      officerIds.has(m.reports_to) &&
      !isViewer &&
      (viewerIsCommander || (viewerIsOfficer && m.reports_to === viewerId));
    return (
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app px-3 py-1.5',
          isViewer ? 'bg-flush-600/5 border-flush-500/40' : 'bg-surface',
        )}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            to={`/u/${encodeURIComponent(m.profile?.username ?? '')}`}
            className="truncate text-sm font-medium text-app hover:underline"
          >
            @{m.profile?.username ?? 'unknown'}
          </Link>
          <RankBadge reviewCount={have} />
          <RoleChip level={level} role={m.role} />
          {m.is_second && (
            <span
              title={`Second-in-command — real-army equivalent: ${secondTitle(level).realRank}`}
              className="rounded-full bg-flush-600/10 px-2 py-0.5 text-xs font-medium text-flush-600"
            >
              ✦ Second — {secondTitle(level).title}
            </span>
          )}
          {isViewer && (
            <span className="rounded-full bg-flush-600/10 px-2 py-0.5 text-xs font-medium text-flush-600">
              You
            </span>
          )}
        </span>
        {viewerIsCommander && !isViewer && (
          <span className="flex flex-wrap items-center gap-1.5">
            {m.role === 'member' && officers.length > 0 && (
              <select
                aria-label={`Detail @${m.profile?.username} to an officer`}
                value={
                  m.reports_to && officerIds.has(m.reports_to) ? m.reports_to : ''
                }
                disabled={assign.isPending}
                onChange={(e) =>
                  assign.mutate({
                    userId: m.user_id,
                    officerId: e.target.value || null,
                  })
                }
                className="rounded-lg border border-app bg-surface px-2 py-1 text-xs text-app"
              >
                <option value="">Reports to you</option>
                {officers.map((o) => (
                  <option key={o.user_id} value={o.user_id}>
                    Detail: @{o.profile?.username}
                  </option>
                ))}
              </select>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={m.role !== 'officer' && !officerOk}
              title={
                m.role !== 'officer' && !officerOk
                  ? `Needs ${officerNeed} campaigns for an officer post (has ${have})`
                  : undefined
              }
              loading={officer.isPending && officer.variables?.userId === m.user_id}
              onClick={() =>
                officer.mutate({ userId: m.user_id, on: m.role !== 'officer' })
              }
            >
              {m.role === 'officer' ? 'Dismiss officer' : 'Make officer'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!commandOk}
              title={
                !commandOk
                  ? `Command takes ${commanderNeed} campaigns (has ${have})`
                  : undefined
              }
              loading={transfer.isPending && transfer.variables === m.user_id}
              onClick={() => {
                if (
                  window.confirm(
                    `Hand command to @${m.profile?.username}? You'll step down to an officer post.`,
                  )
                )
                  transfer.mutate(m.user_id);
              }}
            >
              Transfer command
            </Button>
          </span>
        )}
        {(canSetSecond || (viewerIsOfficer && !isViewer && m.role === 'member')) && (
          <span className="flex flex-wrap items-center gap-1.5">
            {canSetSecond && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!m.is_second && !secondOk}
                title={
                  !m.is_second && !secondOk
                    ? `A second takes ${secondNeed} campaigns (has ${have})`
                    : undefined
                }
                loading={second.isPending && second.variables?.userId === m.user_id}
                onClick={() => second.mutate({ userId: m.user_id, on: !m.is_second })}
              >
                {m.is_second ? 'Dismiss second' : 'Make second'}
              </Button>
            )}
            {viewerIsOfficer && m.reports_to === viewerId && (
              <Button
                variant="ghost"
                size="sm"
                loading={assign.isPending && assign.variables?.userId === m.user_id}
                onClick={() => assign.mutate({ userId: m.user_id, officerId: null })}
              >
                Release to commander
              </Button>
            )}
            {viewerIsOfficer && isUnassigned(m) && (
              <Button
                variant="ghost"
                size="sm"
                loading={assign.isPending && assign.variables?.userId === m.user_id}
                onClick={() =>
                  assign.mutate({ userId: m.user_id, officerId: viewerId ?? null })
                }
              >
                Claim to my detail
              </Button>
            )}
          </span>
        )}
      </div>
    );
  };

  /** Sub-unit banner above an officer's block: name, strength, campaigns. */
  const detailHeader = (o: (typeof roster)[number]) => {
    const squad = soldiersOf(o.user_id);
    const tally = [o, ...squad].reduce(
      (sum, m) => sum + (counts.data?.get(m.user_id) ?? 0),
      0,
    );
    const canRename = viewerIsCommander || o.user_id === viewerId;
    return (
      <div className="ml-3 flex flex-wrap items-center justify-between gap-2 pl-3">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          ⚑ {o.detail_name ?? `@${o.profile?.username}’s detail`}
          <span className="ml-2 font-normal normal-case">
            {squad.length + 1} soldier{squad.length === 0 ? '' : 's'} · {tally}{' '}
            campaign{tally === 1 ? '' : 's'}
          </span>
        </p>
        {canRename && (
          <button
            type="button"
            disabled={rename.isPending}
            onClick={() => {
              const name = window.prompt(
                'Name this detail (leave empty to clear):',
                o.detail_name ?? '',
              );
              if (name === null) return;
              rename.mutate({ officerId: o.user_id, name: name.trim() || null });
            }}
            className="text-xs text-muted underline hover:text-app"
          >
            {o.detail_name ? 'Rename' : 'Name this detail'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {me && me.role !== 'commander' && commander && (
        <p className="text-xs text-muted">
          Your chain of command:{' '}
          <span className="font-medium text-app">
            ⭐ @{commander.profile?.username}
          </span>
          {myOfficer && (
            <>
              {' → '}
              <span className="font-medium text-app">
                ✦ @{myOfficer.profile?.username}
              </span>
              {myOfficer.detail_name && (
                <span className="text-muted"> ({myOfficer.detail_name})</span>
              )}
            </>
          )}
          {myDetailSecond && (
            <>
              {' → '}
              <span className="font-medium text-app">
                ✦ @{myDetailSecond.profile?.username}
              </span>
            </>
          )}
          {' → you'}
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {commander && <li key={commander.user_id}>{row(commander)}</li>}
        {officers.map((o) => (
          <li key={o.user_id} className="flex flex-col gap-1.5">
            {detailHeader(o)}
            <div className="border-l-2 border-app pl-3">{row(o)}</div>
            {soldiersOf(o.user_id).length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {soldiersOf(o.user_id).map((s) => (
                  <li key={s.user_id} className="ml-3 border-l-2 border-app pl-6">
                    {row(s)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {directSoldiers.map((s) => (
          <li key={s.user_id} className="border-l-2 border-app pl-3">
            {row(s)}
          </li>
        ))}
      </ul>

      {viewerIsCommander && officerNeed != null && (
        <p className="text-xs text-muted">
          Posts must be earned: officer posts at this echelon take{' '}
          <span className="font-medium text-app">{officerNeed}</span> campaigns,
          command takes <span className="font-medium text-app">{commanderNeed}</span>,
          a detail's second takes{' '}
          <span className="font-medium text-app">{secondNeed}</span>. Officers can
          name their detail, appoint its second, claim unassigned soldiers, and
          release their own.
        </p>
      )}
      {(officer.isError || transfer.isError || assign.isError || rename.isError || second.isError) && (
        <p className="text-xs text-red-500">
          {errMsg(
            officer.error ?? transfer.error ?? assign.error ?? rename.error ?? second.error,
          )}
        </p>
      )}
    </div>
  );
}

/** Progress toward the next echelon: two bars, soldiers and campaigns. */
function PromotionProgress({
  standing,
  echelons,
}: {
  standing: BattalionStanding;
  echelons: EchelonRow[];
}) {
  const next = echelons.find((e) => e.level === standing.echelon + 1);
  if (!next) {
    return (
      <p className="text-sm text-muted">
        The ladder ends here. {echelonCopy(standing.echelon).flavor}
      </p>
    );
  }
  const bars = [
    { label: 'Soldiers', have: standing.member_count, need: next.min_members },
    { label: 'Campaigns', have: standing.review_count, need: next.min_campaigns },
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        Next promotion: {next.name}{' '}
        <span className="font-normal normal-case">
          (unlocks {next.member_cap} soldier slots)
        </span>
      </p>
      {bars.map((b) => {
        const pct = Math.min(100, Math.round((b.have / Math.max(b.need, 1)) * 100));
        return (
          <div key={b.label} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-muted">{b.label}</span>
            <div
              role="progressbar"
              aria-valuenow={b.have}
              aria-valuemin={0}
              aria-valuemax={b.need}
              aria-label={`${b.label} toward ${next.name}`}
              className="h-2 flex-1 overflow-hidden rounded-full bg-sunken"
            >
              <div
                className="h-full rounded-full bg-flush-500 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-xs text-app">
              {b.have}/{b.need}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StandingCard({
  b,
  i,
  isMine,
  canJoin,
  pendingHere,
  onJoin,
  onRequest,
  joining,
}: {
  b: BattalionStanding;
  i: number;
  isMine: boolean;
  canJoin: boolean;
  /** The viewer's pending application is for this unit. */
  pendingHere: boolean;
  onJoin: (id: string) => void;
  onRequest: (id: string) => void;
  joining: boolean;
}) {
  const [showRoster, setShowRoster] = useState(false);
  const full = b.member_count >= b.member_cap;
  const medal = ['🥇', '🥈', '🥉'][i];

  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-xl border bg-raised p-4',
        isMine ? 'border-flush-500/50' : 'border-app',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-label={`Rank ${i + 1}`}
            className={cn(
              'w-8 shrink-0 text-center font-display font-bold',
              medal ? 'text-lg' : 'text-sm text-muted',
            )}
          >
            {medal ?? i + 1}
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-display font-bold text-app">
              <span className="truncate">⚔️ {b.name}</span>
              <EchelonBadge level={b.echelon} name={b.echelon_name} />
              {isMine && (
                <span className="rounded-full bg-flush-600/10 px-2 py-0.5 text-xs font-medium text-flush-600">
                  Your unit
                </span>
              )}
            </p>
            {b.motto && (
              <p className="truncate text-xs text-muted italic">“{b.motto}”</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-app">
            <span className="font-bold">{b.review_count}</span>{' '}
            <span className="text-muted">campaign{b.review_count === 1 ? '' : 's'}</span>
          </span>
          <span className={cn('text-xs', full ? 'text-amber-600' : 'text-muted')}>
            · {b.member_count}/{b.member_cap} soldiers{full && ' — full strength'}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setShowRoster((s) => !s)}>
          {showRoster ? 'Hide roster' : 'View roster'}
        </Button>
        {pendingHere ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600">
            Application pending
          </span>
        ) : (
          canJoin &&
          !full &&
          (b.recruitment === 'approval' ? (
            <Button
              variant="secondary"
              size="sm"
              loading={joining}
              onClick={() => onRequest(b.id)}
            >
              Request to join
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={joining}
              onClick={() => onJoin(b.id)}
            >
              Enlist here
            </Button>
          ))
        )}
        {b.recruitment === 'approval' && (
          <span className="text-xs text-muted">By application</span>
        )}
      </div>
      {showRoster && <Roster battalionId={b.id} level={b.echelon} />}
    </li>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [motto, setMotto] = useState('');
  const create = useMutation({
    mutationFn: () => createBattalion(name, motto || undefined),
    onSuccess: onDone,
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div>
        <label htmlFor="bn-name" className="text-sm font-medium text-app">
          Unit name
        </label>
        <input
          id="bn-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={3}
          maxLength={40}
          placeholder="The Porcelain Guard"
          className="mt-1 w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
        />
        <p className="mt-1 text-xs text-muted">
          3–40 characters: letters (accents welcome), numbers, spaces,
          apostrophes, hyphens and exclamation points.
        </p>
      </div>
      <div>
        <label htmlFor="bn-motto" className="text-sm font-medium text-app">
          Motto <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="bn-motto"
          value={motto}
          onChange={(e) => setMotto(e.target.value)}
          maxLength={120}
          placeholder="We never leave a seat down."
          className="mt-1 w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
        />
      </div>
      {create.isError && (
        <p className="text-sm text-red-500">{errMsg(create.error)}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">
          New units muster as a <span className="font-medium text-app">Squad</span> —
          six slots. Recruit and campaign to earn promotions.
        </p>
        <Button type="submit" size="sm" loading={create.isPending}>
          Muster the Squad
        </Button>
      </div>
    </form>
  );
}

function Dispatches() {
  const { data } = useQuery({
    queryKey: ['unitDispatches'],
    queryFn: () => listDispatches(12),
  });
  if (!data || data.length === 0) return null;
  return (
    <section aria-label="Dispatches" className="flex flex-col gap-2">
      <h2 className="font-display text-lg font-bold text-app">
        Dispatches from the front
      </h2>
      <ul className="flex flex-col gap-1.5">
        {data.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-app bg-raised px-3 py-2 text-sm"
          >
            <span className="text-app">
              {d.kind === 'promotion' ? '🎖 ' : '🚩 '}
              <span className="font-medium">{d.battalion?.name ?? 'A unit'}</span>{' '}
              <span className="text-muted">— {d.note}</span>
            </span>
            <time dateTime={d.created_at} className="text-xs text-muted">
              {new Date(d.created_at).toLocaleDateString()}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LADDER_PREVIEW = ['Squad', 'Platoon', 'Company', 'Battalion', 'Brigade', 'Division', 'Corps', 'Field Army'];

export function Battalions() {
  const { user, profile } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const joinId = searchParams.get('join');

  const standings = useQuery({
    queryKey: ['battalionLeaderboard'],
    queryFn: battalionLeaderboard,
  });
  const echelons = useQuery({ queryKey: ['echelons'], queryFn: listEchelons });
  const mine = useQuery({
    queryKey: ['myBattalion', user?.id],
    queryFn: () => myBattalion(user!.id),
    enabled: user != null,
  });
  const myRequest = useQuery({
    queryKey: ['myJoinRequest', user?.id],
    queryFn: myJoinRequest,
    enabled: user != null && mine.data == null,
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['battalionLeaderboard'] });
    void qc.invalidateQueries({ queryKey: ['myBattalion'] });
    void qc.invalidateQueries({ queryKey: ['battalionRoster'] });
    void qc.invalidateQueries({ queryKey: ['battalionOf'] });
    void qc.invalidateQueries({ queryKey: ['unitDispatches'] });
    void qc.invalidateQueries({ queryKey: ['myJoinRequest'] });
  };

  const join = useMutation({
    mutationFn: (id: string) => joinBattalion(id),
    onSuccess: refreshAll,
  });
  const request = useMutation({
    mutationFn: ({ id, message }: { id: string; message?: string }) =>
      requestJoinBattalion(id, message),
    onSuccess: refreshAll,
  });
  const cancelRequest = useMutation({
    mutationFn: cancelJoinRequest,
    onSuccess: refreshAll,
  });
  const recruitment = useMutation({
    mutationFn: (mode: 'open' | 'approval') => setBattalionRecruitment(mode),
    onSuccess: refreshAll,
  });
  const leave = useMutation({ mutationFn: leaveBattalion, onSuccess: refreshAll });

  const startRequest = (id: string) => {
    const message = window.prompt(
      'Add a note to your application (optional — say why they should take you):',
    );
    if (message === null) return;
    request.mutate({ id, message: message.trim() || undefined });
  };

  const myStanding = standings.data?.find((b) => b.id === mine.data?.battalion_id);
  const myLevel = mine.data?.battalion?.echelon ?? 1;
  const myTitle = mine.data ? roleTitle(myLevel, mine.data.role) : null;
  const canJoin = user != null && mine.data == null && !mine.isPending;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <header>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          The Grande Armée du Trône
        </p>
        <h1 className="font-display text-2xl font-bold text-app">
          The Order of Battle
        </h1>
        <p className="mt-1 text-sm text-muted">
          Every unit starts small — a six-soldier Squad — and earns its way up
          the real army ladder by recruiting and campaigning. Promotions raise
          the roster cap and open officer posts. One unit per soldier; choose
          your comrades wisely.
        </p>
        <p className="mt-2 text-xs text-muted">
          {LADDER_PREVIEW.join(' → ')}
        </p>
      </header>

      {(() => {
        if (!joinId) return null;
        const invited = standings.data?.find((b) => b.id === joinId);
        if (!invited) return null;
        const full = invited.member_count >= invited.member_cap;
        const alreadyIn = mine.data?.battalion_id === invited.id;
        const enlistedElsewhere = mine.data != null && !alreadyIn;
        return (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-flush-500/50 bg-flush-600/5 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-wide text-flush-600 uppercase">
                You’ve been recruited
              </p>
              <p className="flex flex-wrap items-center gap-2 font-display font-bold text-app">
                <span className="truncate">⚔️ {invited.name}</span>
                <EchelonBadge level={invited.echelon} name={invited.echelon_name} />
                <span className="text-xs font-normal text-muted">
                  wants you in the ranks — {invited.member_count}/{invited.member_cap}{' '}
                  soldiers, {invited.review_count} campaign
                  {invited.review_count === 1 ? '' : 's'}
                </span>
              </p>
            </div>
            {alreadyIn ? (
              <span className="text-sm text-muted">You already serve here. 🫡</span>
            ) : enlistedElsewhere ? (
              <span className="text-sm text-muted">
                You already serve with another unit — desert it first.
              </span>
            ) : full ? (
              <span className="text-sm text-amber-600">
                Full strength — they need a promotion before they can take you.
              </span>
            ) : myRequest.data?.battalion_id === invited.id ? (
              <span className="text-sm text-amber-600">Application pending</span>
            ) : user ? (
              invited.recruitment === 'approval' ? (
                <Button
                  size="sm"
                  loading={request.isPending}
                  onClick={() => startRequest(invited.id)}
                >
                  Request to join
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={join.isPending}
                  onClick={() =>
                    join.mutate(invited.id, {
                      onSuccess: () => setSearchParams({}, { replace: true }),
                    })
                  }
                >
                  Answer the call
                </Button>
              )
            ) : (
              <Link
                to={`/signup?next=${encodeURIComponent(`/battalions?join=${invited.id}`)}`}
              >
                <Button size="sm">Enlist to join them</Button>
              </Link>
            )}
          </div>
        );
      })()}

      {user ? (
        <section className="flex flex-col gap-3">
          {mine.data ? (
            <div className="flex flex-col gap-3 rounded-xl border border-flush-500/50 bg-raised p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-display font-bold text-app">
                    <span className="truncate">⚔️ {mine.data.battalion?.name}</span>
                    <EchelonBadge
                      level={myLevel}
                      name={echelonCopy(myLevel).name}
                    />
                  </p>
                  <p className="text-xs text-muted">
                    {myTitle ? (
                      <>
                        You serve as{' '}
                        <span
                          className="font-medium text-app"
                          title={`Real-army equivalent: ${myTitle.realRank}`}
                        >
                          {myTitle.title}
                        </span>{' '}
                        ({myTitle.realRank})
                      </>
                    ) : (
                      'You serve in the ranks.'
                    )}{' '}
                    · {echelonCopy(myLevel).flavor}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <RecruitButton
                    unitId={mine.data.battalion_id}
                    unitName={mine.data.battalion?.name ?? 'Our unit'}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:bg-red-500/10"
                    loading={leave.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          mine.data?.role === 'commander'
                            ? 'Desert your own unit? Command passes to the senior officer (or the unit dissolves if you are the last one out).'
                            : 'Desert the unit?',
                        )
                      )
                        leave.mutate();
                    }}
                  >
                    Leave
                  </Button>
                </div>
              </div>

              {myStanding && echelons.data && (
                <PromotionProgress standing={myStanding} echelons={echelons.data} />
              )}

              {mine.data.role === 'commander' && myStanding && (
                <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  Recruitment:
                  <select
                    value={myStanding.recruitment}
                    disabled={recruitment.isPending}
                    onChange={(e) =>
                      recruitment.mutate(e.target.value as 'open' | 'approval')
                    }
                    className="rounded-lg border border-app bg-surface px-2 py-1 text-xs text-app"
                  >
                    <option value="open">Open — anyone can enlist</option>
                    <option value="approval">By application — you approve recruits</option>
                  </select>
                </label>
              )}

              {(mine.data.role === 'commander' || mine.data.role === 'officer') && (
                <>
                  <ApplicationsPanel />
                  <DisciplinePanel isCommander={mine.data.role === 'commander'} />
                </>
              )}

              <div className="border-t border-app pt-3">
                <Roster
                  battalionId={mine.data.battalion_id}
                  level={myLevel}
                  viewerId={user.id}
                  viewerIsCommander={mine.data.role === 'commander'}
                  officerNeed={
                    echelons.data?.find((e) => e.level === myLevel)
                      ?.officer_min_reviews
                  }
                  commanderNeed={
                    echelons.data?.find((e) => e.level === myLevel)
                      ?.commander_min_reviews
                  }
                  secondNeed={
                    myLevel <= 1
                      ? 1
                      : echelons.data?.find((e) => e.level === myLevel - 1)
                          ?.officer_min_reviews
                  }
                />
              </div>
            </div>
          ) : creating ? (
            <CreateForm
              onDone={() => {
                setCreating(false);
                refreshAll();
              }}
            />
          ) : myRequest.data ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-raised px-4 py-3">
              <p className="text-sm text-muted">
                Your application to{' '}
                <span className="font-medium text-app">
                  ⚔️ {myRequest.data.battalion_name}
                </span>{' '}
                is with their brass.
              </p>
              <Button
                variant="ghost"
                size="sm"
                loading={cancelRequest.isPending}
                onClick={() => cancelRequest.mutate()}
              >
                Withdraw
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-app bg-raised px-4 py-3">
              <p className="text-sm text-muted">
                {profile ? `@${profile.username}, you` : 'You'} march alone.
                Muster a Squad, or enlist in a unit below.
              </p>
              <Button size="sm" onClick={() => setCreating(true)}>
                Muster a Squad
              </Button>
            </div>
          )}
          {(join.isError || leave.isError || request.isError || recruitment.isError) && (
            <p className="text-sm text-red-500">
              {errMsg(join.error ?? leave.error ?? request.error ?? recruitment.error)}
            </p>
          )}
        </section>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-app bg-raised px-4 py-3">
          <p className="text-sm text-muted">Sign in to muster or join a unit.</p>
          <Link to="/signin">
            <Button variant="secondary" size="sm">
              Sign in
            </Button>
          </Link>
        </div>
      )}

      <section aria-label="Unit standings" className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold text-app">Standings</h2>
        {standings.isPending && (
          <div className="h-48 animate-pulse rounded-xl border border-app bg-raised" />
        )}
        {standings.isError && (
          <p className="text-sm text-red-500">{errMsg(standings.error)}</p>
        )}
        {standings.data && standings.data.length === 0 && (
          <p className="rounded-xl border border-app bg-raised p-6 text-center text-sm text-muted">
            No units yet. History awaits its first banner.
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {standings.data?.map((b, i) => (
            <StandingCard
              key={b.id}
              b={b}
              i={i}
              isMine={mine.data?.battalion_id === b.id}
              canJoin={canJoin && myRequest.data == null}
              pendingHere={myRequest.data?.battalion_id === b.id}
              onJoin={(id) => join.mutate(id)}
              onRequest={startRequest}
              joining={
                (join.isPending && join.variables === b.id) ||
                (request.isPending && request.variables?.id === b.id)
              }
            />
          ))}
        </ul>
      </section>

      <Dispatches />

      <p className="text-xs text-muted">
        Looking for individual standings? March to the{' '}
        <Link to="/leaderboard" className="underline hover:text-app">
          Hall of Marshals
        </Link>
        .
      </p>
    </div>
  );
}
