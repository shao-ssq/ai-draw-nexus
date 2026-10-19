import { Hono } from 'hono'
import { corsHeaders } from '../_shared/cors.js'

const app = new Hono()

app.options('/health', (c) => c.body(null, { headers: corsHeaders }))
app.options('/model-info', (c) => c.body(null, { headers: corsHeaders }))

app.get('/health', (c) => {
  return c.json({ status: 'ok' }, 200, corsHeaders)
})

app.get('/model-info', (c) => {
  // 按引擎返回：image2 走自己的图像模型（gpt-image-*），
  // text engine（mermaid/excalidraw/drawio）走主 LLM（gemini/claude）。
  const engine = c.req.query('engine')
  if (engine === 'image2') {
    return c.json(
      {
        modelId: process.env.AI_IMAGE_MODEL_ID || 'gpt-image-2',
        baseUrl:
          process.env.AI_IMAGE_BASE_URL || process.env.AI_BASE_URL || '',
        thinking: 'n/a',
      },
      200,
      corsHeaders,
    )
  }

  // text engines（mermaid / excalidraw / drawio 或不指定）
  const modelId = process.env.AI_MODEL_ID || ''
  const thinking = process.env.AI_THINKING || 'disabled'
  const baseUrl = process.env.AI_BASE_URL || ''

  return c.json({ modelId, thinking, baseUrl }, 200, corsHeaders)
})

export { app as health }
