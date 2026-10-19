export type EngineType = 'mermaid' | 'excalidraw' | 'drawio'

/** Gemini 思考档位：低 / 中 / 高（默认 medium） */
export type ThinkingLevel = 'low' | 'medium' | 'high'

export interface Env {
  AI_BASE_URL: string
  AI_API_KEY: string
  AI_MODEL_ID: string
  /**
   * Gemini 原生协议根地址（如中转站的 https://api.openai-proxy.org/google，
   * 或官方 https://generativelanguage.googleapis.com）。
   * 未配置时按 AI_BASE_URL 推导：googleapis 直接用，否则追加 /google。
   */
  AI_GEMINI_BASE_URL?: string
  /** 默认思考档位。请求体里的 thinking 字段可覆盖；未提供时使用 'medium'。 */
  AI_THINKING?: ThinkingLevel | string
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface ContentPart {
  type: 'text' | 'image_url'
  /** text part: 正文 */
  text?: string
  /** image_url part: OpenAI 多模态协议；url 通常是 data:image/...;base64,... */
  image_url?: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

export interface ChatRequest {
  /**
   * Engine the request is targeting. The server uses this to inject the
   * engine-specific system prompt before forwarding to the AI provider.
   */
  engine?: EngineType
  messages: Message[]
  stream?: boolean
  /** 思考档位 'low' | 'medium' | 'high'，默认 'medium' */
  thinking?: ThinkingLevel
}

export interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}
