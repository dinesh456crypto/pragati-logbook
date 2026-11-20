// Job sample photos of an ink formula: saved photos, and new photos waiting to be saved.
import { useEffect, useMemo, useRef } from 'react'
import { Camera, X } from 'lucide-react'
import { formatMoment } from '../lib/production'
import { MAX_NEW_PHOTOS } from '../lib/inkPhotos'
import type { InkPhoto } from '../lib/inkPhotos'

export function PhotoGallery({ photos, onRemove }: { photos: InkPhoto[]; onRemove?: (photo: InkPhoto) => void }) {
  return (
    <div className="photo-grid">
      {photos.map((p) => (
        <figure key={p.id} className="photo-tile">
          {p.url ? (
            <a href={p.url} target="_blank" rel="noreferrer" title="Open the full photo">
              <img src={p.url} alt={`Job sample, revision ${p.revision}`} loading="lazy" />
            </a>
          ) : (
            <div className="photo-missing muted small">Photo not available</div>
          )}
          <figcaption className="muted small">
            Revision {p.revision} · {formatMoment(p.uploaded_at)}
            {p.uploaded_by_name ? ` · ${p.uploaded_by_name}` : ''}
          </figcaption>
          {onRemove && (
            <button type="button" className="photo-remove" title="Remove photo" aria-label="Remove photo" onClick={() => onRemove(p)}>
              <X size={16} />
            </button>
          )}
        </figure>
      ))}
    </div>
  )
}

// New photos chosen on this screen; they are uploaded when the formula is saved.
export function PhotoPicker({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews])
  const room = MAX_NEW_PHOTOS - files.length

  return (
    <>
      {files.length > 0 && (
        <div className="photo-grid">
          {files.map((f, i) => (
            <figure key={`${f.name}-${f.lastModified}-${i}`} className="photo-tile pending">
              <img src={previews[i]} alt={`New photo ${i + 1}`} />
              <figcaption className="muted small">New · saved with the formula</figcaption>
              {!disabled && (
                <button
                  type="button"
                  className="photo-remove"
                  title="Remove photo"
                  aria-label={`Remove new photo ${i + 1}`}
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                >
                  <X size={16} />
                </button>
              )}
            </figure>
          ))}
        </div>
      )}
      {!disabled && room > 0 && (
        <>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])].filter((f) => f.type.startsWith('image/') || !f.type)
              e.target.value = ''
              if (picked.length) onChange([...files, ...picked.slice(0, room)])
            }}
          />
          <button type="button" className="small" onClick={() => input.current?.click()}>
            <Camera size={16} /> Add photo
          </button>
        </>
      )}
    </>
  )
}
