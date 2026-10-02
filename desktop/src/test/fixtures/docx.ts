import { strToU8, zipSync } from 'fflate'
import { quadrantPng } from './png'

/**
 * Word documents built in a test, from the XML up. A .docx is a zip of XML parts, so
 * a fixture is readable as the document it stands for, and the hostile ones — a link
 * that runs script, a style that fetches a remote image — say plainly what they try.
 */

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

export type DocxRelationship = { id: string; type: string; target: string; external?: boolean }

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const DEFAULT_STYLES = `${XML}<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`

export function packDocx(options: {
  /** The inside of `<w:body>`, before the section properties. */
  body: string
  relationships?: DocxRelationship[]
  /** Extra parts, by path in the archive. */
  files?: Record<string, Uint8Array | string>
  styles?: string
  extraContentTypes?: string
}): Uint8Array {
  const relationships: DocxRelationship[] = [
    { id: 'rIdStyles', type: `${REL}/styles`, target: 'styles.xml' },
    ...(options.relationships ?? []),
  ]
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="html" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${options.extraContentTypes ?? ''}</Types>`,
    ),
    '_rels/.rels': strToU8(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships
        .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeXml(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
        .join('')}</Relationships>`,
    ),
    'word/styles.xml': strToU8(options.styles ?? DEFAULT_STYLES),
    'word/document.xml': strToU8(
      `${XML}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${options.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    ),
  }
  for (const [name, content] of Object.entries(options.files ?? {})) {
    parts[name] = typeof content === 'string' ? strToU8(content) : content
  }
  return zipSync(parts)
}

export const paragraph = (text: string, runProperties = '') =>
  `<w:p><w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`

const hyperlink = (id: string, text: string) =>
  `<w:hyperlink r:id="${id}"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve">  </w:t></w:r>`

export const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'

const inlinePicture = (relationshipId: string, cx: number, cy: number) =>
  `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

/** The four kinds of link a document can carry, one of which is a way to run script. */
export const LINKS = {
  https: 'https://example.com/docs',
  javascript: 'javascript:alert(1)',
  file: 'file:///etc/hosts',
  mailto: 'mailto:someone@example.com',
} as const

/**
 * A thesis-shaped document: a heading, formatted runs with Chinese text, a table, a
 * picture, the four kinds of link and a link to a bookmark on the last of three pages.
 */
export function thesisDocx(): Uint8Array {
  const table = `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${[0, 1]
    .map((r) => `<w:tr>${[0, 1, 2].map((c) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>R${r + 1}C${c + 1} 单元格</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`)
    .join('')}</w:tbl>`
  const body = [
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 绪论 Introduction</w:t></w:r></w:p>',
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="C00000"/></w:rPr><w:t>italic red 中文段落，用于检查换行与字体。</w:t></w:r></w:p>',
    `<w:p>${hyperlink('rIdL1', 'https link')}${hyperlink('rIdL2', 'javascript link')}${hyperlink('rIdL3', 'file link')}${hyperlink('rIdL4', 'mailto link')}<w:hyperlink w:anchor="bm1"><w:r><w:t>internal link</w:t></w:r></w:hyperlink></w:p>`,
    table,
    inlinePicture('rIdImg1', 1905000, 1905000),
    ...Array.from({ length: 12 }, (_, index) => paragraph(`Filler paragraph ${index + 1}: The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过了懒狗。`)),
    pageBreak,
    ...Array.from({ length: 8 }, (_, index) => paragraph(`Page two paragraph ${index + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`)),
    pageBreak,
    '<w:p><w:bookmarkStart w:id="0" w:name="bm1"/><w:r><w:t>BOOKMARK TARGET on page three</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>',
  ].join('')
  return packDocx({
    body,
    relationships: [
      { id: 'rIdImg1', type: `${REL}/image`, target: 'media/image1.png' },
      { id: 'rIdL1', type: `${REL}/hyperlink`, target: LINKS.https, external: true },
      { id: 'rIdL2', type: `${REL}/hyperlink`, target: LINKS.javascript, external: true },
      { id: 'rIdL3', type: `${REL}/hyperlink`, target: LINKS.file, external: true },
      { id: 'rIdL4', type: `${REL}/hyperlink`, target: LINKS.mailto, external: true },
    ],
    files: { 'word/media/image1.png': quadrantPng() },
  })
}

/**
 * A document whose body is an `<w:altChunk>` pointing at an HTML part with a script,
 * a remote image that reports back, and a `javascript:` link inside it. Word renders
 * such a part as HTML; a previewer that does the same runs whatever is in it.
 */
export function altChunkDocx(probeOrigin: string): Uint8Array {
  const html = `<html><body><h2>ALTCHUNK-HTML</h2><script>window.parent.__altchunkScript=1</script><img src="${probeOrigin}/altchunk.png" onerror="window.parent.__altchunkOnerror=1"><a href="javascript:window.parent.__altchunkJs=1">alt js link</a></body></html>`
  return packDocx({
    body: `${paragraph('Before altChunk')}<w:altChunk r:id="rIdAlt1"/>${paragraph('After altChunk')}`,
    relationships: [{ id: 'rIdAlt1', type: `${REL}/aFChunk`, target: 'afchunk.html' }],
    files: { 'word/afchunk.html': html },
  })
}

/**
 * Hostile styling. docx-preview writes style values into a generated `<style>` element and
 * into inline styles, unescaped; each payload here tries to make the browser fetch
 * `${probeOrigin}/<name>`, or to break out of the rule it sits in.
 */
export function injectionDocx(probeOrigin: string): Uint8Array {
  const styles = `${XML}<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Evil"><w:name w:val="Evil"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="000000;background-image:url(${probeOrigin}/css-color.png)"/><w:rFonts w:ascii="x;}@import url(${probeOrigin}/css-import.css);a{" w:hAnsi="y"/></w:rPr></w:style></w:styles>`
  const body = [
    '<w:p><w:pPr><w:pStyle w:val="Evil"/></w:pPr><w:r><w:t>evil style paragraph</w:t></w:r></w:p>',
    `<w:p><w:r><w:rPr><w:color w:val="red;background:url(${probeOrigin}/css-inline.png)"/></w:rPr><w:t>inline colour payload</w:t></w:r></w:p>`,
    paragraph('<img src=x onerror="window.parent.__textXss=1"> <script>window.parent.__textScript=1</script>'),
  ].join('')
  return packDocx({ body, styles })
}

/** `pages` pages of twenty lines each, for scroll, zoom and height checks. */
export function tallDocx(pages = 6): Uint8Array {
  const parts: string[] = []
  for (let page = 0; page < pages; page += 1) {
    for (let line = 0; line < 20; line += 1) parts.push(paragraph(`Page ${page + 1} line ${line + 1} - zoom and height check 中文`))
    if (page < pages - 1) parts.push(pageBreak)
  }
  return packDocx({ body: parts.join('') })
}
