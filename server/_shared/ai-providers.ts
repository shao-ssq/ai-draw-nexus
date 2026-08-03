import type { Env, Message, ContentPart, OpenAIResponse, AnthropicResponse } from './types.js'

/**
 * Convert OpenAI-compatible content parts to Anthropic format.
 * 图片上传已移除：内容仅含文本部分。
 */
export function convertContentPartsToAnthropic(parts: ContentPart[]): { type: 'text'; text: string }[] {
  return parts
    .map((part) => ({ type: 'text' as const, text: part.text || '' }))
    .filter((part) => part.text)
}

export async function callOpenAI(messages: Message[], env: Env): Promise<string> {
  const baseUrl = env.AI_BASE_URL.replace(/\/+$/, '')
  const chatPath = baseUrl.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions'
  const apiKey = env.AI_API_KEY

  if (!apiKey) {
    throw new Error('AI_API_KEY not configured')
  }

  const response = await fetch(`${baseUrl}${chatPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL_ID,
      messages: messages,
      max_tokens: 64000,
      stream: false,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`OpenAI API error: ${error}`)
  }

  const data = (await response.json()) as OpenAIResponse
  return data.choices[0]?.message?.content || ''
}

export async function callAnthropic(messages: Message[], env: Env): Promise<string> {
  const baseUrl = env.AI_BASE_URL.replace(/\/+$/, '')
  const messagesPath = baseUrl.endsWith('/v1') ? '/messages' : '/v1/messages'
  const apiKey = env.AI_API_KEY

  if (!apiKey) {
    throw new Error('AI_API_KEY not configured')
  }

  const systemMessage = messages.find((m) => m.role === 'system')
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')

  const anthropicMessages = nonSystemMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string' ? m.content : convertContentPartsToAnthropic(m.content),
  }))

  const response = await fetch(`${baseUrl}${messagesPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.AI_MODEL_ID,
      max_tokens: 64000,
      system: typeof systemMessage?.content === 'string' ? systemMessage.content : '',
      messages: anthropicMessages,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Anthropic API error: ${error}`)
  }

  const data = (await response.json()) as AnthropicResponse
  return data.content[0]?.text || ''
}
