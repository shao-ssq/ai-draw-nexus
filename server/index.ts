import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { chat } from './routes/chat.js'
import { health } from './routes/health.js'
import { parseUrl } from './routes/parse-url.js'

const app = new Hono()

// API 路由
app.route('/api', chat)
app.route('/api', health)
app.route('/api', parseUrl)

// 前端静态资源（vite build 产物），同源托管
app.use('/*', serveStatic({ root: './dist' }))
// SPA history 路由 fallback：未命中的请求回退到 index.html
app.get('/*', serveStatic({ root: './dist', path: 'index.html' }))

const port = Number(process.env.PORT) || 8787

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${info.port}`)
})
