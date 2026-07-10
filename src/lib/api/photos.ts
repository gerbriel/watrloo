import { supabase } from '@/lib/supabase';
import { STORAGE_BUCKET } from '@/types/db';
import type { ReviewPhoto } from '@/types/db';

/** Derive a clean file extension from the file name, falling back to its MIME type. */
function extensionFor(file: File): string {
  const dot = file.name.lastIndexOf('.');
  const fromName =
    dot >= 0 ? file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;

  const fromType = (file.type.split('/')[1] ?? '').toLowerCase();
  if (fromType) return fromType === 'jpeg' ? 'jpg' : fromType;
  return 'jpg';
}

export async function uploadReviewPhoto(
  file: File,
  userId: string,
  reviewId: string,
): Promise<ReviewPhoto> {
  // Storage RLS requires the first path segment to equal the caller's uid.
  const path = `${userId}/${crypto.randomUUID()}.${extensionFor(file)}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file, {
      contentType: file.type || undefined,
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('review_photos')
    .insert({ review_id: reviewId, storage_path: path })
    .select('*')
    .single();

  if (error) {
    // Don't orphan the uploaded object if the row insert fails.
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    throw error;
  }
  return data as ReviewPhoto;
}

export function publicPhotoUrl(storagePath: string): string {
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

export async function deleteReviewPhoto(photo: ReviewPhoto): Promise<void> {
  // Remove the DB row first (RLS-guarded via the parent review), then the object.
  const { error } = await supabase
    .from('review_photos')
    .delete()
    .eq('id', photo.id);
  if (error) throw error;

  const { error: storageError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .remove([photo.storage_path]);
  if (storageError) throw storageError;
}
