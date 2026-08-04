import { useMemo, useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'

/**
 * 轻量级 Markdown 渲染器，支持流式输出。
 * - 段落 / 空行
 * - 行内 `code`
 * - ```lang 代码块
 * - **bold** / *italic*
 * - 无序列表 / 有序列表
 * 流式时未闭合的代码块也会被实时渲染。
 */
interface Block {
  type: 'code' | 'text'
  lang?: string
  content: string
}

/** 各引擎对应的代码语言标签 */
const ENGINE_LANG: Record<string, string> = {
  mermaid: 'mermaid',
  excalidraw: 'json',
  drawio: 'xml',
}

/**
 * 启发式判断内容是否为裸代码（AI 系统提示禁止输出 markdown 围栏，
 * 因此 mermaid / drawio XML / excalidraw JSON 会以纯文本形式到达，需要在此识别）。
 */
function looksLikeCode(src: string): boolean {
  const trimmed = src.trim()
  if (!trimmed) return false
  // XML / mxCell
  if (/^<\??mx|<mxCell|<\/mxGraphModel/i.test(trimmed)) return true
  // JSON 数组或对象
  if (/^[[{]/.test(trimmed)) return true
  // Mermaid 配置指令开头（%%{init: ...}%%）
  if (/^%%\{/.test(trimmed)) return true
  // Mermaid 关键字开头（允许前置空行/空白）
  if (/(^|\n)\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|block-beta)\b/i.test(trimmed)) return true
  return false
}

function parseBlocks(src: string, forceLang?: string): Block[] {
  const blocks: Block[] = []
  const lines = src.split('\n')
  let i = 0
  let textBuf: string[] = []

  const flushText = () => {
    if (textBuf.length) {
      blocks.push({ type: 'text', content: textBuf.join('\n') })
      textBuf = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```([\w-]*)\s*$/)
    if (fence) {
      const lang = fence[1] || ''
      flushText()
      // 收集直到闭合 ``` 或文件结束（流式未闭合也渲染）
      const codeLines: string[] = []
      i++
      let closed = false
      while (i < lines.length) {
        if (/^\s*```\s*$/.test(lines[i])) {
          closed = true
          i++
          break
        }
        codeLines.push(lines[i])
        i++
      }
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') })
      if (!closed) break // 流式中：未闭合，后续无更多行
      continue
    }
    textBuf.push(line)
    i++
  }
  flushText()

  // 没有显式 ``` 围栏、但整体是裸代码（各引擎 AI 输出）：整体渲染为一个代码块
  if (forceLang && blocks.length >= 1) {
    const onlyText = blocks.every((b) => b.type === 'text')
    if (onlyText && looksLikeCode(src)) {
      const raw = blocks.map((b) => b.content).join('\n')
      return [{ type: 'code', lang: forceLang, content: raw }]
    }
  }

  return blocks
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 渲染行内格式：`code`、**bold**、*italic* */
function renderInline(text: string): string {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return s
}

function TextBlock({ content }: { content: string }) {
  const html = useMemo(() => {
    // 拆成段落与列表
    const segments = content.split(/\n{2,}/)
    return segments
      .map((seg) => {
        const trimmed = seg.trim()
        if (!trimmed) return ''
        // 无序列表
        if (/^[-*]\s+/m.test(trimmed) && trimmed.split('\n').every((l) => /^[-*]\s+/.test(l.trim()) || !l.trim())) {
          const items = trimmed
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => `<li>${renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
            .join('')
          return `<ul class="md-ul">${items}</ul>`
        }
        // 有序列表
        if (/^\d+\.\s+/m.test(trimmed) && trimmed.split('\n').every((l) => /^\d+\.\s+/.test(l.trim()) || !l.trim())) {
          const items = trimmed
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => `<li>${renderInline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`)
            .join('')
          return `<ol class="md-ol">${items}</ol>`
        }
        // 普通段落（保留单行换行）
        return `<p class="md-p">${renderInline(trimmed).replace(/\n/g, '<br/>')}</p>`
      })
      .join('')
  }, [content])

  return <div className="md-text" dangerouslySetInnerHTML={{ __html: html }} />
}

function CodeBlock({ lang, content }: { lang?: string; content: string }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className={`md-code-block ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="md-code-header">
        <button
          type="button"
          className="md-code-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          <span className="md-code-lang">{lang || 'text'}</span>
        </button>
      </div>
      {!collapsed && (
        <pre className="md-code-content">
          <code>{content}</code>
        </pre>
      )}
    </div>
  )
}

export function MarkdownRenderer({
  content,
  engineType,
}: {
  content: string
  engineType?: string
}) {
  const forceLang = engineType ? ENGINE_LANG[engineType] : undefined
  const blocks = useMemo(() => parseBlocks(content, forceLang), [content, forceLang])
  return (
    <div className="markdown-body">
      {blocks.map((b, idx) =>
        b.type === 'code' ? (
          <CodeBlock key={idx} lang={b.lang} content={b.content} />
        ) : (
          <TextBlock key={idx} content={b.content} />
        )
      )}
    </div>
  )
}
