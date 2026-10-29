// src/lib/drawioXml.ts
// AI emits bare <mxCell> fragments (see server/_shared/systemPrompts.ts).
// drawio's Editor.setFileData / extractGraphModel accepts either a wrapped
// <mxfile> or the inner <mxGraphModel>; we wrap fragments into a single-page
// <mxfile><diagram><mxGraphModel><root>...</root></mxGraphModel></diagram></mxfile>
// before they reach the editor so storage and export are consistent.

const MXFILE_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<mxfile host="wedraw" agent="机灵鬼儿/1.0" version="31.4.6">'
const DIAGRAM_OPEN = '<diagram id="page-1" name="Page-1">'
const GRAPHMODEL_OPEN =
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" ' +
  'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ' +
  'pageWidth="850" pageHeight="1100" math="0" shadow="0">'
const ROOT_OPEN = '<root>'
const BASE_CELLS = '<mxCell id="0"/><mxCell id="1" parent="0"/>'

function forcePageViewDisabled(xml: string): string {
  return xml.replace(/(<mxGraphModel\b[^>]*)(>)/i, (_tag, attributes: string, close: string) => {
    const normalizedAttributes = attributes.replace(
      /(\bpage\s*=\s*["'])[^"']*(["'])/i,
      (_match, prefix: string, suffix: string) => `${prefix}0${suffix}`,
    )
    return normalizedAttributes.includes(' page="0"') || /\bpage\s*=\s*["']0["']/i.test(normalizedAttributes)
      ? normalizedAttributes + close
      : normalizedAttributes + ' page="0"' + close
  })
}

/**
 * Wrap inner mxGraphModel XML (or bare <mxCell> fragments) into a single-page
 * <mxfile> document.
 */
export function wrapToMxfile(innerXml: string): string {
  const trimmed = innerXml.trim()
  return [
    MXFILE_HEAD,
    DIAGRAM_OPEN,
    GRAPHMODEL_OPEN,
    ROOT_OPEN,
    BASE_CELLS,
    trimmed,
    '</root>',
    '</mxGraphModel>',
    '</diagram>',
    '</mxfile>',
  ].join('\n')
}

/**
 * True when the input already starts with an <mxfile> root element.
 */
export function isMxfileWrapped(xml: string): boolean {
  return /<mxfile[\s>]/i.test(xml)
}

/**
 * Wrap if not already wrapped. Idempotent.
 */
export function ensureMxfileWrapped(xml: string): string {
  if (!xml) return xml
  const wrapped = isMxfileWrapped(xml) ? xml : wrapToMxfile(xml)
  return forcePageViewDisabled(wrapped)
}

/**
 * Extract the inner <mxGraphModel> string from a wrapped <mxfile>.
 * If input is already an <mxGraphModel> or fragments, returns it as-is.
 */
export function unwrapFromMxfile(xml: string): string {
  if (!xml) return ''
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const graphModel = doc.querySelector('mxGraphModel')
    if (graphModel) {
      return new XMLSerializer().serializeToString(graphModel)
    }
  } catch {
    // fall through
  }
  return xml
}

/**
 * 从仍在生成的 XML 中提取已经闭合的 mxCell。
 * 未完成的最后一个 cell 会被忽略，因此每次返回值都能安全包装并交给 drawio。
 * id=0/1 是 drawio 的基础节点，由 wrapToMxfile 统一补充，这里避免重复。
 */
export function extractPartialDrawioCells(xml: string): string | null {
  const matches = xml.match(/<mxCell\b[^>]*\/\s*>|<mxCell\b[^>]*>[\s\S]*?<\/mxCell\s*>/gi) ?? []
  const cells = matches.filter((cell) => !/\bid\s*=\s*["'](?:0|1)["']/i.test(cell))
  if (cells.length === 0) return null

  const candidate = cells.join('\n')
  const doc = new DOMParser().parseFromString(`<root>${candidate}</root>`, 'text/xml')
  return doc.querySelector('parsererror') ? null : candidate
}

/** Draw.IO 初始化时会写回仅含基础节点的 XML，这种文档仍应视为空画布。 */
export function isEmptyDrawioXml(xml: string): boolean {
  if (!xml.trim()) return true
  const cells = xml.match(/<mxCell\b[^>]*>/gi) ?? []
  return cells.every((cell) => /\bid\s*=\s*["'](?:0|1)["']/i.test(cell))
}
