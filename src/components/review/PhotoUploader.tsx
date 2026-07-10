import { useEffect, useRef, useState } from 'react';
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES, compressImage } from '@/lib/image';

const ACCEPTED: readonly string[] = ACCEPTED_TYPES;
const MAX_PHOTOS = 6;

/**
 * Format is checked before compression; size is checked *after*. A 9MB phone
 * photo is fine — it gets downscaled under the bucket limit. Rejecting it up
 * front would turn the most common case into an error.
 */
function unsupportedFormat(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) {
    return `${file.name}: unsupported format (use JPEG, PNG, WebP, or AVIF).`;
  }
  return null;
}

/**
 * Controlled picker for pending photos. The parent owns the File[] so it can
 * upload them after the review row exists. Object-URL previews are created for
 * the current selection and revoked on change/unmount to avoid leaking memory.
 */
export function PhotoUploader({
  value,
  onChange,
  disabled = false,
}: {
  value: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<{ file: File; url: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    const next = value.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setPreviews(next);
    return () => {
      next.forEach((p) => URL.revokeObjectURL(p.url));
    };
  }, [value]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    if (inputRef.current) inputRef.current.value = '';

    const room = MAX_PHOTOS - value.length;
    const errors: string[] = [];
    const accepted: File[] = [];

    setProcessing(true);
    try {
      for (const file of incoming) {
        if (accepted.length >= room) break;

        const problem = unsupportedFormat(file);
        if (problem) {
          errors.push(problem);
          continue;
        }

        // Downscale and re-encode. This also strips EXIF, including the GPS
        // coordinates phones embed — a bathroom photo should not carry the
        // uploader's exact location.
        let processed: File;
        try {
          processed = await compressImage(file);
        } catch {
          errors.push(`${file.name}: could not be processed.`);
          continue;
        }

        if (processed.size > MAX_UPLOAD_BYTES) {
          errors.push(`${file.name}: still too large after compression (max 5MB).`);
          continue;
        }
        accepted.push(processed);
      }
    } finally {
      setProcessing(false);
    }

    if (incoming.length > room) {
      errors.push(`You can attach up to ${MAX_PHOTOS} photos.`);
    }
    setError(errors.length > 0 ? errors.join(' ') : null);
    if (accepted.length > 0) onChange([...value, ...accepted]);
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-app">Photos (optional)</span>

      <div className="flex flex-wrap gap-2">
        {previews.map((p, i) => (
          <div
            key={p.url}
            className="relative size-20 overflow-hidden rounded-lg border border-app"
          >
            <img
              src={p.url}
              alt={`Selected photo ${i + 1}: ${p.file.name}`}
              className="size-full object-cover"
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              disabled={disabled}
              aria-label={`Remove photo ${i + 1}`}
              className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                aria-hidden="true"
                className="size-3"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        ))}

        {value.length < MAX_PHOTOS && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || processing}
            className="grid size-20 place-items-center rounded-lg border border-dashed border-app bg-surface text-muted hover:border-flush-500 hover:text-flush-600 disabled:opacity-60"
            aria-label={processing ? 'Processing photos' : 'Add photos'}
            aria-busy={processing || undefined}
          >
            {processing ? (
              <span
                aria-hidden="true"
                className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent"
              />
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="size-6"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            )}
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        multiple
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
        className="sr-only"
      />

      {error ? (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted" aria-live="polite">
          {processing
            ? 'Processing photos…'
            : 'JPEG, PNG, WebP, or AVIF. Large photos are resized automatically, and location data is stripped.'}
        </p>
      )}
    </div>
  );
}
