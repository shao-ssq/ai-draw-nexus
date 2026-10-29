/**
 * Validators for different diagram engine outputs
 */

import type { EngineType } from '@/types'

export interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Mermaid code validator
 * Uses mermaid.parse() for syntax validation
 */
export async function validateMermaid(code: string): Promise<ValidationResult> {
  try {
    const mermaid = await import('mermaid')
    await mermaid.default.parse(code)
    return { valid: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid Mermaid syntax'
    return { valid: false, error: message }
  }
}

/**
 * Excalidraw JSON validator
 * Validates JSON format and required fields
 * Supports both array format (direct elements) and object format (with type/elements fields)
 */
export function validateExcalidraw(json: string): ValidationResult {
  try {
    const data = JSON.parse(json)

    // Determine elements array - support both formats:
    // 1. Direct array: [{ id, type, x, y, ... }, ...]
    // 2. Object format: { type: "excalidraw", elements: [...] }
    let elements: unknown[]

    if (Array.isArray(data)) {
      // Direct array format (AI-generated)
      elements = data
    } else if (data && typeof data === 'object') {
      // Object format with elements field
      if (!Array.isArray(data.elements)) {
        return { valid: false, error: 'Missing or invalid "elements" array' }
      }
      elements = data.elements
    } else {
      return { valid: false, error: 'Invalid format: expected array or object with elements' }
    }

    // Validate each element has required properties
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as Record<string, unknown>

      // id is optional - Excalidraw will auto-generate if missing
      if (!el.type) {
        return { valid: false, error: `Element at index ${i} missing "type" field` }
      }
      if (typeof el.x !== 'number' || typeof el.y !== 'number') {
        return { valid: false, error: `Element at index ${i} missing or invalid "x"/"y" coordinates` }
      }
    }

    return { valid: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON format'
    return { valid: false, error: message }
  }
}

/**
 * Drawio XML validator
 *
 * Accepts either:
 *   - A bare <mxCell>...</mxCell> fragment (what the AI prompt produces —
 *     it explicitly forbids the outer <mxfile>/<mxGraphModel>/<root> wrappers).
 *   - A wrapped <mxfile><diagram><mxGraphModel>...</mxGraphModel></diagram></mxfile>
 *     document (what drawio emits and what we store in IndexedDB after wrap).
 *
 * Either way, only well-formed XML with at least one <mxCell> is accepted.
 */
export function validateDrawio(xml: string): ValidationResult {
  try {
    const parser = new DOMParser()

    // 1) The AI sometimes emits an XML prolog (<?xml...?>) before the
    //    mxCell fragments. Strip it before parsing.
    let toParse = xml.replace(/^\s*<\?xml[^?]*\?>\s*/i, '').trim()

    // 2) AI 输出通常是多个兄弟 <mxCell>（按 apply prompt 禁止写外层 mxfile 包装）。
    //    严格 XML 文档只能有 1 个根元素；DOMParser('text/xml') 会把第一个
    //    <mxCell> 当根元素、后面的当成 "extra content at the end of the
    //    document" 报错。
    //    临时用 <mxroot> 包一层再解析（wrapper 仅用于 validate，不修改原数据）；
    //    已带 <mxfile> 包装的则直接解析（已经是单根树）。
    const isAlreadyWrapped = /^<mxfile[\s>]/i.test(toParse)
    if (!isAlreadyWrapped) {
      toParse = `<mxroot>${toParse}</mxroot>`
    }

    const doc = parser.parseFromString(toParse, 'text/xml')

    // Check for parsing errors
    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      return { valid: false, error: 'Invalid XML format: ' + parseError.textContent }
    }

    // Require at least one <mxCell> (in either <root> or at the top level).
    const mxCells = doc.querySelectorAll('mxCell')
    if (mxCells.length === 0) {
      return { valid: false, error: 'No mxCell elements found' }
    }

    return { valid: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid XML format'
    return { valid: false, error: message }
  }
}

/** Diagram+ 完整 HTML／SVG 合约与安全检查。 */
export function validateDiagramDesign(html: string): ValidationResult {
  if (!/<!doctype\s+html/i.test(html) || !/<\/html\s*>/i.test(html)) {
    return { valid: false, error: 'Diagram+ 必须输出完整的 HTML 文档' }
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const svg = doc.querySelector('svg')
  if (!svg) return { valid: false, error: 'Diagram+ HTML 中缺少 SVG 图形' }
  if (!svg.getAttribute('viewBox')) return { valid: false, error: 'SVG 缺少 viewBox' }
  if (svg.getAttribute('role') !== 'img') return { valid: false, error: 'SVG 缺少 role="img"' }
  if (!svg.querySelector(':scope > title')?.textContent?.trim()) {
    return { valid: false, error: 'SVG 缺少有效的 title' }
  }
  if (!svg.querySelector(':scope > desc')?.textContent?.trim()) {
    return { valid: false, error: 'SVG 缺少有效的 desc' }
  }

  if (doc.querySelector('script, iframe, object, embed, base, form')) {
    return { valid: false, error: 'Diagram+ 输出包含不允许的可执行或嵌入元素' }
  }
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) {
        return { valid: false, error: 'Diagram+ 输出包含不允许的事件属性' }
      }
    }
  }
  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[href]'))) {
    const href = link.getAttribute('href') ?? ''
    if (!href.startsWith('https://fonts.googleapis.com/css2')) {
      return { valid: false, error: 'Diagram+ 输出包含未获准的外部资源' }
    }
  }

  return { valid: true }
}

/**
 * Validate content based on engine type
 */
export async function validateContent(
  content: string,
  engineType: EngineType
): Promise<ValidationResult> {
  switch (engineType) {
    case 'mermaid':
      return validateMermaid(content)
    case 'excalidraw':
      return validateExcalidraw(content)
    case 'drawio':
      return validateDrawio(content)
    case 'diagram-design':
      return validateDiagramDesign(content)
    case 'image2':
      // image2 的 content 是 data URL（data:image/...;base64,...）
      if (!content) {
        return { valid: false, error: '图片为空' }
      }
      if (!/^data:image\/[a-zA-Z0-9+]+;base64,/.test(content)) {
        return { valid: false, error: '图片格式无效（需为 base64 data URL）' }
      }
      return { valid: true }
    default:
      return { valid: false, error: `Unknown engine type: ${engineType}` }
  }
}
