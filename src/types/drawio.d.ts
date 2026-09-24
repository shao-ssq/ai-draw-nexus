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
