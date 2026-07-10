/**
 * Client-side image downscaling, hand-rolled on canvas.
 *
 * Two reasons this isn't a library call: the popular package hasn't shipped
 * since 2023, and Supabase's server-side image transformation is a paid
 * feature. Phone photos are routinely 4-12MB, and the storage bucket rejects
 * anything over 5MB, so without this the users most likely to add a photo are
 * exactly the ones whose upload fails.
 */

const MAX_EDGE = 1600;
const TARGET_TYPE = 'image/webp';
const QUALITY = 0.82;

/** Bucket limit. Mirrored from the `review-photos` bucket's file_size_limit. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  );
}

/**
 * Decode without inflating memory on huge images. `createImageBitmap` is the
 * fast path; Safari < 17 needs the <img> fallback.
 */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through — some AVIF/HEIC variants fail here but decode via <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dimensions(source: ImageBitmap | HTMLImageElement) {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

/**
 * Downscale to fit MAX_EDGE and re-encode as WebP.
 *
 * Re-encoding through a canvas strips EXIF — including the GPS coordinates
 * phones embed by default. A bathroom photo carrying the uploader's exact home
 * or workplace location is a real privacy leak, so the re-encode is
 * load-bearing rather than incidental. (Orientation is applied during decode,
 * so the visible rotation survives even though the EXIF tag does not.)
 *
 * Consequently there is NO "it's already small enough, pass it through"
 * shortcut: a 400KB JPEG straight off a phone is small *and* full of GPS. Every
 * file is re-encoded, and we never fall back to returning the caller's original
 * File object.
 */
export async function compressImage(file: File): Promise<File> {
  const source = await decode(file);
  const { width, height } = dimensions(source);
  if (!width || !height) throw new Error('Could not read that image.');

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image.');
  ctx.drawImage(source, 0, 0, w, h);
  if ('close' in source) source.close();

  let blob = await canvasToBlob(canvas, TARGET_TYPE, QUALITY);
  // Very old Safari has no WebP encoder and silently hands back a PNG, which
  // can be larger than the JPEG we started with. Fall back to JPEG.
  if (!blob || blob.size > file.size) {
    blob = await canvasToBlob(canvas, 'image/jpeg', QUALITY);
  }
  // Failing closed matters here: returning `file` on error would upload the
  // untouched original, EXIF and all. The caller surfaces this as a per-file
  // message and drops the photo.
  if (!blob) throw new Error('Could not process that image.');

  const ext = blob.type === TARGET_TYPE ? 'webp' : 'jpg';
  const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${base}.${ext}`, {
    type: blob.type,
    lastModified: Date.now(),
  });
}
