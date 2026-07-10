import { createBrowserRouter, Link } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/auth/RequireAuth';
import { Home } from '@/pages/Home';
import { MapPage } from '@/pages/MapPage';
import { NewBathroomPage } from '@/pages/NewBathroom';
import { BathroomDetail } from '@/pages/BathroomDetail';
import { SignIn } from '@/pages/SignIn';
import { SignUp } from '@/pages/SignUp';
import { ProfilePage } from '@/pages/Profile';

function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="text-5xl font-bold text-flush-500">404</p>
      <h1 className="mt-4 text-xl font-semibold text-app">This stall's empty</h1>
      <p className="mt-2 text-sm text-muted">
        We couldn't find that page — it may have been flushed.
      </p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm font-medium text-flush-500 hover:underline"
      >
        Back to Watrloo
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/map', element: <MapPage /> },
      {
        path: '/bathrooms/new',
        element: (
          <RequireAuth>
            <NewBathroomPage />
          </RequireAuth>
        ),
      },
      { path: '/bathrooms/:id', element: <BathroomDetail /> },
      { path: '/signin', element: <SignIn /> },
      { path: '/signup', element: <SignUp /> },
      {
        path: '/profile',
        element: (
          <RequireAuth>
            <ProfilePage />
          </RequireAuth>
        ),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
