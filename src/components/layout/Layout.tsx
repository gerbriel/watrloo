import { Outlet } from 'react-router-dom';
import { Header } from '@/components/layout/Header';

export function Layout() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-app">
      <Header />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-app px-4 py-6 text-center text-xs text-muted">
        Watrloo · community-sourced restroom reviews. Go with confidence.
      </footer>
    </div>
  );
}
