import { createBrowserRouter, Link, Navigate } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/auth/RequireAuth';
import { RequireRole } from '@/auth/RequireRole';
import { Landing } from '@/pages/Landing';
import { Home } from '@/pages/Home';
import { MapPage } from '@/pages/MapPage';
import { NewBathroomPage } from '@/pages/NewBathroom';
import { BathroomDetail } from '@/pages/BathroomDetail';
import { SignIn } from '@/pages/SignIn';
import { SignUp } from '@/pages/SignUp';
import { ProfilePage } from '@/pages/Profile';
import { Privacy } from '@/pages/Privacy';
import { AdminLayout } from '@/pages/admin/AdminLayout';
import { AdminReports } from '@/pages/admin/AdminReports';
import { AdminReviews } from '@/pages/admin/AdminReviews';
import { AdminBathrooms } from '@/pages/admin/AdminBathrooms';
import { AdminRoles } from '@/pages/admin/AdminRoles';
import { AdminAccessRequests } from '@/pages/admin/AdminAccessRequests';
import { AdminClaims } from '@/pages/admin/AdminClaims';
import { ForBusiness } from '@/pages/ForBusiness';
import { RequestAccess } from '@/pages/RequestAccess';
import { BusinessDashboard } from '@/pages/business/BusinessDashboard';
import { ListingManage } from '@/pages/business/ListingManage';
import { CsvImport } from '@/pages/business/CsvImport';
import { BusinessMembers } from '@/pages/business/BusinessMembers';
import { BusinessAnalytics } from '@/pages/business/BusinessAnalytics';
import { BusinessSettings } from '@/pages/business/BusinessSettings';

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
      { path: '/', element: <Landing /> },
      { path: '/browse', element: <Home /> },
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
      { path: '/privacy', element: <Privacy /> },
      {
        path: '/profile',
        element: (
          <RequireAuth>
            <ProfilePage />
          </RequireAuth>
        ),
      },

      // --- Business (paid tier) ---------------------------------------------
      { path: '/business', element: <ForBusiness /> },
      {
        path: '/business/request',
        element: (
          <RequireAuth>
            <RequestAccess />
          </RequireAuth>
        ),
      },
      {
        path: '/business/dashboard',
        element: (
          <RequireAuth>
            <BusinessDashboard />
          </RequireAuth>
        ),
      },
      {
        path: '/business/import',
        element: (
          <RequireAuth>
            <CsvImport />
          </RequireAuth>
        ),
      },
      {
        path: '/business/listings/:bathroomId',
        element: (
          <RequireAuth>
            <ListingManage />
          </RequireAuth>
        ),
      },
      {
        path: '/business/:businessId/members',
        element: (
          <RequireAuth>
            <BusinessMembers />
          </RequireAuth>
        ),
      },
      {
        path: '/business/:businessId/analytics',
        element: (
          <RequireAuth>
            <BusinessAnalytics />
          </RequireAuth>
        ),
      },
      {
        path: '/business/:businessId/settings',
        element: (
          <RequireAuth>
            <BusinessSettings />
          </RequireAuth>
        ),
      },
      {
        path: '/admin',
        element: (
          <RequireRole>
            <AdminLayout />
          </RequireRole>
        ),
        children: [
          { index: true, element: <Navigate to="reports" replace /> },
          { path: 'reports', element: <AdminReports /> },
          { path: 'reviews', element: <AdminReviews /> },
          { path: 'bathrooms', element: <AdminBathrooms /> },
          {
            path: 'requests',
            element: (
              <RequireRole role="admin">
                <AdminAccessRequests />
              </RequireRole>
            ),
          },
          {
            path: 'claims',
            element: (
              <RequireRole role="admin">
                <AdminClaims />
              </RequireRole>
            ),
          },
          {
            path: 'roles',
            element: (
              <RequireRole role="admin">
                <AdminRoles />
              </RequireRole>
            ),
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
], {
  // Vite's `base` (e.g. '/watrloo/' on GitHub Pages) must be stripped from the
  // path before routes match, or every URL falls through to NotFound. Trailing
  // slash removed because React Router wants '/watrloo', not '/watrloo/'.
  // '/' stays '' — the root case, which basename treats as no prefix.
  basename: import.meta.env.BASE_URL.replace(/\/$/, ''),
});
