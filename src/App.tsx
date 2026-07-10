import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { router } from '@/router';

/**
 * Composition root: AuthProvider wraps RouterProvider so every route (and its
 * loaders/components) can read auth state. AuthProvider needs no router context
 * itself, so it sits outside the router tree.
 */
export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
