import { forwardRef, useCallback, useImperativeHandle, useState } from 'react'
import Editor from '@monaco-editor/react'
import { Check, Copy, FileCode2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useEditorStore } from '@/stores/editorStore'
import { extractStandaloneSvg, renderSvgToPngDataUrl } from '@/lib/diagramDesign'

export interface DiagramDesignRendererRef {
  exportAsSvg: () => void
  exportAsPng: () => void
  exportAsSource: () => void
  showSourceCode: () => void
  hideSourceCode: () => void
  toggleSourceCode: () => void
  getThumbnail: () => Promise<string>
}

interface DiagramDesignRendererProps {
  code: string
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Diagram+ 静态 HTML/SVG 预览与源码编辑器。 */
export const DiagramDesignRenderer = forwardRef<DiagramDesignRendererRef, DiagramDesignRendererProps>(
  function DiagramDesignRenderer({ code }, ref) {
    const [showSource, setShowSource] = useState(false)
    const [draft, setDraft] = useState({ source: code, value: code })
    const [copied, setCopied] = useState(false)
    const currentProjectId = useEditorStore((state) => state.currentProjectId)
    const setContent = useEditorStore((state) => state.setContent)
    // AI 更新或版本切换后直接使用新源码，不通过 effect 同步状态。
    const editedCode = draft.source === code ? draft.value : code

    const exportAsSvg = useCallback(() => {
      if (!code) return
      try {
        const svg = extractStandaloneSvg(code)
        downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `diagram-plus-${Date.now()}.svg`)
      } catch (error) {
        console.error('Failed to export Diagram+ SVG:', error)
      }
    }, [code])

    const exportAsPng = useCallback(async () => {
      if (!code) return
      try {
        const dataUrl = await renderSvgToPngDataUrl(extractStandaloneSvg(code), 2)
        const link = document.createElement('a')
        link.href = dataUrl
        link.download = `diagram-plus-${Date.now()}.png`
        document.body.appendChild(link)
        link.click()
        link.remove()
      } catch (error) {
        console.error('Failed to export Diagram+ PNG:', error)
      }
    }, [code])

    const exportAsSource = useCallback(() => {
      if (!code) return
      downloadBlob(new Blob([code], { type: 'text/html;charset=utf-8' }), `diagram-plus-${Date.now()}.html`)
    }, [code])

    const getThumbnail = useCallback(async () => {
      if (!code) return ''
      try {
        return await renderSvgToPngDataUrl(extractStandaloneSvg(code), 1, 400, 300)
      } catch (error) {
        console.error('Failed to generate Diagram+ thumbnail:', error)
        return ''
      }
    }, [code])

    useImperativeHandle(ref, () => ({
      exportAsSvg,
      exportAsPng: () => { void exportAsPng() },
      exportAsSource,
      showSourceCode: () => setShowSource(true),
      hideSourceCode: () => setShowSource(false),
      toggleSourceCode: () => setShowSource((visible) => !visible),
      getThumbnail,
    }), [exportAsSvg, exportAsPng, exportAsSource, getThumbnail])

    const handleCopy = async () => {
      await navigator.clipboard.writeText(editedCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }

    const handleApply = () => {
      if (!currentProjectId) return
      setContent(currentProjectId, editedCode)
    }

    if (!code) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-background">
          <div className="text-center text-muted">
            <FileCode2 className="mx-auto mb-3 h-12 w-12 opacity-30" />
            <p className="text-sm">还没有生成 Diagram+ 图表</p>
            <p className="mt-1 text-xs opacity-70">在左侧输入描述后点击发送</p>
          </div>
        </div>
      )
    }

    return (
      <div className="relative h-full w-full overflow-hidden bg-[#f5f5f5]">
        <iframe
          title="Diagram+ 图表预览"
          srcDoc={code}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-full w-full border-0"
        />

        {showSource && (
          <aside className="absolute inset-y-0 right-0 flex w-[46%] min-w-[360px] max-w-[760px] flex-col border-l border-border bg-surface shadow-2xl">
            <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-3">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <FileCode2 className="h-4 w-4" />
                <span>Diagram+ HTML</span>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={handleCopy} className="h-8 gap-1.5 px-2 text-xs">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制' : '复制'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleApply}
                  disabled={editedCode === code}
                  className="h-8 px-2 text-xs"
                >
                  应用修改
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setShowSource(false)} className="h-8 w-8">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                language="html"
                value={editedCode}
                onChange={(value) => setDraft({ source: code, value: value ?? '' })}
                theme="vs"
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
            </div>
          </aside>
        )}
      </div>
    )
  },
)
