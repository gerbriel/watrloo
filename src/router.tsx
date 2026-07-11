import { createBrowserRouter, Link, Navigate } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/auth/RequireAuth';
import { RequireRole } from '@/auth/RequireRole';
import { useAuth } from '@/auth/AuthProvider';
import { Landing } from '@/pages/Landing';
import { Explore } from '@/pages/Explore';
import { Terms } from '@/pages/Terms';
import { Campaigns } from '@/pages/business/Campaigns';
import { AdminCampaigns } from '@/pages/admin/AdminCampaigns';
import { NewBathroomPage } from '@/pages/NewBathroom';
import { BathroomDetail } from '@/pages/BathroomDetail';
import { SignIn } from '@/pages/SignIn';
import { SignUp } from '@/pages/SignUp';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';
import { ProfilePage } from '@/pages/Profile';
import { Privacy } from '@/pages/Privacy';
import { AdminLayout } from '@/pages/admin/AdminLayout';
import { AdminReports } from '@/pages/admin/AdminReports';
import { AdminReviews } from '@/pages/admin/AdminReviews';
import { AdminBathrooms } from '@/pages/admin/AdminBathrooms';
import { AdminRoles } from '@/pages/admin/AdminRoles';
import { AdminAccessRequests } from '@/pages/admin/AdminAccessRequests';
import { AdminClaims } from '@/pages/admin/AdminClaims';
import { AdminAdsOverview } from '@/pages/admin/AdminAdsOverview';
import { AdminDelivery } from '@/pages/admin/AdminDelivery';
import { AdminTrust } from '@/pages/admin/AdminTrust';
import { AdminAudit } from '@/pages/admin/AdminAudit';
import { AdminOps } from '@/pages/admin/AdminOps';
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

/**
 * The root: logged-in visitors skip the marketing landing and go straight to
 * the app (owner decision). We hold on the very first session check so a
 * logged-in user never flashes the landing before the redirect.
 */
function RootRoute() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center" role="status" aria-live="polite">
        <span
          className="size-8 animate-spin rounded-full border-2 border-flush-500 border-t-transparent"
          aria-hidden="true"
        />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  return session ? <Navigate to="/explore" replace /> : <Landing />;
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <RootRoute /> },
      // Browse + Map are now one Explore view; old paths redirect (the signup
      // confirmation link and landing CTAs point at /browse).
      { path: '/explore', element: <Explore /> },
      { path: '/browse', element: <Navigate to="/explore" replace /> },
      { path: '/map', element: <Navigate to="/explore" replace /> },
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
      { path: '/forgot-password', element: <ForgotPassword /> },
      // Public: the recovery token in the URL is what authorizes this page,
      // not a normal login — RequireAuth would bounce it before it resolves.
      { path: '/reset-password', element: <ResetPassword /> },
      { path: '/privacy', element: <Privacy /> },
      { path: '/terms', element: <Terms /> },
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
      // Public on purpose: a company can request access without a Watrloo account.
      { path: '/business/request', element: <RequestAccess /> },
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
        path: '/business/:businessId/campaigns',
        element: (
          <RequireAuth>
            <Campaigns />
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
          { path: 'campaigns', element: <AdminCampaigns /> },
          {
            path: 'ads',
            element: (
              <RequireRole role="admin">
                <AdminAdsOverview />
              </RequireRole>
            ),
          },
          {
            path: 'delivery',
            element: (
              <RequireRole role="admin">
                <AdminDelivery />
              </RequireRole>
            ),
          },
          {
            path: 'trust',
            element: (
              <RequireRole role="admin">
                <AdminTrust />
              </RequireRole>
            ),
          },
          {
            path: 'audit',
            element: (
              <RequireRole role="admin">
                <AdminAudit />
              </RequireRole>
            ),
          },
          {
            path: 'ops',
            element: (
              <RequireRole role="admin">
                <AdminOps />
              </RequireRole>
            ),
          },
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
