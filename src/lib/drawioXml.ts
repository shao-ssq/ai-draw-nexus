// src/lib/drawioXml.ts
// AI emits bare <mxCell> fragments (see src/lib/prompts/drawio.ts).
// drawio's Editor.setFileData / extractGraphModel accepts either a wrapped
// <mxfile> or the inner <mxGraphModel>; we wrap fragments into a single-page
// <mxfile><diagram><mxGraphModel><root>...</root></mxGraphModel></diagram></mxfile>
// before they reach the editor so storage and export are consistent.

const MXFILE_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<mxfile host="wedraw" agent="WeDraw/1.0" version="31.4.6">'
const DIAGRAM_OPEN = '<diagram id="page-1" name="Page-1">'
const GRAPHMODEL_OPEN =
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" ' +
  'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ' +
  'pageWidth="850" pageHeight="1100" math="0" shadow="0">'
const ROOT_OPEN = '<root>'
const BASE_CELLS = '<mxCell id="0"/><mxCell id="1" parent="0"/>'

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
  if (!xml || isMxfileWrapped(xml)) return xml
  return wrapToMxfile(xml)
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
