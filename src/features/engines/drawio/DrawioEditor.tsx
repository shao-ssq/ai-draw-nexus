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
import { Check, Circle, Copy, Diamond, MoveRight, Play, Redo2, RotateCcw, Shapes, Square, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
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
  /* Hide top-right buttons: 全屏, 折叠/展开 */
  .geButton[title="全屏"], .geButton[title="折叠 / 展开"] { display: none !important; }
  /* 工具栏"格式"开关（Ctrl+Shift+P）：样式已改为浮动面板随选中自动显隐，
     该按钮既冗余又会按旧逻辑切换 grid 占位宽度，直接隐藏 */
  .geButton[title="格式 (Ctrl+Shift+P)"] { display: none !important; }
  /* 顶部工具栏整体移除 —— 形状按钮改为左侧竖排悬浮条。
     工具栏是 grid 第 2 行（38px），display:none 后该行塌缩，画布自动上移填满 */
  #drawio-host > .geToolbarContainer { display: none !important; }
  /* 绘图面板（左侧形状栏 + 分隔条）默认隐藏。grid 列是 min-content，
     隐藏后画布自动占满宽度；点击浮动按钮切换 host 上的类名。 */
  #drawio-host.wedraw-sidebar-hidden > .geSidebarContainer:not(.geFormatContainer),
  #drawio-host.wedraw-sidebar-hidden > .geHsplit { display: none !important; }
  /* 浮动样式面板：选中画布元素时弹出，点击空白处隐藏 */
  #floating-format-panel {
    background: light-dark(#f8f9fa, var(--ge-dark-panel-color, #2b2b2b));
    border: 1px solid light-dark(#e5e7eb, #444);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    scrollbar-gutter: stable;
  }
  #floating-format-panel > .geFormatContainer { border-left: none !important; }
  /* 隐藏样式面板底部的"属性/值"栏目：表格是 table.geProperties，
     其所在 .geFormatSection 自带 border-top，整段隐藏避免留下一条孤立横线 */
  #floating-format-panel .geFormatSection:has(table.geProperties) { display: none !important; }
  #floating-format-panel table.geProperties { display: none !important; }

  /* ====== 修复画板偏移 & 滚动条 ======
     drawio 自带的 grapheditor.css 在 .geEditor > .geDiagramContainer 上硬编码
     margin-left: -10px —— 这是给 sidebar 留的视觉补偿。我们默认隐藏 sidebar，
     这个 -10px 会让画板向左偏，露出右侧一条 10px 的浅色条带（geEditor 的
     panel-color），看上去就像多出来的滚动条/空白。强制清零。 */
  #drawio-host > .geDiagramContainer { margin-left: 0 !important; }

  /* geEditor 用 display:grid + position:absolute，宽高 100%。父容器一旦
     flex 高度变化（例如 chat 面板展开），min-content 行可能撑出可见滚动条。
     强制让网格布局完全继承父容器尺寸，禁止任何方向溢出。 */
  #drawio-host.geEditor {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    overflow: hidden !important;
    max-width: 100vw !important;
  }

  /* drawio 在 .geEditor 下挂了一个 hidden SVG（position:absolute,
     margin:-9999px, z-index:-1）用来做 sprite 离屏渲染。直接子 svg 都是这种
     隐藏用途 —— 不要修改它的 left/top/margin，否则会把它拉回屏幕并撑出滚动条。
     这里只确保它的尺寸不超父容器，保留 drawio 的隐藏策略。 */
  #drawio-host > svg {
    max-width: 100% !important;
    max-height: 100% !important;
  }

  /* drawio 的 .geToolbarContainer / .geMenubarContainer / .geFormatContainer 等
     grid 子项在 flex 子元素 height:100% 中可能因为 content-box 高度溢出。
     用 box-sizing:border-box 锁定尺寸，配合 overflow:hidden 截断内容。
     min-width:0 是关键 —— flex/grid item 默认 min-width:auto，
     会让长内容（如 drawio 的 filename / <select> 控件）撑出最小尺寸触发滚动条。 */
  #drawio-host > .geMenubarContainer,
  #drawio-host > .geToolbarContainer,
  #drawio-host > .geDiagramContainer,
  #drawio-host > .geSidebarContainer,
  #drawio-host > .geHsplit,
  #drawio-host > .geTabContainer {
    box-sizing: border-box !important;
    max-width: 100% !important;
    min-width: 0 !important;
    overflow: hidden !important;
  }

  /* drawio 的 menubar 里有 filename（可能很长）以及带 select 的工具栏。
     这些容器内部的 inline 元素默认 min-width:auto 会撑出宽度。
     强制限制所有子元素的最大宽度，并截断文本溢出。 */
  #drawio-host .geMenubarContainer *,
  #drawio-host .geToolbarContainer * {
    max-width: 100% !important;
  }
  #drawio-host .geFilename {
    max-width: 100% !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }

  /* drawio 的 toolbar 右侧可能挂一个宽度 240px 的 geFormatContainer
     即便 display:none 也参与 layout。强制彻底移除。 */
  #drawio-host > .geSidebarContainer.geFormatContainer {
    display: none !important;
    width: 0 !important;
    min-width: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
  }

  /* 浮动样式面板内部使用 overflow-y:auto 的 .geFormatContainer，
     但其内部还有不少没有滚动条的子元素（geFormatTitleContainer 等）。
     限制其最大尺寸，避免内部子元素（如 mxWindow）撑出。 */
  #floating-format-panel .geFormatContainer {
    max-width: 100% !important;
    overflow-x: hidden !important;
  }
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
  zoomHandler: ((percent: number) => void) | null
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
    const pendingInternalDataRef = useRef<string | null>(null)
    const baseElRef = useRef<HTMLBaseElement | null>(null)
    const styleElRef = useRef<HTMLStyleElement | null>(null)
    const mxScriptRef = useRef<HTMLScriptElement | null>(null)
    const bootstrapScriptRef = useRef<HTMLScriptElement | null>(null)

    const [isReady, setIsReady] = useState(false)
    const [showCodePanel, setShowCodePanel] = useState(false)
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const [zoomPercent, setZoomPercent] = useState(100)
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
        zoomHandler: null,
      })
      const cancelled = { v: false }
      // 缩放百分比通过 slot 回传（view SCALE 监听在 initializeCanvas 中只挂一次，
      // 跨 remount 复用 EditorUi 时仍能把最新缩放值路由到当前挂载的组件）
      slot.zoomHandler = (p: number) => setZoomPercent(p)

      // 屏蔽 Ctrl+S：drawio 自带的保存（弹下载/对话框）与 WeDraw 的 IndexedDB
      // 自动保存冲突，capture 阶段拦截，先于 drawio 的 document 级按键监听触发
      const swallowCtrlS = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
      window.addEventListener('keydown', swallowCtrlS, true)

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
        const scale = slot.app.editor?.graph?.view?.scale
        if (typeof scale === 'number') setZoomPercent(Math.round(scale * 100))
        setIsReady(true)
        return () => {
          cancelled.v = true
          window.removeEventListener('keydown', swallowCtrlS, true)
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

        // Function to clear content and set zoom to 100% + center view
        const initializeCanvas = () => {
          try {
            const graph = drawioUi.editor?.graph
            if (!graph) return false

            // Expose a debug helper so users can call window.__wedrawDrawioDebug()
            // in DevTools to find which element produces scrollbars.
            ;(window as any).__wedrawDrawioDebug = () => {
              const hostEl = document.getElementById('drawio-host')
              const vw = window.innerWidth
              const vh = window.innerHeight
              const dump = (el: Element) => {
                const r = el.getBoundingClientRect()
                const cs = getComputedStyle(el)
                return {
                  tag: el.tagName,
                  cls: ((el as HTMLElement).className || '')
                    .toString()
                    .slice(0, 80),
                  id: el.id,
                  rect: {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                  },
                  scroll: { sw: el.scrollWidth, sh: el.scrollHeight },
                  client: { cw: el.clientWidth, ch: el.clientHeight },
                  css: {
                    overflow: cs.overflow,
                    overflowX: cs.overflowX,
                    overflowY: cs.overflowY,
                    position: cs.position,
                    height: cs.height,
                  },
                }
              }
              const offenders = Array.from(
                document.querySelectorAll('*'),
              ).filter((el) => {
                const r = el.getBoundingClientRect()
                return (
                  r.right > vw + 1 ||
                  r.bottom > vh + 1 ||
                  r.left < -1 ||
                  r.top < -1
                )
              })
              const report = {
                viewport: { vw, vh },
                hostChain: (() => {
                  const chain: Element[] = []
                  let cur: Element | null = hostEl
                  while (cur && chain.length < 10) {
                    chain.push(cur)
                    cur = cur.parentElement
                  }
                  return chain.map(dump)
                })(),
                drawioContainers: [
                  'geMenubarContainer',
                  'geToolbarContainer',
                  'geSidebarContainer',
                  'geFormatContainer',
                  'geDiagramContainer',
                  'geHsplit',
                  'geTabContainer',
                ]
                  .map((c) => {
                    const el = document.querySelector('.' + c)
                    return el ? { name: c, ...dump(el) } : { name: c, missing: true }
                  }),
                offenders: offenders.slice(0, 30).map(dump),
              }
              console.log('[Drawio debug]', report)
              return report
            }

            const model = graph.getModel()
            const root = model.root

            // Delete all default cells (pages) except root
            model.beginUpdate()
            try {
              const pageCount = model.getChildCount(root)
              for (let i = pageCount - 1; i >= 0; i--) {
                const page = model.getChildAt(root, i)
                if (page && model.isVertex(page)) {
                  model.remove(page)
                }
              }
            } finally {
              model.endUpdate()
            }

            // 保证 root 下有一个 layer（非 vertex 单元）作为默认父节点。
            // 不能 insertVertex 充当页面 —— 那会渲染出一个可见矩形。
            if (model.getChildCount(root) === 0) {
              const layer = new window.mxCell(null, new window.mxGeometry(), null)
              model.add(root, layer, 0)
            }

            // Zoom to 100%
            graph.zoomActual()
            graph.centerZoom = false

            // Use zoomTo to ensure 100%
            if (typeof graph.zoomTo === 'function') {
              graph.zoomTo(1, false)
            }

            // 监听缩放变化，把百分比回传给 React（左下角悬浮缩放条显示用）
            const updateZoom = () => {
              slot.zoomHandler?.(Math.round(graph.view.scale * 100))
            }
            // initializeCanvas 有重试逻辑，防止重复挂监听
            if (!graph.view.__wedrawZoomListener) {
              graph.view.__wedrawZoomListener = true
              graph.view.addListener(window.mxEvent.SCALE, updateZoom)
            }
            updateZoom()

            // Keep page view disabled by default and synchronize the menu state.
            drawioUi.setPageVisible(false)

            // 隐藏 grid 中右侧格式容器的占位（min-content 列自动塌缩，画布占满）
            const formatContainer = drawioUi.formatContainer
            if (formatContainer) {
              formatContainer.style.display = 'none'
            }

            // 把真实格式面板（样式）搬进浮动面板：选中元素时弹出，点击空白处隐藏。
            // 必须移动真实节点 —— cloneNode 不会复制事件监听，克隆出来的面板
            // 控件全是死的。format.container 就是 formatContainer 本身。
            const diagramContainer = graph.container?.parentElement
            if (formatContainer && diagramContainer) {
              const floatingPanel = document.createElement('div')
              floatingPanel.id = 'floating-format-panel'
              // 上下居中于画布，并整体上移 16px；底部预留 40px 间距
              floatingPanel.style.cssText =
                'position:absolute;right:10px;top:50%;transform:translateY(calc(-50% - 16px));width:240px;z-index:1000;max-height:calc(100% - 30px);display:none;'
              diagramContainer.appendChild(floatingPanel)
              floatingPanel.appendChild(formatContainer)
              formatContainer.style.width = '240px'
              formatContainer.style.boxSizing = 'border-box'
              // 滚动区底部留白，避免最后一行（如"属性/值"）紧贴面板边框
              formatContainer.style.paddingBottom = '12px'

              const syncFormatPanel = () => {
                const show = graph.getSelectionCount() > 0
                floatingPanel.style.display = show ? 'block' : 'none'
                formatContainer.style.display = show ? 'block' : 'none'
                if (show) {
                  // % 对 auto 高度的父级不生效，按画布实际高度动态计算内层滚动区高度，
                  // 比外层 max-height 再少 10px，保证底部边距可见
                  formatContainer.style.maxHeight = `${diagramContainer.clientHeight - 40}px`
                }
              }
              // 点击空白处会清空 selection，点击元素会选中 —— 一个监听全覆盖
              graph
                .getSelectionModel()
                .addListener(window.mxEvent.CHANGE, syncFormatPanel)
              syncFormatPanel()
            }

            // Refresh UI
            graph.refresh?.()
            drawioUi?.editor?.refresh?.()

            return true
          } catch (e) {
            console.error('[DrawioEditor] Failed to initialize canvas:', e)
            return false
          }
        }

        // Try immediately, then retry a few times to handle async loading
        let attempts = 0
        const tryInit = () => {
          attempts++
          if (initializeCanvas()) {
            console.log('[DrawioEditor] Canvas initialized successfully')
          } else if (attempts < 5) {
            setTimeout(tryInit, 200)
          }
        }
        setTimeout(tryInit, 100)

        const fireChange = () => {
          if (changeTimerRef.current != null) {
            clearTimeout(changeTimerRef.current)
          }
          changeTimerRef.current = window.setTimeout(() => {
            changeTimerRef.current = null
            try {
              const node = drawioUi.getXmlFileData(true, false, true, false)
              const xml = window.mxUtils.getXml(node)
              pendingInternalDataRef.current = xml
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
        window.removeEventListener('keydown', swallowCtrlS, true)
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

      if (pendingInternalDataRef.current === data) {
        pendingInternalDataRef.current = null
        ui.setPageVisible(false)
        return
      }

      try {
        ui.setFileData(ensureMxfileWrapped(data))
        ui.setPageVisible(false)
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
            ui.setPageVisible(false)
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

    // ---------- Zoom controls ----------

    const getGraph = useCallback((): any => {
      return window.__wedrawDrawio?.app?.editor?.graph ?? null
    }, [])

    const handleZoomIn = useCallback(() => {
      getGraph()?.zoomIn()
    }, [getGraph])

    const handleZoomOut = useCallback(() => {
      getGraph()?.zoomOut()
    }, [getGraph])

    const handleZoomReset = useCallback(() => {
      getGraph()?.zoomActual()
    }, [getGraph])

    const handleUndo = useCallback(() => {
      window.__wedrawDrawio?.app?.undo()
    }, [])

    const handleRedo = useCallback(() => {
      window.__wedrawDrawio?.app?.redo()
    }, [])

    // ---------- Shape insertion ----------

    const insertShape = useCallback(
      (kind: 'rect' | 'ellipse' | 'rhombus' | 'edge') => {
        const graph = getGraph()
        if (!graph) return
        const parent = graph.getDefaultParent()
        // 插入到当前视口中心
        const pt =
          typeof graph.getCenterInsertPoint === 'function'
            ? graph.getCenterInsertPoint()
            : { x: 60, y: 60 }
        const model = graph.getModel()
        let inserted: any = null
        model.beginUpdate()
        try {
          if (kind === 'edge') {
            // 无端点连线：手工指定两个端点，画一条可见的正交连接线
            inserted = graph.insertEdge(
              parent, null, '', null, null,
              'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;',
            )
            inserted.geometry.setTerminalPoint(
              new window.mxPoint(pt.x - 80, pt.y), true,
            )
            inserted.geometry.setTerminalPoint(
              new window.mxPoint(pt.x + 80, pt.y), false,
            )
            inserted.geometry.relative = true
          } else {
            const style =
              kind === 'ellipse'
                ? 'ellipse;whiteSpace=wrap;html=1;'
                : kind === 'rhombus'
                  ? 'rhombus;whiteSpace=wrap;html=1;'
                  : 'rounded=0;whiteSpace=wrap;html=1;'
            const w = kind === 'rect' ? 120 : 80
            const h = kind === 'rect' ? 60 : 80
            inserted = graph.insertVertex(
              parent, null, '', pt.x - w / 2, pt.y - h / 2, w, h, style,
            )
          }
        } finally {
          model.endUpdate()
        }
        // 选中新插入的元素（同时触发右侧浮动样式面板）
        if (inserted) graph.setSelectionCell(inserted)
      },
      [getGraph],
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
        ui?.setPageVisible(false)
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
            // 绘图面板默认隐藏（见 CHROME_HIDING_CSS 中的 .wedraw-sidebar-hidden 规则）
            !sidebarOpen && 'wedraw-sidebar-hidden',
            className,
          )}
        >
          {/* 绘图面板（左侧形状栏）开关，放在画布左上角 */}
          {isReady && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSidebarOpen((v) => !v)}
                  className={cn(
                    'absolute left-3 top-3 z-20 h-9 w-9 rounded-lg border border-border/50 bg-surface/90 p-0 text-muted shadow-md backdrop-blur-md hover:bg-black/5 hover:text-primary',
                    sidebarOpen && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                  )}
                >
                  <Shapes className="h-[18px] w-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{sidebarOpen ? '隐藏绘图面板' : '显示绘图面板'}</TooltipContent>
            </Tooltip>
          )}
          {/* drawio mounts itself into this div via App.main's createUi factory */}
          {/* 形状工具条 - 左侧竖排悬浮（替换原生顶部工具栏，样式对齐 Mermaid） */}
          {isReady && (
            <div className="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border border-border/50 bg-surface/90 p-1 shadow-md backdrop-blur-md">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={() => insertShape('rect')} className="h-8 w-8 rounded-lg p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <Square className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>矩形</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={() => insertShape('ellipse')} className="h-8 w-8 rounded-lg p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <Circle className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>圆形</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={() => insertShape('rhombus')} className="h-8 w-8 rounded-lg p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <Diamond className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>菱形</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={() => insertShape('edge')} className="h-8 w-8 rounded-lg p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <MoveRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>连接线</TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* 缩放/撤销/重做控制 - 左下角悬浮（样式对齐 Mermaid 引擎） */}
          {isReady && (
            <div className="absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-lg border border-border/50 bg-surface/90 px-1 py-1 shadow-md backdrop-blur-md">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleZoomOut} className="h-7 w-7 rounded-md p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>缩小</TooltipContent>
              </Tooltip>

              <span className="min-w-[2.5rem] text-center text-[11px] text-muted">
                {zoomPercent}%
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleZoomIn} className="h-7 w-7 rounded-md p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>放大</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleZoomReset} className="h-7 w-7 rounded-md p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>重置视图</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleUndo} className="h-7 w-7 rounded-md p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <Undo2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>撤销 (Ctrl+Z)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleRedo} className="h-7 w-7 rounded-md p-0 text-muted hover:bg-black/5 hover:text-primary">
                    <Redo2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>重做 (Ctrl+Y)</TooltipContent>
              </Tooltip>
            </div>
          )}

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
