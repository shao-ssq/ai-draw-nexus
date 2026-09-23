import type { Env, Message, ContentPart, OpenAIResponse, AnthropicResponse } from './types.js'

/**
 * 构造完整端点 URL。
 * 若 baseUrl 路径中已包含版本段（/v1、/v2 等，如千帆 /v2/tokenplan/personal），
 * 直接追加 suffix；否则默认追加 /v1 + suffix（OpenAI 约定）。
 * 兼容 https://api.openai.com、https://api.openai.com/v1、
 * https://qianfan.baidubce.com/v2/tokenplan/personal 等形态。
 */
export function resolveEndpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const hasVersion = /\/v\d+(\/|$)/.test(base)
  const path = hasVersion ? suffix : `/v1${suffix}`
  return `${base}${path}`
}

/**
 * 构造 OpenAI 兼容请求体的扩展字段。
 * - AI_THINKING=enabled  → thinking:{type:"adaptive"}
 * - AI_THINKING=disabled → thinking:{type:"disabled"}
 * - 未设置              → 不加该字段（保持模型默认行为）
 *
 * 注意：部分兼容端点在 stream:true + thinking:disabled 组合下会返回 400/500，
 *       但 MiniMax 等主流端点支持此参数。遇到 400/500 时可改回不发送。
 */
export function buildThinkingParam(env: Env): Record<string, unknown> {
  const t = (env.AI_THINKING || '').toLowerCase()
  if (t === 'enabled') return { thinking: { type: 'adaptive' } }
  if (t === 'disabled') return { thinking: { type: 'disabled' } }
  return {}
}

/**
 * Anthropic extended thinking 字段。
 * 启用时必须指定 budget_tokens，且 max_tokens 需 >= budget_tokens。
 * - 'enabled'  → { thinking: { type: 'enabled', budget_tokens } }
 * - 'disabled' → { thinking: { type: 'disabled' } }（Anthropic 要求显式关闭，避免走 default）
 * - 未设置     → {}（保留模型默认行为）
 */
export function buildAnthropicThinkingParam(env: Env, maxTokens: number): Record<string, unknown> {
  const t = (env.AI_THINKING || '').toLowerCase()
  if (t === 'enabled') {
    // budget_tokens 取 maxTokens 的 60%，留足余量给实际输出
    const budget = Math.max(1024, Math.floor(maxTokens * 0.6))
    return { thinking: { type: 'enabled', budget_tokens: budget } }
  }
  if (t === 'disabled') {
    return { thinking: { type: 'disabled' } }
  }
  return {}
}

/**
 * Convert OpenAI-compatible content parts to Anthropic format.
 * 图片上传已移除：内容仅含文本部分。
 */
export function convertContentPartsToAnthropic(parts: ContentPart[]): { type: 'text'; text: string }[] {
  return parts
    .map((part) => ({ type: 'text' as const, text: part.text || '' }))
    .filter((part) => part.text)
}

export async function callOpenAI(messages: Message[], env: Env): Promise<string> {
  const endpoint = resolveEndpoint(env.AI_BASE_URL, '/chat/completions')
  const apiKey = env.AI_API_KEY

  if (!apiKey) {
    throw new Error('AI_API_KEY not configured')
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL_ID,
      messages: messages,
      max_tokens: 64000,
      stream: false,
      ...buildThinkingParam(env),
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`OpenAI API error: ${error}`)
  }

  const data = (await response.json()) as OpenAIResponse
  return data.choices[0]?.message?.content || ''
}

export async function callAnthropic(messages: Message[], env: Env): Promise<string> {
  const endpoint = resolveEndpoint(env.AI_BASE_URL, '/messages')
  const apiKey = env.AI_API_KEY

  if (!apiKey) {
    throw new Error('AI_API_KEY not configured')
  }

  const systemMessage = messages.find((m) => m.role === 'system')
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')

  const anthropicMessages = nonSystemMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string' ? m.content : convertContentPartsToAnthropic(m.content),
  }))

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.AI_MODEL_ID,
      max_tokens: 64000,
      system: typeof systemMessage?.content === 'string' ? systemMessage.content : '',
      messages: anthropicMessages,
      ...buildAnthropicThinkingParam(env, 64000),
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Anthropic API error: ${error}`)
  }

  const data = (await response.json()) as AnthropicResponse
  return data.content[0]?.text || ''
}
