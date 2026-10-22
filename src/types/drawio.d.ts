// src/types/drawio.d.ts
// Global type declarations for drawio 31.4.6 runtime. The drawio bundles
// (app.min.js, mxClient.js, etc.) are loaded at runtime from /drawio/* via
// <script> tags — there is no @types/drawio package. We declare only what
// DrawioEditor.tsx and the AI flow actually touch.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    App: any
    EditorUi: any
    Editor: any
    Graph: any
    mxClient: any
    mxBasePath: string
    mxImageBasePath: string
    mxUtils: any
    mxResources: any
    mxEvent: { CHANGE: string; NOTIFY: string; SCALE: string }
    mxCell: any
    mxGeometry: any
    mxPoint: any
    Draw: any
    uiTheme: string | null
    urlParams: Record<string, string>
    DRAWIO_PUBLIC_BUILD?: boolean
    EXPORT_URL?: string | null
    DRAWIO_BASE_URL?: string | null
    DRAWIO_VIEWER_URL?: string | null
    DRAWIO_LIGHTBOX_URL?: string | null
    DRAW_MATH_URL?: string | null
    VSS_CONVERT_URL?: string | null
    RT_WEBSOCKET_URL?: string | null
    REALTIME_URL?: string | null
    DRAWIO_GITHUB_URL?: string | null
    DRAWIO_GITHUB_API_URL?: string | null
    DRAWIO_GITHUB_ID?: string | null
    DRAWIO_GITLAB_URL?: string | null
    DRAWIO_GITLAB_ID?: string | null
    DRAWIO_DROPBOX_ID?: string | null
    SAVE_URL?: string | null
    PROXY_URL?: string | null
    NOTIFICATIONS_URL?: string | null
    PUSHER_URL?: string | null
    ICONSEARCH_PATH?: string | null
    ICON_SERVICE_PATH?: string | null
    onDrawioAppReady?: (ui: any) => void
    wedrawCreateAppUi?: () => any
    // Cross-lifecycle singleton holder: App.main can only run once per page, so the
    // EditorUi instance is stashed on window and reused across remounts.
    // Must stay the ONLY declaration of this property (DrawioEditor.tsx uses it)
    // — two different types here is TS2717.
    __wedrawDrawio?: {
      app: any | null
      changeHandler: ((xml: string) => void) | null
      zoomHandler: ((percent: number) => void) | null
      /** 一次性定制是否已跑过（平移/缩放监听/图形库精简/样式面板） */
      initialized: boolean
      /** 当前挂载的 host 容器。App.main 是异步回调，需要现取而不是闭包捕获 */
      host: HTMLDivElement | null
      /** 慢路径产出的画布初始化函数，供"启动被中断后补跑"用 */
      initCanvas: (() => boolean) | null
      /**
       * 最近一次 emit 给 store 的画布 XML。data effect 拿它判断"这份 data
       * 是我自己吐出去的，别再灌回画布"。
       *
       * 必须存在 slot 上而不是组件 ref 里：emit 侧的监听挂在 model 上、活到整个
       * 页面结束，它闭包里的 ref 属于第一次挂载的组件实例；切过项目之后 effect
       * 读的是新实例的 ref，两者对不上，判断永远不成立 —— 拖一下图形就会触发
       * setFileData 把画布整个重置 + 重新居中。
       */
      lastEmittedXml: string | null
    }
    STYLE_PATH?: string
    CSS_PATH?: string
    OPEN_FORM?: string
    SHAPES_PATH?: string
    GRAPH_IMAGE_PATH?: string
    TEMPLATE_PATH?: string
    STENCIL_PATH?: string
    PLUGINS_BASE_PATH?: string
    RESOURCES_PATH?: string
    RESOURCE_BASE?: string
  }
}

export {}
