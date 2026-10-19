import { useCallback, useRef, useImperativeHandle, forwardRef, useEffect, useState } from 'react'
import {
  useEditorStore,
  selectActiveContent,
  selectActiveProjectId,
  selectActiveProject,
  selectEngineType,
} from '@/stores/editorStore'
import {
  useChatStore,
  selectActiveIsStreaming,
} from '@/stores/chatStore'
import { MermaidRenderer, type MermaidRendererRef } from '@/features/engines/mermaid/MermaidRenderer'
import { ExcalidrawEditor, type ExcalidrawEditorRef } from '@/features/engines/excalidraw/ExcalidrawEditor'
import { DrawioEditor, type DrawioEditorRef } from '@/features/engines/drawio/DrawioEditor'
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
  const currentProject = useEditorStore(selectActiveProject)
  const engineType = useEditorStore(selectEngineType)
  // Loading overlay 只反映当前活跃项目的流式状态 —— 后台项目的 streaming 不会污染当前 UI
  const isLoading = useChatStore(selectActiveIsStreaming)
  const setContent = useEditorStore((s) => s.setContent)
  const setThumbnailGetter = useEditorStore((s) => s.setThumbnailGetter)

  // Use projectId as key to force remount when switching projects
  // This prevents Excalidraw from using its internal localStorage cache
  const projectKey = currentProjectId || 'no-project'

  // Refs for each engine
  const mermaidRef = useRef<MermaidRendererRef>(null)
  const excalidrawRef = useRef<ExcalidrawEditorRef>(null)
  const drawioRef = useRef<DrawioEditorRef>(null)
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
        case 'image2':
          image2Ref.current?.showSourceCode()
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
        case 'image2':
          image2Ref.current?.hideSourceCode()
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
        case 'image2':
          image2Ref.current?.toggleSourceCode()
          break
      }
    },
    getThumbnail: async () => {
      if (engineType === 'drawio' && drawioRef.current) {
        return drawioRef.current.getThumbnail()
      }
      if (engineType === 'image2' && image2Ref.current) {
        return image2Ref.current.getThumbnail()
      }
      return ''
    },
  }), [engineType])

  // Register thumbnail getter for drawio & image2 engines (按 projectId 注册，
  // 后台项目的 thumbnailGetter 各自独立，互不影响)
  useEffect(() => {
    if (!currentProjectId) return
    const projectId = currentProjectId

    if (engineType === 'drawio' && drawioRef.current) {
      setThumbnailGetter(projectId, async () => drawioRef.current!.getThumbnail())
      return () => setThumbnailGetter(projectId, null)
    }

    if (engineType === 'image2' && image2Ref.current) {
      // 直接用图片 data URL 做缩略图 —— 不用再走画布渲染
      setThumbnailGetter(projectId, async () => image2Ref.current!.getThumbnail())
      return () => setThumbnailGetter(projectId, null)
    }

    // 其他引擎不注册，useAIGenerate 会用 generateThumbnail 兜底
  }, [engineType, currentProjectId, setThumbnailGetter])

  if (!engineType) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-muted">
        Loading...
      </div>
    )
  }

  // 加载计时：从 isLoading 变 true 开始，每秒 +1；false 时清零
  const [elapsedSec, setElapsedSec] = useState(0)
  useEffect(() => {
    if (!isLoading) {
      setElapsedSec(0)
      return
    }
    setElapsedSec(0)
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [isLoading])

  // Handle content change from editors - only update store, no auto-save to database
  const handleContentChange = useCallback((newContent: string) => {
    if (!currentProjectId) return
    setContent(currentProjectId, newContent)
  }, [setContent, currentProjectId])

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

      {/* Loading Overlay */}
      {isLoading && (
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
