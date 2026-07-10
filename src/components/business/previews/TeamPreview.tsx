// AGENT UNIT — implemented per instructions. Preserve the export name.
// A STATIC, hard-coded marketing mockup of team management. No data fetching,
// no props, no form state — pure presentational JSX with fake data that
// mirrors the real page at src/pages/business/BusinessMembers.tsx.
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';
import { cn } from '@/lib/cn';

const ROLE_CHIP =
  'rounded-full border border-app bg-sunken px-2 py-0.5 text-xs font-medium capitalize text-muted';

type Member = {
  username: string;
  role: 'owner' | 'manager' | 'staff';
};

const MEMBERS: Member[] = [
  { username: 'dana_owner', role: 'owner' },
  { username: 'marco_m', role: 'manager' },
  { username: 'sam_barista', role: 'staff' },
];

export function TeamPreview() {
  return (
    <PreviewFrame title="Your team">
      <section className="flex flex-col gap-4 rounded-xl border border-app bg-raised p-5">
        {/* Roster of current teammates */}
        <ul className="flex flex-col gap-2">
          {MEMBERS.map((member) => (
            <li
              key={member.username}
              className="flex items-center justify-between gap-3 rounded-lg border border-app bg-surface px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-app">
                  @{member.username}
                </span>
                <span className={ROLE_CHIP}>{member.role}</span>
              </div>
              {member.role !== 'owner' && (
                <span className="shrink-0 text-sm font-medium text-muted">
                  Remove
                </span>
              )}
            </li>
          ))}
        </ul>

        {/* Add-teammate row — styled to read as a form, but non-interactive */}
        <div className="flex items-end gap-2 border-t border-app pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-app">Username</span>
            <input
              type="text"
              readOnly
              placeholder="username"
              aria-label="Username"
              tabIndex={-1}
              className="w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app placeholder:text-muted"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-app">Role</span>
            {/* Faux select — a real <select> would be interactive */}
            <div
              className="flex items-center gap-2 rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
              aria-hidden="true"
            >
              <span>Manager</span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4 text-muted"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>

          {/* Faux button — kept as a <span> so the mockup stays inert */}
          <span
            className={cn(
              'shrink-0 rounded-lg px-4 py-2 text-sm font-medium text-white',
              'bg-gradient-to-b from-flush-500 to-flush-600 shadow-lg shadow-flush-600/25',
            )}
            aria-hidden="true"
          >
            Add
          </span>
        </div>

        <p className="text-xs text-muted">
          Invite managers to edit listings and reply to reviews; staff get read
          access.
        </p>
      </section>
    </PreviewFrame>
  );
}
