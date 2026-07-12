import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { cn } from '@/lib/cn';

export type PanelView = 'admin' | 'moderator' | 'user';

/** Child pages read the effective view (an admin can work in any view). */
export interface AdminViewContext {
  view: PanelView;
  viewAsAdmin: boolean;
}

export function useAdminView(): AdminViewContext {
  return useOutletContext<AdminViewContext>();
}

const VIEW_KEY = 'wl_admin_view';

/**
 * The control room shell. Desktop: a fixed left sidebar with grouped links
 * stacked vertically — the nav never scrolls sideways no matter how many
 * consoles exist. Small screens: a native select switcher (one tap, screen-
 * reader friendly, no overflow).
 *
 * Role-aware: admins get every group; moderators get a focused "Moderator
 * panel" with just their tools. The database re-checks every action either
 * way — this shell only decides what to show.
 */

interface NavItem {
  to: string;
  label: string;
  adminOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Moderation',
    items: [
      { to: '/admin', label: 'Home' },
      { to: '/admin/assignments', label: 'My bathrooms' },
      { to: '/admin/reports', label: 'Reports' },
      { to: '/admin/reviews', label: 'Reviews' },
      { to: '/admin/bathrooms', label: 'Bathrooms' },
      { to: '/admin/appeals', label: 'Appeals', adminOnly: true },
      { to: '/admin/attributes', label: 'Attributes', adminOnly: true },
    ],
  },
  {
    label: 'Business',
    items: [
      { to: '/admin/requests', label: 'Requests', adminOnly: true },
      { to: '/admin/claims', label: 'Claims', adminOnly: true },
      { to: '/admin/campaigns', label: 'Campaigns', adminOnly: true },
    ],
  },
  {
    label: 'Ads',
    items: [
      { to: '/admin/ads', label: 'Overview', adminOnly: true },
      { to: '/admin/delivery', label: 'Delivery', adminOnly: true },
      { to: '/admin/trust', label: 'Trust & safety', adminOnly: true },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/users', label: 'Users', adminOnly: true },
      { to: '/admin/orgs', label: 'Orgs', adminOnly: true },
      { to: '/admin/audit', label: 'Audit log', adminOnly: true },
      { to: '/admin/ops', label: 'Ops health', adminOnly: true },
      { to: '/admin/roles', label: 'Roles', adminOnly: true },
    ],
  },
];

const USER_GROUPS: NavGroup[] = [
  { label: 'Your account', items: [{ to: '/admin', label: 'Home' }] },
];

function visibleGroups(view: PanelView): NavGroup[] {
  if (view === 'user') return USER_GROUPS;
  const isAdmin = view === 'admin';
  return GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => isAdmin || !i.adminOnly),
  })).filter((g) => g.items.length > 0);
}

export function AdminLayout() {
  const { isAdmin, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // An admin who also moderates can flip into the focused moderator view; the
  // choice sticks for the tab session. Pure presentation — the server gates
  // every action by real role either way.
  const [view, setView] = useState<PanelView>(() => {
    try {
      const saved = sessionStorage.getItem(VIEW_KEY);
      return saved === 'moderator' || saved === 'user' ? saved : 'admin';
    } catch {
      return 'admin';
    }
  });
  const effectiveView: PanelView = isAdmin ? view : view === 'user' ? 'user' : 'moderator';
  const viewAsAdmin = effectiveView === 'admin';
  const groups = visibleGroups(effectiveView);

  function switchView(next: PanelView) {
    setView(next);
    try {
      sessionStorage.setItem(VIEW_KEY, next);
    } catch {
      /* best effort */
    }
    // Leaving admin view while on an admin-only console would 404-ish; go home.
    navigate('/admin');
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-app">
            {effectiveView === 'admin'
              ? 'Control room'
              : effectiveView === 'moderator'
                ? 'Moderator panel'
                : 'Your account'}
          </h1>
          <p className="text-sm text-muted">
            Signed in as @{profile?.username ?? '…'}. Every removal, restore,
            setting change, and role change here is written to the audit log.
          </p>
        </div>
        <div
          role="group"
          aria-label="Switch view"
          className="flex overflow-hidden rounded-lg border border-app text-xs font-medium"
        >
          {([
            ...(isAdmin ? (['admin'] as PanelView[]) : []),
            'moderator',
            'user',
          ] as PanelView[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={effectiveView === v}
              onClick={() => switchView(v)}
              className={cn(
                'px-3 py-1.5 capitalize transition-colors',
                effectiveView === v
                  ? 'bg-flush-600 text-white'
                  : 'bg-surface text-muted hover:text-app',
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </header>

      {/* Small screens: one native switcher, zero overflow. */}
      <div className="lg:hidden">
        <label htmlFor="admin-section" className="sr-only">
          Admin section
        </label>
        <select
          id="admin-section"
          value={location.pathname}
          onChange={(e) => navigate(e.target.value)}
          className="w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
        >
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((i) => (
                <option key={i.to} value={i.to}>
                  {i.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Desktop: vertical sidebar — grows down, never sideways. */}
        <nav
          aria-label="Admin sections"
          className="hidden w-44 shrink-0 flex-col gap-5 lg:flex"
        >
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-1">
              <p className="px-2 text-[0.65rem] font-semibold uppercase tracking-wide text-muted/70">
                {g.label}
              </p>
              {g.items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.to === '/admin'}
                  className={({ isActive }) =>
                    cn(
                      'rounded-lg px-2 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-flush-600/10 font-medium text-flush-600'
                        : 'text-muted hover:bg-raised hover:text-app',
                    )
                  }
                >
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <Outlet context={{ view: effectiveView, viewAsAdmin } satisfies AdminViewContext} />
        </div>
      </div>
    </div>
  );
}
