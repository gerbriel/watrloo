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

export function AdminLayout() {
  const { isAdmin, profile } = useAuth();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-app">Admin</h1>
        <p className="text-sm text-muted">
          Signed in as @{profile?.username ?? '…'}. Every removal, restore, and
          role change here is written to the audit log.
        </p>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-app" aria-label="Admin sections">
        <Tab to="/admin/reports" label="Reports" />
        <Tab to="/admin/reviews" label="Reviews" />
        <Tab to="/admin/bathrooms" label="Bathrooms" />
        {isAdmin && <Tab to="/admin/campaigns" label="Campaigns" />}
        {isAdmin && <Tab to="/admin/requests" label="Business requests" />}
        {isAdmin && <Tab to="/admin/claims" label="Claims" />}
        {isAdmin && <Tab to="/admin/roles" label="Roles" />}
      </nav>

      <Outlet />
    </div>
  );
}
