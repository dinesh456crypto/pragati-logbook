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
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="Scan the barcode or job card QR with the camera"
        aria-label={label || 'Scan'}
      >
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

// Reads one video frame: the phone's own barcode reader where the browser offers it
// (Chrome on Android); otherwise jsQR for QR codes (good with dense job card QR codes)
// and ZXing for line barcodes (Code 128, Code 39, EAN, ...).
async function makeReader(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector
  const formats = Detector ? await Detector.getSupportedFormats().catch(() => [] as string[]) : []
  if (Detector && formats.includes('qr_code')) {
    const detector = new Detector({ formats })
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null
  }
  const [{ default: jsQR }, zx] = await Promise.all([import('jsqr'), import('@zxing/library')])
  const lines = new zx.MultiFormatOneDReader(
    new Map<unknown, unknown>([
      [
        zx.DecodeHintType.POSSIBLE_FORMATS,
        [zx.BarcodeFormat.CODE_128, zx.BarcodeFormat.CODE_39, zx.BarcodeFormat.EAN_13, zx.BarcodeFormat.EAN_8, zx.BarcodeFormat.UPC_A, zx.BarcodeFormat.ITF],
      ],
    ]) as never,
  )
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let tick = 0
  return async (video) => {
    if (!ctx) return null
    // At most 1280 pixels wide: enough for a job card QR, and quick on phones.
    const scale = Math.min(1, 1280 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
    if (qr?.data) return qr.data
    tick++
    if (tick % 2) return null // line barcodes: every other frame
    const px = image.data
    const gray = new Uint8ClampedArray(image.width * image.height)
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000
    try {
      const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(gray, image.width, image.height)))
      return lines.decode(bitmap, new Map() as never).getText()
    } catch {
      return null
    }
  }
}

// The browser's built-in barcode reader (not in every browser, so typed here).
interface BarcodeDetectorClass {
  new (options?: { formats?: string[] }): { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> }
  getSupportedFormats: () => Promise<string[]>
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
    const found = (raw: string) => {
      const text = raw.trim()
      if (!text || done.current) return
      done.current = true
      stop?.()
      onScanRef.current(text)
    }
    // A sharp picture matters for job card QR codes, which hold a lot of text.
    const constraints: MediaStreamConstraints = {
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }
    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' })
        const video = videoRef.current
        if (!video) return
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        video.srcObject = stream
        await video.play().catch(() => {})
        const read = await makeReader()
        let busy = false
        const timer = setInterval(async () => {
          if (busy || done.current || video.readyState < 2 || !video.videoWidth) return
          busy = true
          try {
            const text = await read(video)
            if (text) found(text)
          } catch {
            /* nothing readable in this frame */
          } finally {
            busy = false
          }
        }, 250)
        stop = () => {
          clearInterval(timer)
          stream.getTracks().forEach((t) => t.stop())
        }
        if (cancelled) stop?.()
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
      title="Scan production order barcode or QR"
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
              {starting ? 'Starting the camera…' : 'Hold the barcode or job card QR inside the picture. It is read automatically.'}
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}
