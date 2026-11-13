// Text-based placeholder logo until the approved Pragati Offset logo is supplied.
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      PO
    </span>
  )
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <BrandMark />
      {!compact && (
        <div className="brand-text">
          <strong>PRAGATI OFFSET</strong>
          <span>Production | Precision | Performance</span>
        </div>
      )}
    </div>
  )
}
