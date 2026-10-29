import { useCallback, useRef, useImperativeHandle, forwardRef, useEffect, useState } from 'react'
import {
  useEditorStore,
  selectActiveContent,
  selectActiveProjectId,
  selectEngineType,
} from '@/stores/editorStore'
import {
  useChatStore,
  selectActiveIsStreaming,
  selectActiveStreamingStartedAt,
} from '@/stores/chatStore'
import { MermaidRenderer, type MermaidRendererRef } from '@/features/engines/mermaid/MermaidRenderer'
import { ExcalidrawEditor, type ExcalidrawEditorRef } from '@/features/engines/excalidraw/ExcalidrawEditor'
import { DrawioEditor, type DrawioEditorRef } from '@/features/engines/drawio/DrawioEditor'
import { DiagramDesignRenderer, type DiagramDesignRendererRef } from '@/features/engines/diagram/DiagramDesignRenderer'
import { Image2Viewer, type Image2ViewerRef } from '@/features/engines/image2/Image2Viewer'

export interface CanvasAreaRef {
  exportAsSvg: () => void
  exportAsPng: () => void
  exportAsSource: () => void
  showSourceCode: () => void
  hideSourceCode: () => void
  toggleSourceCode: () => void
  getThumbnail: () => Promise<string>
}

export const CanvasArea = forwardRef<CanvasAreaRef>(function CanvasArea(_, ref) {
  // 字典化 store —— 切换项目只换槽位，旧槽位的里继续保留后台请求的累积
  const currentContent = useEditorStore(selectActiveContent)
  const currentProjectId = useEditorStore(selectActiveProjectId)
  const engineType = useEditorStore(selectEngineType)
  // Loading overlay 只反映当前活跃项目的流式状态 —— 后台项目的 streaming 不会污染当前 UI
  const isLoading = useChatStore(selectActiveIsStreaming)
  const streamingStartedAt = useChatStore(selectActiveStreamingStartedAt)
  const setContent = useEditorStore((s) => s.setContent)
  const setThumbnailGetter = useEditorStore((s) => s.setThumbnailGetter)

  // Use projectId as key to force remount when switching projects
  // This prevents Excalidraw from using its internal localStorage cache
  const projectKey = currentProjectId || 'no-project'

  // Refs for each engine
  const mermaidRef = useRef<MermaidRendererRef>(null)
  const excalidrawRef = useRef<ExcalidrawEditorRef>(null)
  const drawioRef = useRef<DrawioEditorRef>(null)
  const diagramDesignRef = useRef<DiagramDesignRendererRef>(null)
  const image2Ref = useRef<Image2ViewerRef>(null)

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    exportAsSvg: () => {
      switch (engineType) {
        case 'mermaid':
          mermaidRef.current?.exportAsSvg()
          break
        case 'excalidraw':
          excalidrawRef.current?.exportAsSvg()
          break
        case 'drawio':
          drawioRef.current?.exportAsSvg()
          break
        case 'diagram-design':
          diagramDesignRef.current?.exportAsSvg()
          break
        case 'image2':
          image2Ref.current?.exportAsSvg()
          break
      }
    },
    exportAsPng: () => {
      switch (engineType) {
        case 'mermaid':
          mermaidRef.current?.exportAsPng()
          break
        case 'excalidraw':
          excalidrawRef.current?.exportAsPng()
          break
        case 'drawio':
          drawioRef.current?.exportAsPng()
          break
        case 'diagram-design':
          diagramDesignRef.current?.exportAsPng()
          break
        case 'image2':
          image2Ref.current?.exportAsPng()
          break
      }
    },
    exportAsSource: () => {
      switch (engineType) {
        case 'mermaid':
          mermaidRef.current?.exportAsSource()
          break
        case 'excalidraw':
          excalidrawRef.current?.exportAsSource()
          break
        case 'drawio':
          drawioRef.current?.exportAsSource()
          break
        case 'diagram-design':
          diagramDesignRef.current?.exportAsSource()
          break
        case 'image2':
          image2Ref.current?.exportAsSource()
          break
      }
    },
    showSourceCode: () => {
      switch (engineType) {
        case 'mermaid':
          mermaidRef.current?.showSourceCode()
          break
        case 'excalidraw':
          excalidrawRef.current?.showSourceCode()
          break
        case 'drawio':
          drawioRef.current?.showSourceCode()
          break
        case 'diagram-design':
          diagramDesignRef.current?.showSourceCode()
          break
      }
    },
    hideSourceCode: () => {
      switch (engineType) {
        case 'mermaid':
          mermaidRef.current?.hideSourceCode()
          break
        case 'excalidraw':
          excalidrawRef.current?.hideSourceCode()
          break
        case 'drawio':
          drawioRef.current?.hideSourceCode()
          break
        case 'diagram-design':
          diagramDesignRef.current?.hideSourceCode()
          break
      }
    },
    toggleSourceCode: () => {
      switch (engineType) {
        case 'mermaid':
          mermaidRef.current?.toggleSourceCode()
          break
        case 'excalidraw':
          excalidrawRef.current?.toggleSourceCode()
          break
        case 'drawio':
          drawioRef.current?.toggleSourceCode()
          break
        case 'diagram-design':
          diagramDesignRef.current?.toggleSourceCode()
          break
      }
    },
    getThumbnail: async () => {
      if (engineType === 'drawio' && drawioRef.current) {
        return drawioRef.current.getThumbnail()
      }
      if (engineType === 'diagram-design' && diagramDesignRef.current) {
        return diagramDesignRef.current.getThumbnail()
      }
      if (engineType === 'image2' && image2Ref.current) {
        return image2Ref.current.getThumbnail()
      }
      return ''
    },
  }), [engineType])

  // Register thumbnail getter for drawio, Diagram+ & image2 engines (按 projectId 注册，
  // 后台项目的 thumbnailGetter 各自独立，互不影响)
  useEffect(() => {
    if (!currentProjectId) return
    const projectId = currentProjectId

    if (engineType === 'drawio' && drawioRef.current) {
      setThumbnailGetter(projectId, async () => drawioRef.current!.getThumbnail())
      return () => setThumbnailGetter(projectId, null)
    }

    if (engineType === 'diagram-design' && diagramDesignRef.current) {
      setThumbnailGetter(projectId, async () => diagramDesignRef.current!.getThumbnail())
      return () => setThumbnailGetter(projectId, null)
    }

    if (engineType === 'image2' && image2Ref.current) {
      // 直接用图片 data URL 做缩略图 —— 不用再走画布渲染
      setThumbnailGetter(projectId, async () => image2Ref.current!.getThumbnail())
      return () => setThumbnailGetter(projectId, null)
    }

    // 其他引擎不注册，useAIGenerate 会用 generateThumbnail 兜底
  }, [engineType, currentProjectId, setThumbnailGetter])

  // 加载计时：耗时由 store 里存的"流式开始时间戳"推导，不在本地累加秒数。
  // 这样切走再回来不会归零（重新进入显示的就是真实耗时），切到另一个正在
  // 生成的项目也只显示它自己的耗时 —— 每个项目一份，互不串。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (streamingStartedAt == null) return
    const tick = () => setNow(Date.now())
    // 先补一次 tick：interval 要等 1 秒才响，而切回一个正在生成的项目时，
    // 现在这个 state 还停在"离开的那一刻"，会先显示一秒的旧秒数。
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [streamingStartedAt])
  const elapsedSec =
    streamingStartedAt == null
      ? 0
      : Math.max(0, Math.floor((now - streamingStartedAt) / 1000))

  // Handle content change from editors - only update store, no auto-save to database
  const handleContentChange = useCallback((newContent: string) => {
    if (!currentProjectId) return
    setContent(currentProjectId, newContent)
  }, [setContent, currentProjectId])

  if (!engineType) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-muted">
        Loading...
      </div>
    )
  }

  // Render based on engine type
  const renderEngine = () => {
    if (!currentProjectId) return null
    switch (engineType) {
      case 'mermaid':
        return (
          <MermaidRenderer
            ref={mermaidRef}
            key={projectKey}
            code={currentContent}
          />
        )
      case 'excalidraw':
        return (
          <ExcalidrawEditor
            ref={excalidrawRef}
            key={projectKey}
            data={currentContent}
            onChange={handleContentChange}
          />
        )
      case 'drawio':
        return (
          <DrawioEditor
            ref={drawioRef}
            key={projectKey}
            data={currentContent}
            onChange={handleContentChange}
          />
        )
      case 'diagram-design':
        return (
          <DiagramDesignRenderer
            ref={diagramDesignRef}
            key={projectKey}
            code={currentContent}
          />
        )
      case 'image2':
        return (
          <Image2Viewer
            ref={image2Ref}
            key={projectKey}
            code={currentContent}
          />
        )
      default:
        return null
    }
  }

  return (
    <div className="relative h-full w-full bg-background">
      {renderEngine()}

      {/* Draw.IO 流式生成时保留画布可见，让已完成的图形实时出现。 */}
      {isLoading && engineType === 'drawio' && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-1.5 shadow-sm backdrop-blur-sm">
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-r-transparent" />
          <p className="text-xs text-muted">正在生成，画布实时更新… {elapsedSec}s</p>
        </div>
      )}

      {/* 其他引擎沿用原来的加载遮罩。 */}
      {isLoading && engineType !== 'drawio' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="text-center">
            <div className="mb-2 h-8 w-8 animate-spin rounded-full border-2 border-primary border-r-transparent mx-auto" />
            <p className="text-sm text-muted">Generating diagram... {elapsedSec}s</p>
          </div>
        </div>
      )}
    </div>
  )
})
