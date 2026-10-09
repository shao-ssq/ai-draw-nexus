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
import { Check, Circle, Copy, Diamond, MoveRight, Play, Redo2, Shapes, Square, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
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

  /* ====== 左侧绘图面板（形状库）改为浮动卡片 ======
     参考点击图形弹出的 #floating-format-panel：圆角 + 边框 + 投影 + 毛玻璃底色。
     位置放在左侧悬浮工具条右边（工具条 left-3=12px + 宽 36px + 间距 6px），
     上下留出边距。position:absolute 使其脱离 grid 流，画布始终占满宽度。 */
  #drawio-host > .geSidebarContainer:not(.geFormatContainer) {
    position: absolute !important;
    left: 54px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    height: 70% !important;
    width: 320px !important;
    min-width: 0 !important;
    margin: 0 !important;
    border: 1px solid light-dark(#e5e7eb, #444) !important;
    border-radius: 12px;
    background: light-dark(#f8f9fa, var(--ge-dark-panel-color, #2b2b2b)) !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    overflow-x: hidden !important;
    overflow-y: auto !important;
    padding: 8px !important;
    z-index: 15;
  }
  /* 分隔条始终隐藏：sidebar 浮动后没有可拖拽的分栏意义，
     且 grid min-content 列会让它留在左边缘碍事 */
  #drawio-host > .geHsplit { display: none !important; }

  /* 隐藏"所有图形"面板顶部的搜索框 —— 搜索条目已从 sidebar.entries 移除，
     留着一个不能用的搜索框只会占高度 */
  #drawio-host .geSearchSidebar { display: none !important; }

  /* ====== "所有图形"浮动面板内部美化 ======
     drawio 默认样式偏厚重（13px 黑色分区标题、44px 高亮主色底栏、默认滚动条），
     这里统一收窄、弱化，与左侧悬浮工具条的视觉密度对齐。 */
  /* 图形区分区标题（基本/箭头/流程图…）：小字号 + 弱化颜色 + 图标缩小 + 悬停底 */
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geTitle {
    font-size: 11px !important;
    font-weight: 600;
    color: light-dark(#6b7280, #9ca3af);
    background-size: 14px !important;
    background-position: 6px 50% !important;
    padding: 5px 6px 5px 24px !important;
    margin: 2px !important;
    border-radius: 6px;
  }
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geTitle:hover {
    background-color: light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.06));
    color: light-dark(#374151, #d1d5db);
  }
  /* 图形项：去掉默认 0.75 透明度，悬停放大 + 底色高亮 */
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geSidebar .geItem {
    opacity: 1;
    border-radius: 6px;
  }
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geSidebar .geItem:hover {
    background: light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.08));
    transform: scale(1.06);
  }
  /* 内边距收紧，底部多留滚动余量 —— "+更多图形"底栏是绝对定位悬浮在
     面板底部的，内容滚到底部时要让出它的 40px 高度 */
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geSidebar {
    padding: 2px 4px 44px !important;
  }
  /* "+更多图形"底栏：从 44px 高亮主色按钮改为低调的幽灵条 */
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geSidebarFooter {
    height: 40px;
    padding: 6px 10px 4px;
    box-sizing: border-box;
  }
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geSidebarFooter .geBtn {
    width: 100%;
    height: 28px;
    border-radius: 8px;
    font-size: 12px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06)) !important;
    color: light-dark(#6b7280, #9ca3af);
  }
  #drawio-host .geSidebarContainer:not(.geFormatContainer) .geSidebarFooter .geBtn:hover {
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1)) !important;
    color: light-dark(#374151, #d1d5db);
  }
  /* 细圆角滚动条 */
  #drawio-host .geSidebarContainer:not(.geFormatContainer)::-webkit-scrollbar { width: 6px; }
  #drawio-host .geSidebarContainer:not(.geFormatContainer)::-webkit-scrollbar-track { background: transparent; }
  #drawio-host .geSidebarContainer:not(.geFormatContainer)::-webkit-scrollbar-thumb {
    background: light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 3px;
  }

  /* 浮动样式面板内部使用 overflow-y:auto 的 .geFormatContainer，
     但其内部还有不少没有滚动条的子元素（geFormatTitleContainer 等）。
     限制其最大尺寸，避免内部子元素（如 mxWindow）撑出。 */
  #floating-format-panel .geFormatContainer {
    max-width: 100% !important;
    overflow-x: hidden !important;
  }

  /* ====== 浮动控件条内的 React 按钮 ======
     grapheditor.css 有一条 :where(.geEditor button) { border: 1px solid; padding: 2px }
     的兜底规则 —— 所有挂在 #drawio-host（带 geEditor 类）里的 <button> 都会被
     加上边框。Mermaid 引擎的容器没有这个类，所以同样的 Button 组件在 Mermaid
     下无边框。这里只清除边框和内边距，不碰 background —— :where() 特异性为 0，
     悬停时 Tailwind 的 hover:bg-border（ghost 按钮自带）自然生效，与 Mermaid 一致。 */
  #drawio-host .wedraw-float-bar button {
    border: none !important;
    padding: 0 !important;
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

            // 空白处左键拖拽 = 平移画布（替代默认的框选），与 Mermaid 引擎交互一致。
            // panning 默认已启用（Graph 构造时 setPanning(true)），这里只把左键
            // 交给平移；拖拽落在元素上时仍是移动元素，不受影响。
            if (graph.panningHandler) {
              graph.panningHandler.useLeftButtonForPanning = true
            }

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

            // 从"所有图形"面板和"+更多图形"对话框中移除"搜索"与"便签本"：
            // 对话框（MoreShapesDialog）直接渲染 sidebar.entries 的分区数据，
            // 按 id 过滤这份数组即可两处同步移除；便签本在启动时会被异步自动
            // 加载（toggleScratchpad），closeLibrary 关掉它的图形库面板。
            // 操作幂等，立即执行一次 + 延迟兜底一次以覆盖异步加载时序。
            const stripSearchAndScratchpad = () => {
              try {
                const sidebar = drawioUi.sidebar
                if (sidebar && Array.isArray(sidebar.entries)) {
                  for (const section of sidebar.entries) {
                    if (Array.isArray(section?.entries)) {
                      section.entries = section.entries.filter(
                        (entry: any) =>
                          entry?.id !== 'search' && entry?.id !== '.scratchpad',
                      )
                    }
                  }
                }
                if (drawioUi.scratchpad) {
                  drawioUi.closeLibrary(drawioUi.scratchpad)
                }
              } catch (e) {
                console.error('[DrawioEditor] strip search/scratchpad failed', e)
              }
            }
            stripSearchAndScratchpad()
            setTimeout(stripSearchAndScratchpad, 600)

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

    // 点击画板任意位置时自动收起"所有图形"浮动面板。
    // 必须监听 pointerdown 而非 mousedown：新版 Chromium 走 Pointer Events，
    // drawio 在 pointerdown 上 preventDefault 会抑制兼容性 mousedown 的合成，
    // mousedown 监听器永远收不到真实点击。document 捕获阶段 + 每次事件实时
    // 查询最新的 graph.container（drawio setFileData 时会重建 graph，缓存引用
    // 会失效）。面板自身、右侧浮动样式面板、左侧悬浮工具条都在
    // graph.container 之外，不会误触；从面板拖图形到画板时 pointerdown 发生在
    // 面板上，同样不受影响。
    useEffect(() => {
      if (!isReady) return
      const hideSidebar = (e: PointerEvent) => {
        const container: HTMLElement | undefined =
          window.__wedrawDrawio?.app?.editor?.graph?.container
        if (container && e.target instanceof Node && container.contains(e.target)) {
          setSidebarOpen(false)
        }
      }
      document.addEventListener('pointerdown', hideSidebar, true)
      return () => document.removeEventListener('pointerdown', hideSidebar, true)
    }, [isReady])

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
        {/* 外层包装：源码面板挂在 geEditor 之外，避免 grapheditor.css 里
            无 @layer 的 :where(.geEditor button) 兜底规则压掉 Button 的
            Tailwind 类（未分层样式优先级高于 Tailwind v4 的 @layer utilities） */}
        <div className={cn('relative h-full min-h-0 w-full overflow-hidden', className)}>
        <div
          ref={containerHostRef}
          id="drawio-host"
          className={cn(
            // `geEditor` is required so drawio's CSS (`.geEditor > .geMenubarContainer
            // { position: absolute; ... }`) actually positions the toolbar/sidebar
            // /diagram absolutely inside this container. Without it they default to
            // static and fall to the bottom.
            'geEditor absolute inset-0 h-full w-full overflow-hidden',
            // 绘图面板默认隐藏（见 CHROME_HIDING_CSS 中的 .wedraw-sidebar-hidden 规则）
            !sidebarOpen && 'wedraw-sidebar-hidden',
          )}
        >
          {/* drawio mounts itself into this div via App.main's createUi factory */}
          {/* 形状工具条 - 左侧竖排悬浮（替换原生顶部工具栏，样式对齐 Mermaid） */}
          {isReady && (
            <div className="wedraw-float-bar absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border border-border/50 bg-surface/90 p-1 shadow-md backdrop-blur-md">
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

              <div className="my-0.5 h-px w-4 bg-border" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSidebarOpen((v) => !v)}
                    className={cn(
                      'h-8 w-8 rounded-lg p-0 text-muted hover:bg-black/5 hover:text-primary',
                      sidebarOpen && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                    )}
                  >
                    <Shapes className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{sidebarOpen ? '隐藏所有图形' : '所有图形'}</TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* 缩放/撤销/重做控制 - 左下角悬浮（样式完全对齐 Mermaid 引擎） */}
          {isReady && (
            <div className="wedraw-float-bar absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-md bg-surface/80 px-0.5 py-0.5 shadow-sm backdrop-blur-sm">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleZoomOut} className="h-6 w-6 p-0">
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>缩小</TooltipContent>
              </Tooltip>

              <span className="min-w-[2.5rem] text-center text-[11px] text-muted">
                {zoomPercent}%
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleZoomIn} className="h-6 w-6 p-0">
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>放大</TooltipContent>
              </Tooltip>

              <div className="mx-0.5 h-3.5 w-px bg-border" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleUndo} className="h-6 w-6 p-0">
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>撤销 (Ctrl+Z)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={handleRedo} className="h-6 w-6 p-0">
                    <Redo2 className="h-3.5 w-3.5" />
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
        </div>

          {showCodePanel && (
            <div
              className="absolute bottom-4 right-4 z-10 w-96 max-h-[70%] flex flex-col overflow-hidden rounded-xl border border-[#e5e7eb] bg-surface shadow-lg select-text"
              // 阻断 keydown 冒泡到 document/window：drawio 在全局注册了快捷键
              // （Ctrl+A 全选图形、Ctrl+Z 撤销图形等），不拦截的话编辑代码时
              // 按键会穿透到画板。这里在 Monaco 处理完事件后截断冒泡，
              // 让代码面板内的快捷键（Ctrl+A 全选文本、Ctrl+Z 撤销输入）
              // 只作用于编辑器本身，与 Mermaid 引擎行为一致。
              onKeyDown={(e) => e.stopPropagation()}
            >
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
                    lineNumbers: 'off',
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
  },
)
