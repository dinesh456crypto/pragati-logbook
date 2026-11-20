// Ink formula sample photos, kept in the private Storage bucket "ink-photos" as
// <formula record id>/<photo id>.jpg. Photos are made smaller on the phone before
// uploading (longest side 1600 px, JPEG), so each is usually 150–400 KB.
import { supabase } from './supabase'

export const PHOTO_BUCKET = 'ink-photos'
export const MAX_NEW_PHOTOS = 10
const MAX_SIDE = 1600

export interface InkPhoto {
  id: string
  revision: number
  path: string
  uploaded_by_name: string | null
  uploaded_at: string
  url: string | null // signed link, valid for an hour
}

// Shrinks a camera photo to a JPEG. Falls back to the original file when the browser
// cannot read it (it is then uploaded as is, if small enough).
export async function preparePhoto(file: File): Promise<{ blob: Blob; ext: 'jpg' | 'png' | 'webp'; type: string }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
    if (!blob) throw new Error('no blob')
    return { blob, ext: 'jpg', type: 'image/jpeg' }
  } catch {
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : file.type === 'image/jpeg' ? 'jpg' : null
    if (!ext) throw new Error(`${file.name}: this file is not a photo the app can read. Use a JPG or PNG photo.`)
    if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} is larger than 5 MB.`)
    return { blob: file, ext, type: file.type }
  }
}

// Uploads one photo and adds it to the formula record (at its current revision).
export async function uploadInkPhoto(recordId: string, file: File): Promise<void> {
  const { blob, ext, type } = await preparePhoto(file)
  const path = `${recordId}/${crypto.randomUUID()}.${ext}`
  const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: type, upsert: false })
  if (up.error) throw new Error(up.error.message)
  const { data, error } = await supabase.rpc('add_ink_formula_photo', { p_record_id: recordId, p_path: path })
  if (error) throw new Error(error.message)
  const reply = data as { ok: boolean; message?: string }
  if (!reply.ok) {
    await supabase.storage.from(PHOTO_BUCKET).remove([path])
    throw new Error(reply.message ?? 'The photo could not be added.')
  }
}

// The formula's photos, oldest first, with links to show them.
export async function loadInkPhotos(recordId: string): Promise<InkPhoto[]> {
  const { data, error } = await supabase
    .from('ink_formula_photos')
    .select('id, revision, path, uploaded_by_name, uploaded_at')
    .eq('record_id', recordId)
    .order('uploaded_at')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Omit<InkPhoto, 'url'>[]
  if (!rows.length) return []
  const signed = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(
    rows.map((r) => r.path),
    3600,
  )
  const urls = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]))
  return rows.map((r) => ({ ...r, url: urls.get(r.path) ?? null }))
}

// Removes a photo from the formula, then its file.
export async function removeInkPhoto(id: string): Promise<void> {
  const { data, error } = await supabase.rpc('remove_ink_formula_photo', { p_id: id })
  if (error) throw new Error(error.message)
  const reply = data as { ok: boolean; path?: string; message?: string }
  if (!reply.ok) throw new Error(reply.message ?? 'The photo could not be removed.')
  if (reply.path) await supabase.storage.from(PHOTO_BUCKET).remove([reply.path])
}
