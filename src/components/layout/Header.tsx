import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { useAuth } from '@/auth/AuthProvider';
import { cn } from '@/lib/cn';

/** A tidy water droplet — a toilet-adjacent wink without the toilet-humour. */
function DropletMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-6 shrink-0 text-flush-500"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2.5s6.5 7 6.5 11.4a6.5 6.5 0 1 1-13 0C5.5 9.5 12 2.5 12 2.5z" />
    </svg>
  );
}

function NavItem({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'rounded-md px-2.5 py-1.5 transition-colors',
          isActive
            ? 'bg-raised font-medium text-app'
            : 'text-muted hover:bg-raised hover:text-app',
        )
      }
    >
      {label}
    </NavLink>
  );
}

export function Header() {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-20 border-b border-app bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link
          to="/"
          className="flex items-center gap-2 font-semibold text-app"
          aria-label="Watrloo home"
        >
          <DropletMark />
          <span className="text-lg tracking-tight">Watrloo</span>
          <span className="hidden text-xs font-normal text-muted sm:inline">
            · find a good throne
          </span>
        </Link>

        <nav className="flex items-center gap-1 text-sm" aria-label="Primary">
          <NavItem to="/" label="Home" end />
          <NavItem to="/map" label="Map" />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigate('/bathrooms/new')}
          >
            Add a bathroom
          </Button>

          <ThemeToggle />

          {user ? (
            <div className="flex items-center gap-2">
              <Link
                to="/profile"
                className="max-w-[10rem] truncate text-sm font-medium text-app hover:underline"
              >
                {profile?.username ?? 'Profile'}
              </Link>
              <Button size="sm" variant="ghost" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => navigate('/signin')}>
                Sign in
              </Button>
              <Button size="sm" variant="primary" onClick={() => navigate('/signup')}>
                Sign up
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
