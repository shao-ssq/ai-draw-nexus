import type { PayloadMessage, ChatRequest } from '@/types'

// API endpoint - can be configured via environment variable
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

/**
 * Parse SSE data line and extract content or event type
 */
function parseSSELine(line: string): { type: 'content' | 'thinking' | 'done' | 'skip'; content?: string; inThinking?: boolean } {
  let data = line

  // Handle SSE format (data: prefix)
  if (line.startsWith('data: ')) {
    data = line.slice(6)
  }

  if (data === '[DONE]') return { type: 'done' }

  try {
    const parsed = JSON.parse(data)
    // Handle thinking status event
    if (parsed.type === 'thinking') {
      return { type: 'thinking', inThinking: parsed.inThinking }
    }
    // Handle OpenAI format
    if (parsed.choices?.[0]?.delta?.content) {
      return { type: 'content', content: parsed.choices[0].delta.content }
    }
    // Handle simple format
    if (parsed.content) {
      return { type: 'content', content: parsed.content }
    }
    // Handle text field
    if (parsed.text) {
      return { type: 'content', content: parsed.text }
    }
  } catch {
    // Not JSON, return raw data if it has content
    if (data.trim()) {
      return { type: 'content', content: data }
    }
  }
  return { type: 'skip' }
}

/**
 * AI Service for communicating with the backend
 */
export const aiService = {
  /**
   * Send chat messages to AI and get response (non-streaming)
   */
  async chat(messages: PayloadMessage[]): Promise<string> {
    const request: ChatRequest = { messages }

    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`AI request failed: ${error}`)
    }

    const data = await response.json()
    return data.content || data.message || ''
  },

  /**
   * Stream chat response with SSE support
   * @param messages - The messages to send
   * @param onChunk - Callback for each content chunk
   * @param thinking - 'enabled' | 'disabled'，控制模型思考开关（默认 disabled）
   * @param onComplete - Optional callback when streaming completes
   * @param onThinking - Optional callback when thinking content is detected
   * @returns The full accumulated content
   */
  async streamChat(
    messages: PayloadMessage[],
    onChunk: (chunk: string, accumulated: string) => void,
    thinking: 'enabled' | 'disabled' = 'disabled',
    onComplete?: (content: string) => void,
    onThinking?: (isThinking: boolean) => void
  ): Promise<string> {
    const request: ChatRequest = { messages, stream: true, thinking } as ChatRequest & { stream: boolean }

    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`AI request failed: ${error}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Failed to get response reader')
    }

    const decoder = new TextDecoder()
    let fullContent = ''
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmedLine = line.trim()
          if (!trimmedLine) continue

          const result = parseSSELine(trimmedLine)
          if (result.type === 'thinking') {
            onThinking?.(result.inThinking ?? false)
          } else if (result.type === 'content' && result.content) {
            fullContent += result.content
            onChunk(result.content, fullContent)
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const result = parseSSELine(buffer.trim())
        if (result.type === 'thinking') {
          onThinking?.(result.inThinking ?? false)
        } else if (result.type === 'content' && result.content) {
          fullContent += result.content
          onChunk(result.content, fullContent)
        }
      }
    } finally {
      reader.releaseLock()
    }

    onThinking?.(false)
    onComplete?.(fullContent)
    return fullContent
  },
}
