import { useState, useMemo } from 'react'
import { Copy, Check } from 'lucide-react'

/**
 * 轻量级 Markdown 渲染器，支持流式输出。
 * - 段落 / 空行
 * - 行内 `code`
 * - ```lang 代码块（含复制按钮）
 * - **bold** / *italic*
 * - 无序列表 / 有序列表
 * 流式时未闭合的代码块也会被实时渲染。
 */
interface Block {
  type: 'code' | 'text'
  lang?: string
  content: string
}

function parseBlocks(src: string): Block[] {
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
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button className="md-copy-btn" onClick={handleCopy} type="button">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="md-code-content">
        <code>{content}</code>
      </pre>
    </div>
  )
}

export function MarkdownRenderer({ content }: { content: string }) {
  const blocks = useMemo(() => parseBlocks(content), [content])
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
