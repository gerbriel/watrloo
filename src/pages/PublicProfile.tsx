import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import {
  battalionOf,
  followStats,
  profileByUsername,
  reviewsByAuthor,
  setFollow,
} from '@/lib/api/social';
import { echelonCopy, roleTitle } from '@/lib/echelons';
import { ServiceRecord } from '@/components/review/ServiceRecord';
import { Stars } from '@/components/ui/Stars';
import { Button } from '@/components/ui/Button';

/**
 * A soldier's public dossier: rank and service record, battalion, follower
 * counts, and their reviews. Everything here is world-readable data — the
 * page adds no privacy surface beyond what review cards already show.
 */

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
  });
}

export function PublicProfile() {
  const { username = '' } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();

  const profileQ = useQuery({
    queryKey: ['publicProfile', username],
    queryFn: () => profileByUsername(username),
  });
  const profile = profileQ.data;
  const isSelf = user != null && profile != null && user.id === profile.id;

  const statsQ = useQuery({
    queryKey: ['followStats', profile?.id, user?.id ?? 'anon'],
    queryFn: () => followStats(profile!.id, user?.id),
    enabled: profile != null,
  });

  const battalionQ = useQuery({
    queryKey: ['battalionOf', profile?.id],
    queryFn: () => battalionOf(profile!.id),
    enabled: profile != null,
  });

  const reviewsQ = useQuery({
    queryKey: ['reviewsByAuthor', profile?.id],
    queryFn: () => reviewsByAuthor(profile!.id),
    enabled: profile != null,
  });

  const follow = useMutation({
    mutationFn: (next: boolean) => setFollow(user!.id, profile!.id, next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['followStats', profile?.id] });
    },
  });

  if (profileQ.isPending) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="h-64 animate-pulse rounded-xl border border-app bg-raised" />
      </div>
    );
  }

  if (profileQ.isError || !profile) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-3 px-4 py-12">
        <h1 className="font-display text-2xl font-bold text-app">
          Soldier not found
        </h1>
        <p className="text-sm text-muted">
          No one by the name @{username} serves in the Grande Armée du Trône.
          They may have deserted, or never enlisted.
        </p>
        <Link to="/leaderboard">
          <Button variant="secondary" size="sm">
            Back to the Hall of Marshals
          </Button>
        </Link>
      </div>
    );
  }

  const stats = statsQ.data;
  const battalion = battalionQ.data;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {profile.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt=""
              className="size-14 rounded-full border border-app object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex size-14 items-center justify-center rounded-full border border-app bg-raised text-xl font-bold text-muted"
            >
              {profile.username.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="font-display text-2xl font-bold text-app">
              @{profile.username}
            </h1>
            <p className="text-xs text-muted">
              Enlisted {fmt(profile.created_at)}
              {stats && (
                <>
                  {' '}
                  · {stats.followers} follower{stats.followers === 1 ? '' : 's'} ·{' '}
                  {stats.following} following
                </>
              )}
            </p>
          </div>
        </div>

        {isSelf ? (
          <Link to="/profile">
            <Button variant="secondary" size="sm">
              Edit your profile
            </Button>
          </Link>
        ) : user ? (
          <Button
            variant={stats?.viewerFollows ? 'secondary' : 'primary'}
            size="sm"
            loading={follow.isPending || statsQ.isPending}
            onClick={() => follow.mutate(!stats?.viewerFollows)}
          >
            {stats?.viewerFollows ? 'Following ✓' : 'Follow'}
          </Button>
        ) : (
          <Link to="/signin">
            <Button variant="secondary" size="sm">
              Sign in to follow
            </Button>
          </Link>
        )}
      </header>

      {battalion?.battalion && (
        <Link
          to="/battalions"
          className="flex items-center justify-between gap-3 rounded-xl border border-app bg-raised px-4 py-3 hover:bg-sunken"
        >
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {(() => {
                const level = battalion.battalion.echelon;
                const t = roleTitle(level, battalion.role);
                const unit = echelonCopy(level).name;
                return t
                  ? `${t.title} (${t.realRank}) of the ${unit}`
                  : `Serves with the ${unit}`;
              })()}
            </p>
            <p className="truncate font-display font-bold text-app">
              ⚔️ {battalion.battalion.name}
            </p>
            {battalion.battalion.motto && (
              <p className="truncate text-xs text-muted italic">
                “{battalion.battalion.motto}”
              </p>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted">Standings →</span>
        </Link>
      )}

      <ServiceRecord profileId={profile.id} />

      <section aria-label="Reviews" className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold text-app">
          Campaign history
        </h2>
        {reviewsQ.isPending && (
          <div className="h-32 animate-pulse rounded-xl border border-app bg-raised" />
        )}
        {reviewsQ.data && reviewsQ.data.length === 0 && (
          <p className="rounded-xl border border-app bg-raised p-6 text-center text-sm text-muted">
            No campaigns on record yet.
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {reviewsQ.data?.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-1.5 rounded-xl border border-app bg-raised p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  to={`/bathrooms/${r.bathroom_id}`}
                  className="font-medium text-app hover:underline"
                >
                  {r.bathroom?.name ?? 'A bathroom'}
                </Link>
                <span className="flex items-center gap-2">
                  <Stars value={r.rating} size={13} />
                  <time dateTime={r.created_at} className="text-xs text-muted">
                    {new Date(r.created_at).toLocaleDateString()}
                  </time>
                </span>
              </div>
              {r.body && (
                <p className="line-clamp-4 whitespace-pre-line text-sm text-muted">
                  {r.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
