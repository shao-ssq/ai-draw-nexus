import type { Env, Message } from './types.js'
import { corsHeaders } from './cors.js'
import { resolveEndpoint } from './ai-providers.js'

/**
 * Kimi (Moonshot) streaming implementation.
 *
 * Kimi sends two separate delta fields:
 *   - delta.reasoning_content — the model's internal reasoning/thinking
 *   - delta.content            — the final answer text
 *
 * These arrive in separate SSE chunks: all reasoning_content first (with
 * type:'thinking' events so the UI can show "思考中..."), then content.
 * Unlike the OpenAI <think>/</think> text-tag approach, Kimi's reasoning
 * is already split at the field level — no text parsing required.
 */
export async function streamKimi(messages: Message[], env: Env): Promise<Response> {
  const endpoint = resolveEndpoint(env.AI_BASE_URL, '/chat/completions')
  const apiKey = env.AI_API_KEY

  if (!apiKey) {
    throw new Error('AI_API_KEY not configured')
  }

  // Build reasoning_effort extra_body (Kimi-specific)
  // Only pass reasoning_effort when thinking is explicitly enabled.
  // Omitting the field uses model defaults (which may be "max").
  const extraBody: Record<string, unknown> = {}
  if ((env.AI_THINKING || '').toLowerCase() === 'enabled') {
    extraBody['reasoning_effort'] = 'high'
  }

  const body: Record<string, unknown> = {
    model: env.AI_MODEL_ID,
    messages: messages,
    max_tokens: 64000,
    stream: true,
  }
  if (Object.keys(extraBody).length > 0) {
    body['extra_body'] = extraBody
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Kimi API error: ${error}`)
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  ;(async () => {
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''
    let inThinking = false   // tracking whether we are inside reasoning_content stream
    let reasoningEnded = false // once content starts, reasoning is done

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
            const reasoningContent = delta?.reasoning_content || ''
            const content = delta?.content || ''

            // Emit thinking status when reasoning_content starts or ends
            if (reasoningContent && !inThinking && !reasoningEnded) {
              inThinking = true
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ type: 'thinking', inThinking: true })}\n\n`)
              )
            }

            // Send reasoning content as SSE so UI can display it
            if (reasoningContent) {
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ content: reasoningContent, isReasoning: true })}\n\n`)
              )
            }

            // Once content starts, reasoning is over
            if (content && inThinking && !reasoningEnded) {
              reasoningEnded = true
              inThinking = false
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ type: 'thinking', inThinking: false })}\n\n`)
              )
            }

            // Send final answer content
            if (content) {
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ content })}\n\n`)
              )
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } finally {
      // If stream ended while still in thinking state, ensure we emit the off event
      if (inThinking && !reasoningEnded) {
        try {
          await writer.write(
            encoder.encode(`data: ${JSON.stringify({ type: 'thinking', inThinking: false })}\n\n`)
          )
        } catch {
          // writer may already be closed
        }
      }
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
