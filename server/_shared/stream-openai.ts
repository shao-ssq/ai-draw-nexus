import type { Env, Message } from './types.js'
import { corsHeaders } from './cors.js'
import { resolveEndpoint, buildThinkingParam } from './ai-providers.js'

export async function streamOpenAI(messages: Message[], env: Env): Promise<Response> {
  const endpoint = resolveEndpoint(env.AI_BASE_URL, '/chat/completions')
  const apiKey = env.AI_API_KEY

  if (!apiKey) {
    throw new Error('AI_API_KEY not configured')
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL_ID,
      messages: messages,
      max_tokens: 64000,
      stream: true,
      ...buildThinkingParam(env),
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`OpenAI API error: ${error}`)
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  ;(async () => {
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            await writer.write(encoder.encode('data: [DONE]\n\n'))
            continue
          }

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            const content = delta?.content
            const reasoning = delta?.reasoning_content
            // 思考增量单独转发（reasoning 字段），不混入 content，
            // 前端绘图只消费 content，思考文本可用于"思考中..."指示。
            if (reasoning) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ reasoning })}\n\n`))
            }
            if (content) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`))
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } finally {
      reader.releaseLock()
      await writer.close()
    }
  })()

  return new Response(readable, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
