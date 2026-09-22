// src/features/engines/drawio/DrawioEditor.tsx
// Self-hosted drawio 31.4.6 editor. Loads drawio bundles from /drawio/*
// (served by the same-origin Hono backend) directly into this page — no iframe.
// Captures the EditorUi instance via window.onDrawioAppReady (set up before
// bootstrap.js runs) and drives it via direct method calls.
//
// Imperative handle API preserved 1:1 from the previous react-drawio
// implementation so CanvasArea.tsx / EditorPage.tsx / useAIGenerate.ts need
// zero changes.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import Editor from '@monaco-editor/react'
import { Check, Copy, Play, Undo2, X } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/Tooltip'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { ensureMxfileWrapped } from '@/lib/drawioXml'

export interface DrawioEditorRef {
  load: (xml: string) => void
  exportDiagram: (format?: 'xmlsvg' | 'png' | 'svg') => void
  exportAsSvg: () => void
  exportAsPng: () => void
  exportAsSource: () => void
  showSourceCode: () => void
  hideSourceCode: () => void
  toggleSourceCode: () => void
  getThumbnail: () => Promise<string>
}

interface DrawioEditorProps {
  data: string // XML string (wrapped <mxfile> or bare <mxCell> fragments)
  onChange?: (data: string) => void
  className?: string
  darkMode?: boolean
  ui?: 'min' | 'sketch'
}

const CHANGE_DEBOUNCE_MS = 300
const THUMBNAIL_TIMEOUT_MS = 5000

// Mirror react-drawio's old `configuration.css` payload so the iframe-less
// editor gets the same chrome-hidden treatment.
const CHROME_HIDING_CSS = `
  .geFooterContainer, .geTabContainer, .geTabbedDiagram { display: none !important; }
  .geMenubarContainer { background: #fff !important; }
`

function downloadBlob(href: string, filename: string) {
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  if (href.startsWith('blob:')) {
    setTimeout(() => URL.revokeObjectURL(href), 100)
  }
}

// Global singleton holders — App.main can only run once per page (it has
// an internal isMainCalled guard). When the user switches drawio projects,
// React unmounts/remounts <DrawioEditor>; we need to reuse the existing
// EditorUi instance instead of trying to re-initialise drawio. We stash
// references on window so they survive React component lifecycles.
// EditorUi is an untyped drawio global; `any` is intentional.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface DrawioGlobalSlot {
  app: any | null
  changeHandler: ((xml: string) => void) | null
}
declare global {
  interface Window {
    __wedrawDrawio?: DrawioGlobalSlot
  }
}

export const DrawioEditor = forwardRef<DrawioEditorRef, DrawioEditorProps>(
  function DrawioEditor({ data, onChange, className, darkMode: _darkMode = false }, ref) {
    const containerHostRef = useRef<HTMLDivElement | null>(null)
    const changeTimerRef = useRef<number | null>(null)
    const baseElRef = useRef<HTMLBaseElement | null>(null)
    const styleElRef = useRef<HTMLStyleElement | null>(null)
    const mxScriptRef = useRef<HTMLScriptElement | null>(null)
    const bootstrapScriptRef = useRef<HTMLScriptElement | null>(null)

    const [isReady, setIsReady] = useState(false)
    const [showCodePanel, setShowCodePanel] = useState(false)
    const [copied, setCopied] = useState(false)
    const [editedCode, setEditedCode] = useState(data)
    const [hasChanges, setHasChanges] = useState(false)

    // Keep the Monaco panel in sync with the upstream `data` prop.
    useEffect(() => {
      setEditedCode(data)
      setHasChanges(false)
    }, [data])

    // Boot drawio scripts on mount.
    // Cleanup keeps the scripts + EditorUi alive across remounts (React 18
    // StrictMode would otherwise re-run the boot and trigger
    // "Class 'OrgChart.Annotations.CanBeNullAttribute' is already defined").
    // On full page unload everything is GC'd naturally.
    useEffect(() => {
      const slot: DrawioGlobalSlot = (window.__wedrawDrawio ??= {
        app: null,
        changeHandler: null,
      })
      const cancelled = { v: false }

      // 0) Set up MutationObserver BEFORE drawio loads to catch all body additions
      const hostDiv = containerHostRef.current
      if (hostDiv) {
        const drawioClasses = [
          'geMenubarContainer',
          'geToolbarContainer',
          'geSidebarContainer',
          'geFormatContainer',
          'geDiagramContainer',
          'geTabContainer',
          'geHsplit',
          'geSpriteBackground',
          'geSidebarTooltip',
        ]

        const moveToHost = () => {
          if (!hostDiv || cancelled.v) return
          drawioClasses.forEach((cls) => {
            document.querySelectorAll('.' + cls).forEach((el) => {
              if (el.parentElement === document.body) {
                hostDiv.appendChild(el)
              }
            })
          })
        }

        // Observe immediately
        const observer = new MutationObserver(() => {
          if (!cancelled.v) {
            setTimeout(moveToHost, 0)
          }
        })
        observer.observe(document.body, { childList: true })
        ;(hostDiv as any).__drawioObserver = observer
      }

      // 1) Inject <base href="/drawio/"> so drawio's relative paths
      //    (mxUtils.load('styles/default.xml'), <img src="mxgraph/images/foo.png">)
      //    resolve against our backend.
      if (!document.getElementById('drawio-base')) {
        const base = document.createElement('base')
        base.id = 'drawio-base'
        base.href = '/drawio/'
        document.head.prepend(base)
        baseElRef.current = base
      }

      // 2) Inject user CSS to hide footer/tab chrome.
      if (!document.getElementById('drawio-chrome-style')) {
        const style = document.createElement('style')
        style.id = 'drawio-chrome-style'
        style.textContent = CHROME_HIDING_CSS
        document.head.appendChild(style)
        styleElRef.current = style
      }

      // 2b) Inject drawio's grapheditor.css. drawio's bundled CSS uses
      //     `.geEditor>.geMenubarContainer { position: absolute; ... }`
      //     selectors — without this stylesheet the menubar/toolbar/sidebar
      //     default to position:static and pile up at the bottom of the
      //     container (or below it) instead of overlaying the graph.
      //     In drawio's own index.html this is loaded via a static <link>;
      //     we inject it imperatively because we don't use index.html.
      //     Editor.loadCompatibleCss() only loads it on legacy browsers
      //     without lightDarkColorSupported, so we must do it ourselves.
      if (!document.getElementById('drawio-grapheditor-css')) {
        const cssLink = document.createElement('link')
        cssLink.id = 'drawio-grapheditor-css'
        cssLink.rel = 'stylesheet'
        cssLink.type = 'text/css'
        cssLink.href = '/drawio/styles/grapheditor.css'
        document.head.appendChild(cssLink)
      }

      // 3) Fast path: drawio already booted on this page (StrictMode second
      //    pass, or user switched projects). Reuse the existing EditorUi.
      if (slot.app) {
        // Wire onChange into the existing listener (re-attached in step 5).
        slot.changeHandler = (xml: string) => onChange?.(xml)
        setIsReady(true)
        return () => {
          cancelled.v = true
          // Do NOT remove scripts / <base> / <style>: they must survive
          // remounts so the next mount can reuse the EditorUi. Real cleanup
          // happens on full page reload.
        }
      }

      // 4) Slow path: first boot on this page. Define ready callback BEFORE
      //    bootstrap.js runs. Patched bootstrap.js calls
      //    App.main(window.onDrawioAppReady, window.wedrawCreateAppUi) after
      //    app.min.js + mxClient.js finish loading. `wedrawCreateAppUi` is
      //    the createUi factory that returns an App constructed with OUR
      //    container div instead of document.body — otherwise drawio's
      //    toolbar/sidebar/graph overflow the page and cover the React chat.
       
      const AppCtor: any = (window as any).App
      if (AppCtor && hostDiv) {
         
        const EditorCtor: any = (window as any).Editor
         
        window.wedrawCreateAppUi = function (): any {
          // chromeless=true hides the menubar; uiTheme='min' minimises chrome
          return new AppCtor(
            new EditorCtor(true, null, null, null, false),
            hostDiv,
            true,
          )
        }
      }
      window.onDrawioAppReady = (ui) => {
        if (cancelled.v) return

        const drawioUi: any = ui
        slot.app = drawioUi

        const fireChange = () => {
          if (changeTimerRef.current != null) {
            clearTimeout(changeTimerRef.current)
          }
          changeTimerRef.current = window.setTimeout(() => {
            changeTimerRef.current = null
            try {
              const node = drawioUi.getXmlFileData(true, false, true, false)
              const xml = window.mxUtils.getXml(node)
              slot.changeHandler?.(xml)
            } catch (e) {
              console.error('[DrawioEditor] getXmlFileData failed', e)
            }
          }, CHANGE_DEBOUNCE_MS)
        }
        drawioUi.editor.graph.model.addListener(window.mxEvent.CHANGE, fireChange)

        // Mirror the React-side darkMode preference onto the drawio body.
        document.body.classList.toggle('geDarkMode', !!_darkMode)

        slot.changeHandler = (xml: string) => onChange?.(xml)

        setIsReady(true)
      }

      // 5) Load mxgraph base first, then bootstrap.js. Both deferred so
      //    execution order matches document insertion order.
      if (!document.querySelector('script[data-wedraw="mxclient"]')) {
        const mxScript = document.createElement('script')
        mxScript.src = '/drawio/mxgraph/mxClient.js'
        mxScript.defer = true
        mxScript.setAttribute('data-wedraw', 'mxclient')
        document.head.appendChild(mxScript)
        mxScriptRef.current = mxScript
      }

      if (!document.querySelector('script[data-wedraw="bootstrap"]')) {
        const bootstrap = document.createElement('script')
        bootstrap.src = '/drawio/js/bootstrap.js'
        bootstrap.defer = true
        bootstrap.setAttribute('data-wedraw', 'bootstrap')
        document.head.appendChild(bootstrap)
        bootstrapScriptRef.current = bootstrap
      }

      return () => {
        cancelled.v = true
        // Keep <base>, <style>, and <script>s alive across remounts.
        // On full page reload everything is GC'd naturally.
      }
      // onChange is captured via the slot.changeHandler indirection above,
      // so each remount wires its own callback without re-registering
      // drawio listeners.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Apply `data` prop changes once drawio is ready.
    useEffect(() => {
      const ui = window.__wedrawDrawio?.app
      if (!isReady || !ui || !data) return
      try {
        ui.setFileData(ensureMxfileWrapped(data))
        ui.editor.setModified(false)
      } catch (e) {
        console.error('[DrawioEditor] setFileData failed', e)
      }
    }, [data, isReady])

    // ---------- Imperative API ----------

    const getThumbnail = useCallback((): Promise<string> => {
      return new Promise((resolve) => {
        const ui = window.__wedrawDrawio?.app ?? null
        if (!ui || !isReady) {
          resolve('')
          return
        }
        let settled = false
        const finish = (val: string) => {
          if (!settled) {
            settled = true
            resolve(val)
          }
        }
        const timeout = window.setTimeout(() => {
          console.warn('[DrawioEditor] getThumbnail timeout')
          finish('')
        }, THUMBNAIL_TIMEOUT_MS)
        try {
          ui.editor.exportToCanvas(
            (canvas: HTMLCanvasElement) => {
              window.clearTimeout(timeout)
              try {
                finish(canvas.toDataURL('image/png'))
              } catch (e) {
                console.error('[DrawioEditor] toDataURL failed', e)
                finish('')
              }
            },
            800, // width px
            null, // imageCache
            null, // background
            (err: unknown) => {
              window.clearTimeout(timeout)
              console.error('[DrawioEditor] exportToCanvas error', err)
              finish('')
            },
          )
        } catch (e) {
          window.clearTimeout(timeout)
          console.error('[DrawioEditor] exportToCanvas threw', e)
          finish('')
        }
      })
    }, [isReady])

    const exportAsPng = useCallback(() => {
      const ui = window.__wedrawDrawio?.app ?? null
      if (!ui) return
      try {
        ui.editor.exportToCanvas(
          (canvas: HTMLCanvasElement) => {
            downloadBlob(
              canvas.toDataURL('image/png'),
              `diagram-${Date.now()}.png`,
            )
          },
          null, null, null,
          (err: unknown) => console.error('[DrawioEditor] PNG export failed', err),
        )
      } catch (e) {
        console.error('[DrawioEditor] exportAsPng threw', e)
      }
    }, [])

    const exportAsSvg = useCallback(() => {
      const ui = window.__wedrawDrawio?.app ?? null
      if (!ui) return
      try {
        ui.exportSvg(
          1,    // scale
          false, // transparentBackground
          true,  // ignoreSelection
          false, // addShadow
          false, // editable
          true,  // embedImages
          0,     // border
          false, // noCrop
          true,  // currentPage
          null,  // linkTarget
          null,  // theme
          null,  // exportType
          false, // embedFonts
          (svg: string) => {
            const blob = new Blob([svg], { type: 'image/svg+xml' })
            const href = URL.createObjectURL(blob)
            downloadBlob(href, `diagram-${Date.now()}.svg`)
          },
        )
      } catch (e) {
        console.error('[DrawioEditor] exportAsSvg threw', e)
      }
    }, [])

    const exportAsSource = useCallback(() => {
      if (!data) return
      const blob = new Blob([data], { type: 'application/xml' })
      const href = URL.createObjectURL(blob)
      downloadBlob(href, `diagram-${Date.now()}.drawio`)
    }, [data])

    useImperativeHandle(
      ref,
      () => ({
        load: (xml: string) => {
          const ui = window.__wedrawDrawio?.app ?? null
          if (!ui) return
          try {
            ui.setFileData(ensureMxfileWrapped(xml))
            ui.editor.setModified(false)
          } catch (e) {
            console.error('[DrawioEditor] load failed', e)
          }
        },
        // Back-compat shim: the old react-drawio exportDiagram('xmlsvg') used
        // to call convert.diagrams.net — we no longer have that endpoint, so
        // route to PNG. svg/svg routes to exportAsSvg.
        exportDiagram: (format: 'xmlsvg' | 'png' | 'svg' = 'xmlsvg') => {
          if (format === 'svg') exportAsSvg()
          else exportAsPng()
        },
        exportAsSvg,
        exportAsPng,
        exportAsSource,
        showSourceCode: () => setShowCodePanel(true),
        hideSourceCode: () => setShowCodePanel(false),
        toggleSourceCode: () => setShowCodePanel(prev => !prev),
        getThumbnail,
      }),
      [exportAsSvg, exportAsPng, exportAsSource, getThumbnail],
    )

    // ---------- Code panel handlers ----------

    const handleCopyCode = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(editedCode)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch (err) {
        console.error('Failed to copy code:', err)
      }
    }, [editedCode])

    const handleCodeChange = useCallback(
      (value: string | undefined) => {
        const newCode = value || ''
        setEditedCode(newCode)
        setHasChanges(newCode !== data)
      },
      [data],
    )

    const handleApplyCode = useCallback(() => {
      if (!editedCode.trim() || editedCode === data) return
      const ui = window.__wedrawDrawio?.app ?? null
      try {
        ui?.setFileData(ensureMxfileWrapped(editedCode))
      } catch (e) {
        console.error('[DrawioEditor] apply code failed', e)
      }
      onChange?.(editedCode)
      setHasChanges(false)
    }, [editedCode, data, onChange])

    const handleResetCode = useCallback(() => {
      setEditedCode(data)
      setHasChanges(false)
    }, [data])

    return (
      <TooltipProvider>
        <div
          ref={containerHostRef}
          id="drawio-host"
          className={cn(
            // `geEditor` is required so drawio's CSS (`.geEditor > .geMenubarContainer
            // { position: absolute; ... }`) actually positions the toolbar/sidebar
            // /diagram absolutely inside this container. Without it they default to
            // static and fall to the bottom.
            'geEditor relative h-full min-h-0 w-full overflow-hidden',
            className,
          )}
        >
          {/* drawio mounts itself into this div via App.main's createUi factory */}
          {!isReady && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <div className="text-center">
                <div className="mb-2 h-8 w-8 animate-spin rounded-full border-2 border-primary border-r-transparent mx-auto" />
                <p className="text-sm text-muted">Loading Draw.io...</p>
              </div>
            </div>
          )}

          {showCodePanel && (
            <div className="absolute bottom-4 right-4 z-10 w-96 max-h-[70%] flex flex-col border border-border bg-surface shadow-lg">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Draw.io XML 源码</span>
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
                        className="h-7 w-7 p-0"
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
                    className="h-7 w-7 p-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <Editor
                  height="300px"
                  defaultLanguage="xml"
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
              <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleResetCode}
                      disabled={!hasChanges}
                      className="gap-1.5"
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
                      className="gap-1.5"
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
  },
)
