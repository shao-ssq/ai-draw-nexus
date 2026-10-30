const ENGINE_ENV_KEYS = {
  mermaid: 'VITE_ENABLE_MERMAID',
  excalidraw: 'VITE_ENABLE_EXCALIDRAW',
  drawio: 'VITE_ENABLE_DRAWIO',
  'diagram-design': 'VITE_ENABLE_DIAGRAM_DESIGN',
  image2: 'VITE_ENABLE_IMAGE2',
} as const

export type ConfigurableEngine = keyof typeof ENGINE_ENV_KEYS

export function isEngineEnabled(engine: string): engine is ConfigurableEngine {
  if (!(engine in ENGINE_ENV_KEYS)) return false
  const key = ENGINE_ENV_KEYS[engine as ConfigurableEngine]
  return process.env[key]?.trim().toLowerCase() !== 'false'
}
