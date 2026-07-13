import { Link, Outlet } from 'react-router-dom';
import { Header } from '@/components/layout/Header';

export function Layout() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-app">
      <Header />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="flex flex-col items-center gap-2 border-t border-app px-4 py-6 text-center text-xs text-muted">
        <nav className="flex items-center gap-4" aria-label="Footer">
          <Link to="/explore" className="hover:text-app">
            Explore
          </Link>
          <Link to="/business" className="hover:text-app">
            For business
          </Link>
          <Link to="/privacy" className="hover:text-app">
            Privacy
          </Link>
          <Link to="/terms" className="hover:text-app">
            Terms
          </Link>
        </nav>
        <p>Watrloo · community-sourced restroom reviews. Go with confidence.</p>
      </footer>
    </div>
  );
}
