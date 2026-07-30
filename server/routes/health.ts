import { Hono } from 'hono'
import { corsHeaders } from '../_shared/cors.js'

const app = new Hono()

app.options('/health', (c) => c.body(null, { headers: corsHeaders }))

app.get('/health', (c) => {
  return c.json({ status: 'ok' }, 200, corsHeaders)
})

export { app as health }
