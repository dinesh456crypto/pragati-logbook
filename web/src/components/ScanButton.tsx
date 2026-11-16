// Scan a barcode (or QR code) with the phone / tablet camera and hand back its text.
// A handheld USB / Bluetooth scanner needs no button: it types into the field like a keyboard.
import { useEffect, useRef, useState } from 'react'
import { ScanBarcode } from 'lucide-react'
import { Modal } from './Modal'

interface Props {
  onScan: (text: string) => void
  disabled?: boolean
  label?: string
}

export function ScanButton({ onScan, disabled, label = 'Scan' }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} title="Scan the barcode with the camera">
        <ScanBarcode size={18} /> {label}
      </button>
      {open && (
        <ScannerDialog
          onClose={() => setOpen(false)}
          onScan={(text) => {
            setOpen(false)
            onScan(text)
          }}
        />
      )}
    </>
  )
}

function cameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? ''
  if (!window.isSecureContext) return 'The camera works only on the secure (https) address of the app.'
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera permission was refused. Allow the camera for this site in the browser settings, then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is busy in another app. Close it and try again.'
  return 'Could not start the camera. Type the production order number instead.'
}

function ScannerDialog({ onClose, onScan }: { onClose: () => void; onScan: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(true)
  const done = useRef(false)
  // The latest callback, so a re-render of the page does not restart the camera.
  const onScanRef = useRef(onScan)
  useEffect(() => {
    onScanRef.current = onScan
  })

  useEffect(() => {
    let stop: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' })
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        if (cancelled || !videoRef.current) return
        const reader = new BrowserMultiFormatReader()
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } }, audio: false },
          videoRef.current,
          (result) => {
            if (!result || done.current) return
            const text = result.getText().trim()
            if (!text) return
            done.current = true
            controls.stop()
            onScanRef.current(text)
          },
        )
        stop = () => controls.stop()
        if (cancelled) stop()
        setStarting(false)
      } catch (err) {
        if (!cancelled) {
          setStarting(false)
          setError(cameraError(err))
        }
      }
    })()
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  return (
    <Modal
      title="Scan production order barcode"
      onClose={onClose}
      width={560}
      footer={
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="form-stack">
        {error ? (
          <p className="notice error">{error}</p>
        ) : (
          <>
            <video ref={videoRef} className="scan-video" muted playsInline />
            <p className="muted small">
              {starting ? 'Starting the camera…' : 'Hold the barcode inside the picture. It is read automatically.'}
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}
