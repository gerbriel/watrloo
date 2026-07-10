import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Gates a route behind authentication. While the initial session check is in
 * flight we render a spinner rather than redirecting — redirecting here would
 * bounce a signed-in user off a deep link every time they refresh.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
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
        <span className="sr-only">Checking your session…</span>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/signin" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
