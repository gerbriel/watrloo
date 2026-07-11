import type {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from 'react';
import { useId, useState } from 'react';
import { cn } from '@/lib/cn';

const CONTROL = cn(
  'w-full rounded-lg border border-app bg-surface px-3 py-2 text-app',
  'placeholder:text-muted disabled:opacity-60',
);

function Wrapper({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-app">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  error?: string;
  hint?: string;
}

/** Eye / eye-off, inline so there's no icon dependency. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4.5"
    >
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function Input({ label, error, hint, className, type, ...rest }: InputProps) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  return (
    <Wrapper id={id} label={label} error={error} hint={hint}>
      <div className="relative">
        <input
          {...rest}
          type={isPassword && revealed ? 'text' : type}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? `${id}-error` : hint ? `${id}-hint` : undefined
          }
          className={cn(
            CONTROL,
            isPassword && 'pr-10',
            error && 'border-red-500',
            className,
          )}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-app"
          >
            <EyeIcon off={revealed} />
          </button>
        )}
      </div>
    </Wrapper>
  );
}

interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  error?: string;
  hint?: string;
}

export function Textarea({
  label,
  error,
  hint,
  className,
  ...rest
}: TextareaProps) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} error={error} hint={hint}>
      <textarea
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          error ? `${id}-error` : hint ? `${id}-hint` : undefined
        }
        className={cn(CONTROL, 'min-h-24 resize-y', error && 'border-red-500', className)}
      />
    </Wrapper>
  );
}

interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: string;
}

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <input
        {...rest}
        id={id}
        type="checkbox"
        className={cn(
          'size-4 rounded border-app text-flush-600 accent-flush-600',
          className,
        )}
      />
      <label htmlFor={id} className="text-sm text-app select-none">
        {label}
      </label>
    </div>
  );
}
