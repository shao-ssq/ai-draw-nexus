// Engine Types
export type EngineType = 'mermaid' | 'excalidraw' | 'drawio'

/** Gemini 思考档位：非思考(low) / 思考(medium) / 深度思考(high)，默认 medium */
export type ThinkingLevel = 'low' | 'medium' | 'high'

// Project
export interface Project {
  id: string
  title: string
  engineType: EngineType
  thumbnail: string // Base64 string for preview
  createdAt: Date
  updatedAt: Date
}

// Version History
export interface VersionHistory {
  id: string
  projectId: string
  content: string // Source Code / JSON / XML
  changeSummary: string // "Initial" | "AI Edit" | "Manual"
  timestamp: Date
}

// Attachment types for chat messages (documents only — image upload removed)
export interface DocumentAttachment {
  type: 'document'
  content: string // Extracted text content
  fileName: string
}

export type Attachment = DocumentAttachment

// Chat Message (UI Content Store)
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  status: 'pending' | 'streaming' | 'complete' | 'error'
  avatar?: string
  attachments?: Attachment[]
  /** 过程状态文字（绘制中/修改中/修复报错…），展示在折叠框 summary 中 */
  phaseLabel?: string
  /** 多步骤进度（如两阶段生成、修复重试），可选 */
  stepInfo?: { current: number; total: number }
  /** 生成该消息所用的引擎类型，用于显示模型标签 */
  engineType?: EngineType
  /** Kimi 思考内容（reasoning_content），流式过程中实时更新 */
  reasoningContent?: string
}

// Payload Message (Message Payload Store - OpenAI compatible)
export interface ContentPart {
  type: 'text'
  text?: string
}

export interface PayloadMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

// API Request
export interface ChatRequest {
  /**
   * Engine the request is targeting. The server uses this to inject the
   * engine-specific system prompt before forwarding to the AI provider.
   */
  engine?: EngineType
  messages: PayloadMessage[]
  stream?: boolean
  /** 思考档位 'low' | 'medium' | 'high'，默认 'medium' */
  thinking?: ThinkingLevel
}
