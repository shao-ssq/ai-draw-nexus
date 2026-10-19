// Engine Types
export type EngineType = 'mermaid' | 'excalidraw' | 'drawio' | 'image2'

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

// Attachment types for chat messages
export interface DocumentAttachment {
  type: 'document'
  content: string // Extracted text content
  fileName: string
}

export interface ImageAttachment {
  type: 'image'
  /** Data URL (base64)，用于本地预览和后续送 AI */
  dataUrl: string
  fileName: string
  mimeType: string
}

export type Attachment = DocumentAttachment | ImageAttachment

// Image2 (图像生成) 引擎参数
export type Image2AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16'
export type Image2Resolution = '1k' | '2k'
export type Image2Quality = 'low' | 'medium' | 'high'

export interface Image2Params {
  aspectRatio: Image2AspectRatio
  resolution: Image2Resolution
  quality: Image2Quality
}

export const DEFAULT_IMAGE2_PARAMS: Image2Params = {
  aspectRatio: '1:1',
  resolution: '1k',
  quality: 'medium',
}

/** AspectRatio × Resolution → gpt-image-2 的像素尺寸 */
export const IMAGE2_SIZE_MAP: Record<
  `${Image2AspectRatio}__${Image2Resolution}`,
  { width: number; height: number }
> = {
  '1:1__1k':  { width: 1024, height: 1024 },
  '1:1__2k':  { width: 2048, height: 2048 },
  '4:3__1k':  { width: 1024, height: 768 },
  '4:3__2k':  { width: 2048, height: 1536 },
  '3:4__1k':  { width: 768,  height: 1024 },
  '3:4__2k':  { width: 1536, height: 2048 },
  '16:9__1k': { width: 1024, height: 576 },
  '16:9__2k': { width: 2048, height: 1152 },
  '9:16__1k': { width: 576,  height: 1024 },
  '9:16__2k': { width: 1152, height: 2048 },
}

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
  type: 'text' | 'image_url'
  /** text part: 正文 */
  text?: string
  /** image_url part: OpenAI 多模态协议；url 通常是 data:image/...;base64,... */
  image_url?: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
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
