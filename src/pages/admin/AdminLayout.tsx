import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { cn } from '@/lib/cn';

function Tab({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'border-flush-500 text-app'
            : 'border-transparent text-muted hover:text-app',
        )
      }
    >
      {label}
    </NavLink>
  );
}

function TabGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <span className="mr-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted/70">
        {label}
      </span>
      {children}
    </div>
  );
}

export function AdminLayout() {
  const { isAdmin, profile } = useAuth();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-app">Control room</h1>
        <p className="text-sm text-muted">
          Signed in as @{profile?.username ?? '…'}. Every removal, restore,
          setting change, and role change here is written to the audit log.
        </p>
      </header>

      <nav
        className="flex gap-5 overflow-x-auto border-b border-app pb-px"
        aria-label="Admin sections"
      >
        <TabGroup label="Moderation">
          <Tab to="/admin/reports" label="Reports" />
          <Tab to="/admin/reviews" label="Reviews" />
          <Tab to="/admin/bathrooms" label="Bathrooms" />
          {isAdmin && <Tab to="/admin/appeals" label="Appeals" />}
          {isAdmin && <Tab to="/admin/attributes" label="Attributes" />}
        </TabGroup>
        {isAdmin && (
          <TabGroup label="Business">
            <Tab to="/admin/requests" label="Requests" />
            <Tab to="/admin/claims" label="Claims" />
            <Tab to="/admin/campaigns" label="Campaigns" />
          </TabGroup>
        )}
        {isAdmin && (
          <TabGroup label="Ads">
            <Tab to="/admin/ads" label="Overview" />
            <Tab to="/admin/delivery" label="Delivery" />
            <Tab to="/admin/trust" label="Trust" />
          </TabGroup>
        )}
        {isAdmin && (
          <TabGroup label="System">
            <Tab to="/admin/audit" label="Audit" />
            <Tab to="/admin/ops" label="Ops" />
            <Tab to="/admin/roles" label="Roles" />
          </TabGroup>
        )}
      </nav>

      <Outlet />
    </div>
  );
}
