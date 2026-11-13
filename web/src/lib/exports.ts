// Excel and PDF downloads for reports. The libraries are loaded only when a
// download is asked for, so they do not slow down the app.

export type CellValue = string | number | null | undefined

export interface ExportTable {
  name: string // sheet name / section title
  headers: string[]
  rows: CellValue[][]
  widths?: number[] // Excel column widths (characters)
}

const safeSheetName = (name: string) => name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet'

export async function downloadExcel(fileName: string, tables: ExportTable[]) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  const sheets = tables.map((t) => ({
    sheet: safeSheetName(t.name),
    columns: t.headers.map((h, i) => ({ width: t.widths?.[i] ?? Math.min(40, Math.max(10, h.length + 2)) })),
    stickyRowsCount: 1,
    data: [
      t.headers.map((h) => ({ value: h, fontWeight: 'bold' as const, backgroundColor: '#E5ECF2' })),
      ...t.rows.map((r) =>
        r.map((v) => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? { value: v, type: Number } : { value: String(v) })),
      ),
    ],
  }))
  await writeXlsxFile(sheets).toFile(fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`)
}

export async function downloadPdf(fileName: string, title: string, subtitle: string, tables: ExportTable[]) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const widest = Math.max(...tables.map((t) => t.headers.length))
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: widest > 16 ? 'a3' : 'a4' })
  const navy: [number, number, number] = [16, 43, 70]
  doc.setFontSize(15)
  doc.setTextColor(...navy)
  doc.text(title, 32, 36)
  doc.setFontSize(9)
  doc.setTextColor(90)
  doc.text(subtitle, 32, 52)
  let y = 64
  for (const t of tables) {
    if (tables.length > 1) {
      doc.setFontSize(11)
      doc.setTextColor(...navy)
      doc.text(t.name, 32, y + 12)
      y += 18
    }
    autoTable(doc, {
      startY: y,
      head: [t.headers],
      body: t.rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toLocaleString('en-IN') : v))),
      styles: { fontSize: widest > 16 ? 6.5 : 8, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: navy, textColor: 255 },
      alternateRowStyles: { fillColor: [244, 247, 250] },
      margin: { left: 32, right: 32 },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20
  }
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setTextColor(120)
    doc.text(`Pragati Offset · Page ${i} of ${pages}`, 32, doc.internal.pageSize.getHeight() - 16)
  }
  doc.save(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`)
}

// Minutes as a number of hours with one decimal, for exports.
export const hours = (minutes: number | null | undefined) => (minutes == null ? null : Math.round((minutes / 60) * 10) / 10)

export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null)
