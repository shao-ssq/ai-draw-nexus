import { Hono } from 'hono'
import type { Env, ChatRequest } from '../_shared/types.js'
import { corsHeaders } from '../_shared/cors.js'
import { callOpenAI, callAnthropic } from '../_shared/ai-providers.js'
import { streamOpenAI } from '../_shared/stream-openai.js'
import { streamAnthropic } from '../_shared/stream-anthropic.js'

const app = new Hono()

function getEnv(): Env {
  return {
    AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
    AI_BASE_URL: process.env.AI_BASE_URL || '',
    AI_API_KEY: process.env.AI_API_KEY || '',
    AI_MODEL_ID: process.env.AI_MODEL_ID || '',
    AI_THINKING: process.env.AI_THINKING,
  }
}

app.options('/chat', (c) => c.body(null, { headers: corsHeaders }))

app.post('/chat', async (c) => {
  const env = getEnv()

  try {
    const body: ChatRequest = await c.req.json()
    const { messages, stream = false } = body

    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: 'Invalid request: messages required' }, 400, corsHeaders)
    }

    const provider = env.AI_PROVIDER || 'openai'
    // 请求体 thinking 覆盖 env AI_THINKING（未传则用 env 默认 disabled）
    const effectiveEnv: Env = body.thinking
      ? { ...env, AI_THINKING: body.thinking }
      : env

    if (stream) {
      switch (provider) {
        case 'anthropic':
          return streamAnthropic(messages, effectiveEnv)
        case 'openai':
        default:
          return streamOpenAI(messages, effectiveEnv)
      }
    } else {
      let response: string

      switch (provider) {
        case 'anthropic':
          response = await callAnthropic(messages, effectiveEnv)
          break
        case 'openai':
        default:
          response = await callOpenAI(messages, effectiveEnv)
          break
      }

      return c.json({ content: response }, 200, corsHeaders)
    }
  } catch (error) {
    console.error('Chat error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: errorMessage }, 500, corsHeaders)
  }
})

export { app as chat }
