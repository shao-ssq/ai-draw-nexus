import type { Env, Message, ContentPart } from './types.js'
import { corsHeaders } from './cors.js'

/**
 * Gemini native protocol implementation (via the relay's Gemini-compatible
 * prefix, e.g. https://api.openai-proxy.org/google, or Google official).
 *
 * Endpoint: POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *
 * Why native protocol: the relay's OpenAI-compatible adapter DISCARDS the
 * thinking trace for Gemini models (verified: no reasoning_content ever
 * appears). The native protocol returns thinking as separate content parts
 * marked `"thought": true` when `generationConfig.thinkingConfig.includeThoughts`
 * is set — so the UI can show the thinking trace regardless of the level.
 */

export type GeminiThinkingLevel = 'low' | 'medium' | 'high'

/** Resolve the base for the Gemini native API. */
export function resolveGeminiBase(env: Env): string {
  if (env.AI_GEMINI_BASE_URL) {
    return env.AI_GEMINI_BASE_URL.replace(/\/+$/, '')
  }
  const base = env.AI_BASE_URL.replace(/\/+$/, '')
  // Relay-style bases (OpenAI-compatible root) expose Gemini under /google.
  // Google official bases already speak the Gemini protocol at the root.
  if (/googleapis\.com$/.test(base) || base.endsWith('/google')) return base
  return `${base}/google`
}

function buildUrl(env: Env, method: 'streamGenerateContent' | 'generateContent'): string {
  const model = encodeURIComponent(env.AI_MODEL_ID)
  return `${resolveGeminiBase(env)}/v1beta/models/${model}:${method}`
}

/** Flatten a message content (string | ContentPart[]) into Gemini text parts. */
function toParts(content: string | ContentPart[]): Array<{ text: string }> {
  if (typeof content === 'string') return [{ text: content }]
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => ({ text: p.text as string }))
}

interface GeminiRequestBody {
  systemInstruction?: { parts: Array<{ text: string }> }
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>
  generationConfig: Record<string, unknown>
}

/** Map OpenAI-style messages to Gemini contents + systemInstruction. */
export function buildGeminiBody(
  messages: Message[],
  thinking: GeminiThinkingLevel
): GeminiRequestBody {
  const systemTexts: string[] = []
  const contents: GeminiRequestBody['contents'] = []

  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => p.text || '').join('\n')
      if (text.trim()) systemTexts.push(text)
      continue
    }
    const parts = toParts(m.content)
    if (parts.length === 0) continue
    // Gemini only accepts 'user' and 'model' roles; OpenAI 'assistant' → 'model'
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }

  const body: GeminiRequestBody = {
    contents,
    generationConfig: {
      maxOutputTokens: 64000,
      thinkingConfig: {
        thinkingLevel: thinking.toUpperCase(),
        includeThoughts: true,
      },
    },
  }
  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] }
  }
  return body
}

async function postGemini(
  env: Env,
  method: 'streamGenerateContent' | 'generateContent',
  messages: Message[],
  thinking: GeminiThinkingLevel
): Promise<Response> {
  if (!env.AI_API_KEY) {
    throw new Error('AI_API_KEY not configured')
  }

  const url = method === 'streamGenerateContent' ? `${buildUrl(env, method)}?alt=sse` : buildUrl(env, method)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.AI_API_KEY,
    },
    body: JSON.stringify(buildGeminiBody(messages, thinking)),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Gemini API error: ${error}`)
  }
  return response
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{ text?: string; thought?: boolean }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    thoughtsTokenCount?: number
    candidatesTokenCount?: number
  }
}

/**
 * Stream a chat completion. Thinking parts (`thought: true`) are forwarded as
 * `{ content, isReasoning: true }` SSE chunks; answer parts as `{ content }`.
 * Transitions emit `{ type: 'thinking', inThinking }` status chunks — the
 * frontend already understands all of these.
 */
export async function streamGemini(
  messages: Message[],
  env: Env,
  thinking: string
): Promise<Response> {
  const level: GeminiThinkingLevel =
    thinking === 'low' || thinking === 'high' ? thinking : 'medium'
  const upstream = await postGemini(env, 'streamGenerateContent', messages, level)

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  ;(async () => {
    const reader = upstream.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''
    let inThinking = false
    let reasoningEnded = false

    const emit = async (payload: unknown) => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            await emit({ type: 'done' })
            continue
          }

          let parsed: GeminiStreamChunk
          try {
            parsed = JSON.parse(data)
          } catch {
            continue
          }

          for (const candidate of parsed.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {
              const text = part.text || ''
              if (!text) continue

              if (part.thought) {
                if (!inThinking && !reasoningEnded) {
                  inThinking = true
                  await emit({ type: 'thinking', inThinking: true })
                }
                await emit({ content: text, isReasoning: true })
              } else {
                if (inThinking && !reasoningEnded) {
                  reasoningEnded = true
                  inThinking = false
                  await emit({ type: 'thinking', inThinking: false })
                }
                await emit({ content: text })
              }
            }
          }
        }
      }
    } finally {
      if (inThinking && !reasoningEnded) {
        try {
          await emit({ type: 'thinking', inThinking: false })
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

/** Non-streaming call: returns the answer text (thinking parts excluded). */
export async function generateGemini(
  messages: Message[],
  env: Env,
  thinking: string
): Promise<string> {
  const level: GeminiThinkingLevel =
    thinking === 'low' || thinking === 'high' ? thinking : 'medium'
  const response = await postGemini(env, 'generateContent', messages, level)
  const data = (await response.json()) as GeminiStreamChunk

  const parts =
    data.candidates?.[0]?.content?.parts ?? []
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('')
}
