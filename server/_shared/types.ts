export interface Env {
  AI_PROVIDER: string
  AI_BASE_URL: string
  AI_API_KEY: string
  AI_MODEL_ID: string
  // 'disabled' | 'enabled' | undefined。控制 GLM 等模型的思考开关。
  // 默认 disabled：GLM-5.2 思考约耗时 50s+，关闭后首字节 <1s。
  // 复杂图可设 enabled 换取更精细的布局规划（但会显著变慢）。
  AI_THINKING?: string
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface ContentPart {
  type: 'text'
  text?: string
}

export interface ChatRequest {
  messages: Message[]
  stream?: boolean
  // 思考开关：请求体覆盖 env AI_THINKING。'enabled' | 'disabled'
  thinking?: 'enabled' | 'disabled'
}

export interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

export interface AnthropicResponse {
  content: Array<{
    type: string
    text: string
  }>
}
