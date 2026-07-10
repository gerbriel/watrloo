import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { queryClient } from '@/lib/queryClient';
import { router } from '@/router';

/**
 * Composition root. QueryClientProvider is outermost so AuthProvider could read
 * the cache if it ever needs to; AuthProvider wraps RouterProvider so every
 * route can read auth state. Neither needs router context, so both sit outside
 * the router tree.
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
