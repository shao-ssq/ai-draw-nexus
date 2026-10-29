import { Hono } from 'hono'
import type { ChatRequest, Message, ThinkingLevel } from '../_shared/types.js'
import { corsHeaders } from '../_shared/cors.js'
import { callGemini } from '../_shared/ai-providers.js'
import { streamGemini } from '../_shared/stream-gemini.js'
import { SYSTEM_PROMPTS } from '../_shared/systemPrompts.js'
import { getDiagramDesignSystemPrompt } from '../_shared/diagramDesignPrompt.js'

const app = new Hono()

/** Engine-specific system prompt, injected server-side (no longer on the wire). */
function injectSystemPrompt(
  messages: Message[],
  engine: ChatRequest['engine']
): Message[] {
  if (!engine) return messages
  const systemPrompt = engine === 'diagram-design'
    ? getDiagramDesignSystemPrompt(messages)
    : SYSTEM_PROMPTS[engine]
  if (!systemPrompt) return messages
  const nonSystem = messages.filter((m) => m.role !== 'system')
  return [{ role: 'system', content: systemPrompt }, ...nonSystem]
}

/** Gemini-only: default to medium thinking. */
function resolveThinking(input: string | undefined): ThinkingLevel {
  const t = (input || '').toLowerCase()
  if (t === 'low' || t === 'high') return t
  return 'medium'
}

app.options('/chat', (c) => c.body(null, { headers: corsHeaders }))

app.post('/chat', async (c) => {
  try {
    const body: ChatRequest = await c.req.json()
    const { engine, messages, stream = false } = body

    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: 'Invalid request: messages required' }, 400, corsHeaders)
    }

    const thinking = resolveThinking(body.thinking ?? process.env.AI_THINKING)
    const env = {
      AI_BASE_URL: process.env.AI_BASE_URL || '',
      AI_API_KEY: process.env.AI_API_KEY || '',
      AI_MODEL_ID: process.env.AI_MODEL_ID || '',
      AI_GEMINI_BASE_URL: process.env.AI_GEMINI_BASE_URL || '',
    }
    const finalMessages = injectSystemPrompt(messages, engine)

    if (stream) {
      return streamGemini(finalMessages, env, thinking)
    }

    const content = await callGemini(finalMessages, env, thinking)
    return c.json({ content }, 200, corsHeaders)
  } catch (error) {
    console.error('Chat error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: errorMessage }, 500, corsHeaders)
  }
})

export { app as chat }
