/**
 * Hand-built PDFs for tests: no dependency, and they run under vitest in Node and
 * jsdom alike. `buildPdf` computes the xref offsets; everything else is plain PDF
 * syntax, so a fixture is readable as the document it stands for.
 */

const latin1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff
  return out
}

export type PdfObject = string | { dict: string; data: Uint8Array }

/** Objects are numbered 1..n in array order; object 1 must be the catalog. */
export function buildPdf(objects: PdfObject[]): Uint8Array {
  const chunks: Uint8Array[] = []
  let length = 0
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? latin1(part) : part
    chunks.push(bytes)
    length += bytes.length
  }

  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(length)
    push(`${index + 1} 0 obj\n`)
    if (typeof object === 'string') {
      push(object)
    } else {
      push(`<< ${object.dict} /Length ${object.data.length} >>\nstream\n`)
      push(object.data)
      push('\nendstream')
    }
    push('\nendobj\n')
  })

  const xrefOffset = length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  push(xref)
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let position = 0
  for (const chunk of chunks) {
    out.set(chunk, position)
    position += chunk.length
  }
  return out
}

export type PdfPageSpec = {
  /** Width and height in PDF points (1/72 in). US Letter is 612 × 792. */
  width: number
  height: number
  /** One line of Helvetica text near the top of the page. */
  text: string
}

/** A document with one page per spec, each carrying its own size and a line of text. */
export function pdfWithPages(pages: PdfPageSpec[]): Uint8Array {
  const fontObject = 3 + pages.length * 2
  const objects: PdfObject[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ]
  pages.forEach((page, index) => {
    const pageObject = 3 + index * 2
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${pageObject + 1} 0 R /Resources << /Font << /F1 ${fontObject} 0 R >> >> >>`,
    )
    objects.push({ dict: '', data: latin1(`BT /F1 24 Tf 20 ${page.height - 40} Td (${page.text}) Tj ET`) })
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  return buildPdf(objects)
}

/** `count` Letter-sized pages, each reading "Page N of count". */
export function letterPdf(count: number): Uint8Array {
  return pdfWithPages(
    Array.from({ length: count }, (_, index) => ({
      width: 612,
      height: 792,
      text: `Page ${index + 1} of ${count}`,
    })),
  )
}
