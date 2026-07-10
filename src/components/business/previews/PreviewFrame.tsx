// AGENT UNIT — implement per instructions. Preserve the export name + props.
// A reusable static "app window" chrome (title bar + body) that hard-coded
// business-moderator previews sit inside on the public marketing page.
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function PreviewFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-app bg-surface shadow-sm',
      )}
    >
      {/* Faux title bar */}
      <div className="relative flex items-center gap-2 border-b border-app bg-raised px-4 py-2.5">
        {/* Traffic-light dots */}
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-muted/40" />
          <span className="size-2.5 rounded-full bg-muted/40" />
          <span className="size-2.5 rounded-full bg-muted/40" />
        </div>

        {/* Centered URL pill */}
        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full border border-app bg-sunken px-2.5 py-0.5 text-[0.7rem] font-medium text-muted">
          watrloo.app
        </span>

        {/* Left-aligned title (kept clear of the centered pill) */}
        <span className="ml-1 truncate text-xs font-medium text-muted">
          {title}
        </span>
      </div>

      {/* Body */}
      <div className="p-5">{children}</div>
    </div>
  );
}
