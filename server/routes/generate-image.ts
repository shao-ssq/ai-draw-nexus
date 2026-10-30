import { Hono } from 'hono'
import { corsHeaders } from '../_shared/cors.js'
import { isEngineEnabled } from '../_shared/engineConfig.js'

/**
 * POST /api/generate-image
 *
 * 前端流程：HomePage / ChatPanel → 设计师 LLM（/api/chat?engine=image2，server 注入
 * drawing-prompt designer 的 system prompt）→ 把 LLM 输出的图像 prompt 原封不动
 * POST 到这里 → 这里转发给 OpenAI gpt-image-1（兼容 /v1/images/generations）→ 把返回的
 * base64 包成 data:image/png;base64,... 返回给前端。
 *
 * 环境变量：
 *   AI_API_KEY         跟主 LLM 共用一个 key
 *   AI_IMAGE_MODEL_ID  默认 gpt-image-1
 *   AI_IMAGE_BASE_URL  默认 https://api.openai.com
 *                       —— 中转站通常带 /v1（如 api.openai-proxy.org/v1），
 *                          这里会自动剥掉，避免拼成 /v1/v1/...
 *
 * 已知限制：
 *   - /v1/images/generations 不支持 input image 数组，referenceImages 当前**不转发**；
 *     想支持参考图需要切到 /v1/images/edits（input image + prompt），后续可按有无
 *     referenceImages 自动分发到不同端点。
 */

const IMAGE2_SIZE_MAP: Record<string, { width: number; height: number }> = {
  '1:1__1k':  { width: 1024, height: 1024 },
  '1:1__2k':  { width: 2048, height: 2048 },
  '4:3__1k':  { width: 1024, height: 768 },
  '4:3__2k':  { width: 2048, height: 1536 },
  '3:4__1k':  { width: 768,  height: 1024 },
  '3:4__2k':  { width: 1536, height: 2048 },
  '16:9__1k': { width: 1024, height: 576 },
  '16:9__2k': { width: 2048, height: 1152 },
  '9:16__1k': { width: 576,  height: 1024 },
  '9:16__2k': { width: 1152, height: 2048 },
}

type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16'
type Resolution = '1k' | '2k'
type Quality = 'low' | 'medium' | 'high'

interface GenerateImageParams {
  aspectRatio?: AspectRatio
  resolution?: Resolution
  quality?: Quality
}

interface GenerateImageBody {
  prompt: string
  referenceImages?: Array<{ mimeType: string; dataUrl: string }>
  params?: GenerateImageParams
}

const app = new Hono()

app.options('/generate-image', (c) => c.body(null, { headers: corsHeaders }))

app.post('/generate-image', async (c) => {
  try {
    if (!isEngineEnabled('image2')) {
      return c.json({ error: '绘图引擎 image2 已关闭，请在 .env 中重新启用' }, 403, corsHeaders)
    }
    const body = (await c.req.json()) as GenerateImageBody
    const { prompt, params = {} } = body

    if (!prompt || typeof prompt !== 'string') {
      return c.json({ error: 'prompt is required' }, 400, corsHeaders)
    }

    const aspectRatio: AspectRatio = params.aspectRatio ?? '1:1'
    const resolution: Resolution = params.resolution ?? '1k'
    const quality: Quality = params.quality ?? 'medium'

    const size =
      IMAGE2_SIZE_MAP[`${aspectRatio}__${resolution}`] ?? { width: 1024, height: 1024 }

    const apiKey = process.env.AI_API_KEY
    if (!apiKey) {
      return c.json(
        { error: 'AI_API_KEY not configured' },
        500,
        corsHeaders,
      )
    }

    // baseUrl 剥尾斜杠；如果用户按中转站文档习惯带了 /v1 后缀，再剥一次避免 /v1/v1/...
    let baseUrl = (process.env.AI_IMAGE_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')
    if (baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3)
    const modelId = process.env.AI_IMAGE_MODEL_ID || 'gpt-image-1'
    // 端点路径固定带 /v1 —— baseUrl 已经剥干净，这里直接拼
    const reqUrl = `${baseUrl}/v1/images/generations`

    // quality: 'low' | 'medium' | 'high' 是 gpt-image-1 支持的三档
    // 注意：不带 response_format —— 部分中转（如 api.openai-proxy.org 上的 gpt-image-2）
    // 会把未知字段当 400。统一走 URL 返回，再 fetch + 转 base64。
    const upstream = await fetch(reqUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        prompt,
        size: `${size.width}x${size.height}`,
        quality,
        n: 1,
      }),
    })

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => upstream.statusText)
      console.error(
        '[generate-image] upstream error',
        upstream.status,
        { url: reqUrl, modelId, prompt: prompt.slice(0, 80) },
        errText,
      )
      return c.json(
        {
          error: `Image API error (${upstream.status}): ${errText}`,
          url: reqUrl,
          modelId,
        },
        upstream.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
        corsHeaders,
      )
    }

    const data = (await upstream.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>
    }
    const item = data.data?.[0]
    if (!item) {
      return c.json({ error: 'Image API returned no data' }, 500, corsHeaders)
    }

    let dataUrl: string
    if (item.b64_json) {
      dataUrl = `data:image/png;base64,${item.b64_json}`
    } else if (item.url) {
      // fallback：少数代理只返回 URL，需要 fetch 回来转 base64
      const imgResp = await fetch(item.url)
      if (!imgResp.ok) {
        return c.json({ error: 'Failed to fetch returned image URL' }, 502, corsHeaders)
      }
      const buf = new Uint8Array(await imgResp.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
      const b64 = btoa(bin)
      dataUrl = `data:image/png;base64,${b64}`
    } else {
      return c.json({ error: 'Image API returned no image payload' }, 500, corsHeaders)
    }

    return c.json({ dataUrl }, 200, corsHeaders)
  } catch (error) {
    console.error('[generate-image] error:', error)
    const errMsg = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: errMsg }, 500, corsHeaders)
  }
})

export { app as generateImage }
