import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import {
  battalionLeaderboard,
  battalionRoster,
  createBattalion,
  joinBattalion,
  leaveBattalion,
  myBattalion,
} from '@/lib/api/social';
import type { BattalionStanding } from '@/lib/api/social';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Battalions: squad up, pool your campaigns, and march up the team standings.
 * One battalion per soldier; the database RPCs hold the invariants (leadership
 * succession, empty battalions dissolve), the page just tells the story.
 */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

function MedalOrRank({ i }: { i: number }) {
  const medal = ['🥇', '🥈', '🥉'][i];
  return (
    <span
      aria-label={`Rank ${i + 1}`}
      className={cn(
        'w-8 shrink-0 text-center font-display font-bold',
        medal ? 'text-lg' : 'text-sm text-muted',
      )}
    >
      {medal ?? i + 1}
    </span>
  );
}

function Roster({ battalionId }: { battalionId: string }) {
  const { data, isPending } = useQuery({
    queryKey: ['battalionRoster', battalionId],
    queryFn: () => battalionRoster(battalionId),
  });
  if (isPending) return <p className="text-sm text-muted">Mustering the roster…</p>;
  return (
    <ul className="flex flex-wrap gap-2">
      {data?.map((m) => (
        <li key={m.user_id}>
          <Link
            to={`/u/${encodeURIComponent(m.profile?.username ?? '')}`}
            className="flex items-center gap-1.5 rounded-full border border-app bg-surface px-2.5 py-1 text-sm text-app hover:bg-sunken"
          >
            {m.role === 'leader' && <span aria-label="Leader">⭐</span>}
            @{m.profile?.username ?? 'unknown'}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function StandingCard({
  b,
  i,
  isMine,
  canJoin,
  onJoin,
  joining,
}: {
  b: BattalionStanding;
  i: number;
  isMine: boolean;
  canJoin: boolean;
  onJoin: (id: string) => void;
  joining: boolean;
}) {
  const [showRoster, setShowRoster] = useState(false);
  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-xl border bg-raised p-4',
        isMine ? 'border-flush-500/50' : 'border-app',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MedalOrRank i={i} />
          <div className="min-w-0">
            <p className="truncate font-display font-bold text-app">
              ⚔️ {b.name}
              {isMine && (
                <span className="ml-2 rounded-full bg-flush-600/10 px-2 py-0.5 text-xs font-medium text-flush-600">
                  Your battalion
                </span>
              )}
            </p>
            {b.motto && (
              <p className="truncate text-xs text-muted italic">“{b.motto}”</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-app">
            <span className="font-bold">{b.review_count}</span>{' '}
            <span className="text-muted">
              campaign{b.review_count === 1 ? '' : 's'}
            </span>
          </span>
          <span className="text-xs text-muted">
            · {b.member_count} soldier{b.member_count === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => setShowRoster((s) => !s)}>
          {showRoster ? 'Hide roster' : 'View roster'}
        </Button>
        {canJoin && (
          <Button
            variant="secondary"
            size="sm"
            loading={joining}
            onClick={() => onJoin(b.id)}
          >
            Enlist here
          </Button>
        )}
      </div>
      {showRoster && <Roster battalionId={b.id} />}
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
          Battalion name
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
          3–40 characters: letters, numbers, spaces, apostrophes, hyphens and
          exclamation points.
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
      <div className="flex justify-end">
        <Button type="submit" size="sm" loading={create.isPending}>
          Raise the banner
        </Button>
      </div>
    </form>
  );
}

export function Battalions() {
  const { user, profile } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const standings = useQuery({
    queryKey: ['battalionLeaderboard'],
    queryFn: battalionLeaderboard,
  });

  const mine = useQuery({
    queryKey: ['myBattalion', user?.id],
    queryFn: () => myBattalion(user!.id),
    enabled: user != null,
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['battalionLeaderboard'] });
    void qc.invalidateQueries({ queryKey: ['myBattalion'] });
    void qc.invalidateQueries({ queryKey: ['battalionRoster'] });
    void qc.invalidateQueries({ queryKey: ['battalionOf'] });
  };

  const join = useMutation({
    mutationFn: (id: string) => joinBattalion(id),
    onSuccess: refreshAll,
  });
  const leave = useMutation({
    mutationFn: leaveBattalion,
    onSuccess: refreshAll,
  });

  const enlisted = mine.data != null;
  const canJoin = user != null && !enlisted && !mine.isPending;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <header>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          The Grande Armée du Trône
        </p>
        <h1 className="font-display text-2xl font-bold text-app">Battalions</h1>
        <p className="mt-1 text-sm text-muted">
          Individual glory is fine, but empires are built by armies. Squad up —
          every live review a member files counts toward the battalion's
          campaign total. One battalion per soldier; choose your comrades
          wisely.
        </p>
      </header>

      {user ? (
        <section className="flex flex-col gap-3">
          {mine.data ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-flush-500/50 bg-raised px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {mine.data.role === 'leader' ? 'You lead' : 'You serve with'}
                </p>
                <p className="truncate font-display font-bold text-app">
                  ⚔️ {mine.data.battalion?.name}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:bg-red-500/10"
                loading={leave.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      mine.data?.role === 'leader'
                        ? 'Desert your own battalion? Command passes to the longest-serving member (or the battalion dissolves if you are the last one out).'
                        : 'Desert the battalion?',
                    )
                  )
                    leave.mutate();
                }}
              >
                Leave
              </Button>
            </div>
          ) : creating ? (
            <CreateForm
              onDone={() => {
                setCreating(false);
                refreshAll();
              }}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-app bg-raised px-4 py-3">
              <p className="text-sm text-muted">
                {profile ? `@${profile.username}, you` : 'You'} march alone.
                Found a battalion, or enlist in one below.
              </p>
              <Button size="sm" onClick={() => setCreating(true)}>
                Found a battalion
              </Button>
            </div>
          )}
          {(join.isError || leave.isError) && (
            <p className="text-sm text-red-500">
              {errMsg(join.error ?? leave.error)}
            </p>
          )}
        </section>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-app bg-raised px-4 py-3">
          <p className="text-sm text-muted">
            Sign in to found or join a battalion.
          </p>
          <Link to="/signin">
            <Button variant="secondary" size="sm">
              Sign in
            </Button>
          </Link>
        </div>
      )}

      <section aria-label="Battalion standings" className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold text-app">Standings</h2>
        {standings.isPending && (
          <div className="h-48 animate-pulse rounded-xl border border-app bg-raised" />
        )}
        {standings.isError && (
          <p className="text-sm text-red-500">{errMsg(standings.error)}</p>
        )}
        {standings.data && standings.data.length === 0 && (
          <p className="rounded-xl border border-app bg-raised p-6 text-center text-sm text-muted">
            No battalions yet. History awaits its first banner.
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {standings.data?.map((b, i) => (
            <StandingCard
              key={b.id}
              b={b}
              i={i}
              isMine={mine.data?.battalion_id === b.id}
              canJoin={canJoin}
              onJoin={(id) => join.mutate(id)}
              joining={join.isPending && join.variables === b.id}
            />
          ))}
        </ul>
      </section>

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
