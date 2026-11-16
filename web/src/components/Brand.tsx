export const COMPANY = 'Pragati Offset Private Limited'

// The Pragati fingerprint mark (approved logo).
export function BrandMark({ size = 40 }: { size?: number }) {
  return <img className="brand-mark" src="/logo-mark.png" alt="" width={Math.round(size * 0.75)} height={size} aria-hidden="true" />
}

// Sidebar brand: the mark, the PRAGATI wordmark and the company name.
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'compact' : ''}`} title={COMPANY}>
      <BrandMark size={compact ? 36 : 44} />
      {!compact && (
        <div className="brand-text">
          <img src="/logo-word.png" alt="PRAGATI" className="brand-word" width={120} height={20} />
          <span>Offset Private Limited</span>
        </div>
      )}
    </div>
  )
}
