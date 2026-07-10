import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { fileReport } from '@/lib/api/reports';
import type { NewReport } from '@/types/db';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

type Target = { review_id: string } | { bathroom_id: string };

/**
 * A quiet "Report" affordance that expands into a reason box. Anyone can post
 * without review; this is the counterweight — it routes content to the
 * moderator queue rather than removing anything itself.
 */
export function ReportButton({ target, className }: { target: Target; className?: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className={cn('text-xs text-muted', className)}>
        Reported — a moderator will take a look. Thanks.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => (user ? setOpen(true) : navigate('/signin'))}
        className={cn(
          'w-fit self-start text-xs text-muted underline-offset-2 hover:text-app hover:underline',
          className,
        )}
      >
        Report
      </button>
    );
  }

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('Add a short reason so a moderator knows what to look at.');
      return;
    }
    if (!user) {
      navigate('/signin');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await fileReport({ ...target, reason: trimmed } as NewReport, user.id);
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not file the report.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-app bg-surface p-3',
        className,
      )}
    >
      <Textarea
        label="Report this"
        hint="What's wrong — spam, abuse, wrong info? A moderator will review it."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        rows={3}
        error={error ?? undefined}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
        <Button variant="danger" size="sm" loading={submitting} onClick={() => void submit()}>
          Submit report
        </Button>
      </div>
    </div>
  );
}
