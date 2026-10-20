/**
 * drawio 跨项目状态清理 helper
 *
 * 背景：drawio 的 EditorUi 是跨页面生命周期的全局单例。在切到下一个 DRAWIO 项目时
 * 必须强制整页 reload 才能让 EditorUi 从零初始化。但 reload 会触发浏览器的
 * beforeunload 流程 —— drawio 用 mxEvent.addEventListener 注册了一个 beforeunload 监听器
 * 检查 `editor.modified`，只要为 true 就弹"Changes you made may not be saved"。
 *
 * 跳走前先 setModified(false) 就能让 drawio 自己的 handler 早返回，不再弹窗。
 * 顺手再把 window.onbeforeunload 清掉（覆盖其他可能注册的 inline handler）。
 */

// Window.__wedrawDrawio is declared once in src/types/drawio.d.ts — a second
// declaration with a narrower shape here shadowed it program-wide (TS2717) and
// broke every drawio editor access in DrawioEditor.tsx.

export function clearDrawioModifiedBeforeUnload(): void {
  if (typeof window === 'undefined') return
  try {
    const ui = window.__wedrawDrawio?.app
    ui?.editor?.setModified?.(false)
  } catch {
    /* drawio 状态异常时静默，不阻塞 reload */
  }
  // 兜底：清掉可能存在的 inline handler（不影响 addEventListener 注册的 drawio handler）
  window.onbeforeunload = null
}
