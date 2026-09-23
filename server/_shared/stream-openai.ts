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
    let inThinking = false // 追踪是否处于思考内容中
    let thinkingChanged = false // 思考状态是否改变

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
            let content = delta?.content || ''

            // 先检测思考状态，再过滤内容
            const beforeThinking = inThinking
            const thinkStart = content.indexOf('<think>')
            const thinkEnd = content.indexOf('</think>')

            if (thinkStart !== -1 && thinkEnd !== -1 && thinkStart < thinkEnd) {
              // 同一 chunk 内有完整的 <think>...</think>
              // 提取 <think> 之前 + </think> 之后的内容
              content = content.slice(0, thinkStart) + content.slice(thinkEnd + 4)
              // 状态不变（进入又退出，还是在非思考状态）
              if (beforeThinking) {
                thinkingChanged = true
                inThinking = false
              }
            } else if (thinkStart !== -1) {
              // 思考开始
              content = content.slice(0, thinkStart)
              if (!beforeThinking) {
                thinkingChanged = true
                inThinking = true
              }
            } else if (thinkEnd !== -1) {
              // 思考结束
              content = content.slice(thinkEnd + 4)
              if (beforeThinking) {
                thinkingChanged = true
                inThinking = false
              }
            } else if (beforeThinking) {
              // 仍在思考中，跳过全部内容
              content = ''
            }

            if (thinkingChanged) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', inThinking })}\n\n`))
              thinkingChanged = false
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
