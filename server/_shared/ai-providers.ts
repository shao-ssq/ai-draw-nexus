import type { Env, Message, ContentPart, AnthropicContentPart, OpenAIResponse, AnthropicResponse } from './types.js'

export function convertContentPartsToAnthropic(parts: ContentPart[]): AnthropicContentPart[] {
  return parts
    .map((part) => {
      if (part.type === 'text') {
        return { type: 'text' as const, text: part.text || '' }
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url
        if (url.startsWith('data:')) {
          const matches = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
          if (matches) {
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: matches[1],
                data: matches[2],
              },
            }
          }
        }
        return { type: 'text' as const, text: `[Image URL: ${url}]` }
      }
      return { type: 'text' as const, text: '' }
    })
    .filter((part) => part.type === 'image' || (part.type === 'text' && part.text))
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
