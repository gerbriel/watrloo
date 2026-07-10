import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Gates a route behind a role. This only decides what the *router* renders —
 * every privileged action is independently re-checked by RLS / the RPCs in the
 * database, so bypassing this guard buys an attacker a blank admin shell and
 * nothing more.
 *
 * We wait on both the session check and the roles fetch before deciding;
 * redirecting during either would bounce a moderator off their own deep link.
 */
export function RequireRole({
  role = 'moderator',
  children,
}: {
  role?: 'moderator' | 'admin';
  children: ReactNode;
}) {
  const { session, loading, rolesLoading, isModerator, isAdmin } = useAuth();
  const location = useLocation();

  if (loading || (session && rolesLoading)) {
    return (
      <div
        className="flex min-h-[50vh] items-center justify-center"
        role="status"
        aria-live="polite"
      >
        <span
          className="size-8 animate-spin rounded-full border-2 border-current border-t-transparent text-flush-500"
          aria-hidden="true"
        />
        <span className="sr-only">Checking your access…</span>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/signin" replace state={{ from: location }} />;
  }

  const allowed = role === 'admin' ? isAdmin : isModerator;
  if (!allowed) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
