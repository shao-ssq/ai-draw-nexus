import { Hono } from 'hono'
import { corsHeaders } from '../_shared/cors.js'

const app = new Hono()

app.options('/health', (c) => c.body(null, { headers: corsHeaders }))
app.options('/model-info', (c) => c.body(null, { headers: corsHeaders }))

app.get('/health', (c) => {
  return c.json({ status: 'ok' }, 200, corsHeaders)
})

app.get('/model-info', (c) => {
  const provider = process.env.AI_PROVIDER || 'openai'
  const modelId = process.env.AI_MODEL_ID || ''
  const thinking = process.env.AI_THINKING || 'disabled'
  const baseUrl = process.env.AI_BASE_URL || ''

  return c.json({ provider, modelId, thinking, baseUrl }, 200, corsHeaders)
})

export { app as health }
