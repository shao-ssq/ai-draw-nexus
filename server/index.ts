import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { chat } from './routes/chat.js'
import { health } from './routes/health.js'

const app = new Hono()

// API 路由
app.route('/api', chat)
app.route('/api', health)

// drawio 自托管静态资源（drawio 31.4.6），路径 /drawio/* → ./server/public/drawio/*
app.use('/drawio/*', serveStatic({
  root: './server/public/drawio',
  rewriteRequestPath: (path) => path.replace(/^\/drawio/, ''),
}))

// 前端静态资源（vite build 产物），同源托管
app.use('/*', serveStatic({ root: './dist' }))
// SPA history 路由 fallback：未命中的请求回退到 index.html
app.get('/*', serveStatic({ root: './dist', path: 'index.html' }))

const port = Number(process.env.PORT) || 8787

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`)
})
