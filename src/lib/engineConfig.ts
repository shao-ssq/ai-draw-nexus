import type { EngineType } from '@/types'

const ENGINE_FLAGS: Record<EngineType, string | undefined> = {
  mermaid: import.meta.env.VITE_ENABLE_MERMAID,
  excalidraw: import.meta.env.VITE_ENABLE_EXCALIDRAW,
  drawio: import.meta.env.VITE_ENABLE_DRAWIO,
  'diagram-design': import.meta.env.VITE_ENABLE_DIAGRAM_DESIGN,
  image2: import.meta.env.VITE_ENABLE_IMAGE2,
}

/** 只有显式配置为 false 才关闭；未配置时保持所有引擎可用。 */
export function isEngineEnabled(engine: EngineType): boolean {
  return ENGINE_FLAGS[engine]?.trim().toLowerCase() !== 'false'
}
