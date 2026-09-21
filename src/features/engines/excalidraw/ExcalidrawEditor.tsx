import { useState, useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Excalidraw, exportToBlob, exportToSvg, getSceneVersion, restoreElements, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import Editor from '@monaco-editor/react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/Tooltip'
import { Code, X, Copy, Check, Play, Undo2 } from 'lucide-react'

interface ExcalidrawEditorProps {
  data: string // JSON string
  onChange?: (data: string) => void
  className?: string
}

export interface ExcalidrawEditorRef {
  exportAsSvg: () => void
  exportAsPng: () => void
  exportAsSource: () => void
  showSourceCode: () => void
  hideSourceCode: () => void
  toggleSourceCode: () => void
}

// Use generic types to avoid strict Excalidraw type requirements
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExcalidrawElementAny = any

interface ExcalidrawData {
  elements: ExcalidrawElementAny[]
  appState?: Record<string, unknown>
}

/**
 * Fix Excalidraw bug: when line element has width === 0 or height === 0,
 * it causes rendering issues. This function fixes by setting them to 1.
 */
function fixZeroDimensionElements(elements: ExcalidrawElementAny[]): ExcalidrawElementAny[] {
  return elements.map(element => {
    // Only fix line-type elements (line, arrow)
    if (element.type === 'line' || element.type === 'arrow') {
      const needsFix = element.width === 0 || element.height === 0
      if (needsFix) {
        return {
          ...element,
          width: element.width === 0 ? 1 : element.width,
          height: element.height === 0 ? 1 : element.height,
        }
      }
    }
    return element
  })
}

/**
 * Check if elements are full Excalidraw elements (saved from editor)
 * vs skeleton elements (from AI generation).
 * Full elements have versionNonce and seed, skeleton elements don't.
 */
function isFullExcalidrawElements(elements: ExcalidrawElementAny[]): boolean {
  if (elements.length === 0) return false
  // Check if first element has properties that only full elements have
  const firstElement = elements[0]
  return typeof firstElement.versionNonce === 'number' && typeof firstElement.seed === 'number'
}

/**
 * Convert elements to Excalidraw format with proper binding restoration.
 * For full elements (from saved versions), use restoreElements directly.
 * For skeleton elements (from AI), use convertToExcalidrawElements first.
 */
function prepareExcalidrawElements(elements: ExcalidrawElementAny[]): ExcalidrawElementAny[] {
  const fixedElements = fixZeroDimensionElements(elements)

  if (isFullExcalidrawElements(fixedElements)) {
    // Full elements from saved versions - restore directly with binding repair
    return restoreElements(fixedElements, null, { repairBindings: true })
  } else {
    // Skeleton elements from AI - convert first, then restore
    return restoreElements(
      convertToExcalidrawElements(fixedElements),
      null,
      { repairBindings: true }
    )
  }
}

export const ExcalidrawEditor = forwardRef<ExcalidrawEditorRef, ExcalidrawEditorProps>(function ExcalidrawEditor({ data, onChange, className }, ref) {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCodePanel, setShowCodePanel] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editedCode, setEditedCode] = useState(data)
  const [hasChanges, setHasChanges] = useState(false)

  // Refs for tracking scene version and preventing loops
  const lastSceneVersionRef = useRef(0)
  const skipProgrammaticChangeRef = useRef(false)
  const onChangeRef = useRef(onChange)
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  // 记住本组件最后一次 onChange 发出的内容，用于区分“外部新数据”与“自身回流”
  const lastEmittedDataRef = useRef<string>(data)

  // Parse initial data - supports both array format and object format
  const initialData = useMemo<ExcalidrawData | null>(() => {
    if (!data.trim()) {
      return {
        elements: [],
        appState: { currentItemStrokeWidth: 1 },
      }
    }

    try {
      const parsed = JSON.parse(data)
      // Support both formats:
      // 1. Direct array: [{ id, type, x, y, ... }, ...]
      // 2. Object format: { elements: [...] }
      let elementsData: ExcalidrawElementAny[]
      if (Array.isArray(parsed)) {
        elementsData = parsed
      } else if (parsed.elements && Array.isArray(parsed.elements)) {
        elementsData = parsed.elements
      } else {
        throw new Error('Invalid Excalidraw data: expected array or object with elements')
      }

      // Prepare elements with proper binding handling
      const restoredElements = prepareExcalidrawElements(elementsData)

      return {
        elements: restoredElements,
        appState: {
          // 自由绘制默认选最细描边（thin = 1）
          currentItemStrokeWidth: 1,
        },
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Invalid JSON'
      setError(errorMessage)
      return {
        elements: [],
        appState: { currentItemStrokeWidth: 1 },
      }
    }
  }, [data])

  // Keep onChange ref up to date
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // Keep excalidrawAPI ref up to date
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])

  // Clear error when data is valid
  useEffect(() => {
    if (data.trim()) {
      try {
        const parsed = JSON.parse(data)
        // Support both array format and object format
        if (Array.isArray(parsed) || (parsed.elements && Array.isArray(parsed.elements))) {
          setError(null)
        }
      } catch {
        // Error already set in useMemo
      }
    } else {
      setError(null)
    }
  }, [data])

  // Track scene version when initialData changes to skip programmatic updates
  useEffect(() => {
    if (initialData?.elements) {
      const injectedVersion = getSceneVersion(initialData.elements)
      lastSceneVersionRef.current = injectedVersion
      skipProgrammaticChangeRef.current = true
    }
  }, [initialData])

  // Sync editedCode when data prop changes
  useEffect(() => {
    setEditedCode(data)
    setHasChanges(false)
  }, [data])

  // Update canvas when data prop changes from external source (e.g., AI generation)
  useEffect(() => {
    if (!excalidrawAPI || !data.trim()) return

    // 跳过自身回流：data 与本组件最后一次发出的内容一致，说明是 onChange 触发的
    // 父组件 state 更新回流，不是外部新数据，不应覆盖画布（否则用户刚画的笔画会被冲掉）
    if (data === lastEmittedDataRef.current) return

    try {
      const parsed = JSON.parse(data)
      const elementsData = Array.isArray(parsed) ? parsed : parsed.elements

      if (!Array.isArray(elementsData)) return

      // Prepare elements with proper binding handling
      const restoredElements = prepareExcalidrawElements(elementsData)

      // Skip if elements are the same (prevent unnecessary updates)
      const currentElements = excalidrawAPI.getSceneElements()
      const currentVersion = getSceneVersion(currentElements)
      const newVersion = getSceneVersion(restoredElements)

      if (currentVersion !== newVersion) {
        skipProgrammaticChangeRef.current = true
        lastEmittedDataRef.current = data
        excalidrawAPI.updateScene({
          elements: restoredElements,
          appState: { isLoading: false },
        })
      }
    } catch {
      // Invalid JSON, ignore
    }
  }, [data, excalidrawAPI])

  // Copy code handler
  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(editedCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }, [editedCode])

  // Handle code edit (for Monaco Editor)
  const handleCodeChange = useCallback((value: string | undefined) => {
    const newCode = value || ''
    setEditedCode(newCode)
    setHasChanges(newCode !== data)
  }, [data])

  // Apply code changes - use updateScene API to update canvas
  const handleApplyCode = useCallback(() => {
    if (!editedCode.trim() || !excalidrawAPI) return

    try {
      const parsed = JSON.parse(editedCode)
      // Support both array format and object format
      const elementsData = Array.isArray(parsed) ? parsed : parsed.elements

      if (!Array.isArray(elementsData)) {
        console.error('Invalid Excalidraw data format')
        return
      }

      // Prepare elements with proper binding handling
      const restoredElements = prepareExcalidrawElements(elementsData)

      // Update scene using API with isLoading: false to prevent "loading scene" message
      excalidrawAPI.updateScene({
        elements: restoredElements,
        appState: { isLoading: false },
      })

      // Notify parent of change
      if (onChange) {
        lastEmittedDataRef.current = editedCode
        onChange(editedCode)
      }
      setHasChanges(false)
    } catch (err) {
      console.error('Failed to apply code:', err)
    }
  }, [editedCode, excalidrawAPI, onChange])

  // Reset code to original
  const handleResetCode = useCallback(() => {
    setEditedCode(data)
    setHasChanges(false)
  }, [data])

  // Export as SVG
  const exportAsSvg = useCallback(async () => {
    if (!excalidrawAPI) return

    try {
      const elements = excalidrawAPI.getSceneElements()
      const appState = excalidrawAPI.getAppState()
      const files = excalidrawAPI.getFiles()

      const svg = await exportToSvg({
        elements,
        appState: {
          ...appState,
          exportWithDarkMode: false,
        },
        files,
      })

      const svgString = new XMLSerializer().serializeToString(svg)
      const blob = new Blob([svgString], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `diagram-${Date.now()}.svg`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export SVG:', err)
    }
  }, [excalidrawAPI])

  // Export as PNG
  const exportAsPng = useCallback(async () => {
    if (!excalidrawAPI) return

    try {
      const elements = excalidrawAPI.getSceneElements()
      const appState = excalidrawAPI.getAppState()
      const files = excalidrawAPI.getFiles()

      const blob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportWithDarkMode: false,
        },
        files,
        getDimensions: (width: number, height: number) => ({
          width: width * 2,
          height: height * 2,
          scale: 2,
        }),
      })

      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `diagram-${Date.now()}.png`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export PNG:', err)
    }
  }, [excalidrawAPI])

  // Export as source (.excalidraw file - JSON format)
  const exportAsSource = useCallback(() => {
    if (!excalidrawAPI) return

    try {
      const elements = excalidrawAPI.getSceneElements()
      const appState = excalidrawAPI.getAppState()
      const files = excalidrawAPI.getFiles()

      const exportData = {
        type: 'excalidraw',
        version: 2,
        source: 'https://excalidraw.com',
        elements,
        appState: {
          gridSize: appState.gridSize,
          viewBackgroundColor: appState.viewBackgroundColor,
        },
        files,
      }

      const jsonString = JSON.stringify(exportData, null, 2)
      const blob = new Blob([jsonString], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `diagram-${Date.now()}.excalidraw`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export source:', err)
    }
  }, [excalidrawAPI])

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    exportAsSvg,
    exportAsPng,
    exportAsSource,
    showSourceCode: () => setShowCodePanel(true),
    hideSourceCode: () => setShowCodePanel(false),
    toggleSourceCode: () => setShowCodePanel(prev => !prev),
  }), [exportAsSvg, exportAsPng, exportAsSource])

  // Handle changes from Excalidraw - use version tracking to prevent loops
  const handleChange = useCallback((
    elements: readonly ExcalidrawElementAny[],
  ) => {
    if (!elements) return

    const currentVersion = getSceneVersion(elements as ExcalidrawElementAny[])

    // Skip programmatic changes (from initialData updates)
    if (skipProgrammaticChangeRef.current) {
      skipProgrammaticChangeRef.current = false
      lastSceneVersionRef.current = currentVersion
      return
    }

    // Skip if version hasn't changed
    if (currentVersion === lastSceneVersionRef.current) {
      return
    }

    lastSceneVersionRef.current = currentVersion

    // Get the latest elements from the API if available
    const api = excalidrawAPIRef.current
    const sceneElements = api ? api.getSceneElements() : elements

    if (onChangeRef.current) {
      // Export elements directly - they already contain full binding information
      // Do NOT use convertToExcalidrawElements here as it would lose the bindings
      const exportData: ExcalidrawData = {
        elements: sceneElements as ExcalidrawElementAny[],
      }
      const emitted = JSON.stringify(exportData, null, 2)
      // 记住本组件发出的内容，用于让“外部数据更新”effect 识别并跳过自身回流
      lastEmittedDataRef.current = emitted
      onChangeRef.current(emitted)
    }
  }, [])

  if (error && data.trim()) {
    return (
      <div className={cn('flex h-full items-center justify-center p-4', className)}>
        <div className="max-w-md border border-red-300 bg-red-50 p-4">
          <p className="font-medium text-red-800">Invalid Excalidraw Data</p>
          <p className="mt-1 text-sm text-red-600">{error}</p>
        </div>
      </div>
    )
  }

  if (!initialData) {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <p className="text-muted">Loading...</p>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className={cn('excalidraw-wrapper relative h-full w-full', className)}>
        

        {/* Excalidraw Canvas */}
        <Excalidraw
          initialData={initialData}
          onChange={handleChange}
          excalidrawAPI={(api) => setExcalidrawAPI(api)}
          langCode="zh-CN"
          theme="light"
          UIOptions={{
            canvasActions: {
              loadScene: false,
              export: false,
              saveAsImage: false,
            },
          }}
        >
          {/* 自定义主菜单：移除“Find on canvas”(SearchMenu)、“帮助”(Help)、“Excalidraw links”(Socials) */}
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>

        {/* Code Panel */}
        {showCodePanel && (
          <div className="absolute bottom-4 right-4 z-10 w-96 max-h-[70%] flex flex-col overflow-hidden rounded-xl border border-[#e5e7eb] bg-surface shadow-lg select-text">
            {/* Panel Header */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Excalidraw 源码</span>
                {hasChanges && (
                  <span className="text-xs text-amber-500">• 未保存</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyCode}
                      className="h-7 w-7 rounded-lg border border-[#e5e7eb] p-0"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copied ? '已复制' : '复制代码'}</TooltipContent>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCodePanel(false)}
                  className="h-7 w-7 rounded-lg border border-[#e5e7eb] p-0"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {/* Code Editor */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Editor
                height="300px"
                defaultLanguage="json"
                value={editedCode}
                onChange={handleCodeChange}
                theme="vs"
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  automaticLayout: true,
                  tabSize: 2,
                  padding: { top: 8, bottom: 8 },
                  scrollbar: {
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                  },
                }}
              />
            </div>
            {/* Panel Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleResetCode}
                    disabled={!hasChanges}
                    className="gap-1.5 rounded-lg border border-[#e5e7eb]"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    <span className="text-xs">重置</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>重置为原始代码</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleApplyCode}
                    disabled={!hasChanges || !editedCode.trim()}
                    className="gap-1.5 rounded-lg border border-surface/30"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span className="text-xs">应用</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>应用代码更改</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
})

/**
 * Export Excalidraw canvas as thumbnail
 */
export async function exportExcalidrawThumbnail(
  api: ExcalidrawImperativeAPI
): Promise<string> {
  const elements = api.getSceneElements()
  const appState = api.getAppState()

  const blob = await exportToBlob({
    elements,
    appState: {
      ...appState,
      exportWithDarkMode: false,
    },
    files: null,
    getDimensions: () => ({ width: 300, height: 200, scale: 1 }),
  })

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
