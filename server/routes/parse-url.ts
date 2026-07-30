import { Hono } from 'hono'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { corsHeaders } from '../_shared/cors.js'

const app = new Hono()

app.options('/parse-url', (c) => c.body(null, { headers: corsHeaders }))

function isWechatArticle(url: string): boolean {
  return url.includes('mp.weixin.qq.com')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function preprocessWechatArticle(document: any): void {
  const jsContent = document.getElementById('js_content')
  if (jsContent) {
    jsContent.style.visibility = 'visible'
    jsContent.style.display = 'block'
  }

  const images = document.querySelectorAll('img[data-src]')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  images.forEach((img: any) => {
    const dataSrc = img.getAttribute('data-src')
    if (dataSrc) {
      img.setAttribute('src', dataSrc)
    }
  })

  const removeSelectors = [
    '#js_pc_qr_code',
    '#js_profile_qrcode',
    '.qr_code_pc_outer',
    '.rich_media_area_extra',
    '.reward_area',
    '#js_tags',
    '.original_area_primary',
    '.original_area_extra',
  ]
  removeSelectors.forEach((selector) => {
    const elements = document.querySelectorAll(selector)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements.forEach((el: any) => el.remove())
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractWechatContent(document: any): { title: string; content: string } | null {
  const titleEl = document.getElementById('activity-name') ||
                  document.querySelector('.rich_media_title') ||
                  document.querySelector('h1')
  const title = titleEl?.textContent?.trim() || '微信公众号文章'

  const contentEl = document.getElementById('js_content') ||
                    document.querySelector('.rich_media_content')

  if (!contentEl) {
    return null
  }

  return { title, content: contentEl.innerHTML }
}

app.post('/parse-url', async (c) => {
  try {
    const { url } = await c.req.json() as { url: string }

    if (!url || typeof url !== 'string') {
      return c.json({ error: '请提供有效的URL' }, 400, corsHeaders)
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return c.json({ error: 'URL格式无效' }, 400, corsHeaders)
    }

    const isWechat = isWechatArticle(url)

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }

    if (isWechat) {
      headers['Referer'] = 'https://mp.weixin.qq.com/'
    }

    const response = await fetch(url, { headers, redirect: 'follow' })

    if (!response.ok) {
      return c.json({ error: `无法获取页面内容: ${response.status}` }, 502, corsHeaders)
    }

    const html = await response.text()
    const { document } = parseHTML(html)

    if (isWechat) {
      preprocessWechatArticle(document)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reader = new Readability(document.cloneNode(true) as any)
    let article = reader.parse()

    if (!article && isWechat) {
      const wechatContent = extractWechatContent(document)
      if (wechatContent) {
        article = {
          title: wechatContent.title,
          content: wechatContent.content,
          textContent: '',
          length: wechatContent.content.length,
          excerpt: '',
          byline: '',
          dir: '',
          siteName: '微信公众号',
          lang: 'zh-CN',
          publishedTime: null,
        }
      }
    }

    if (!article) {
      return c.json({ error: '无法解析页面内容，该页面可能不是文章类型' }, 422, corsHeaders)
    }

    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })

    turndownService.addRule('removeEmptyLinks', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filter: (node: any) => node.nodeName === 'A' && !node.textContent?.trim(),
      replacement: () => '',
    })

    turndownService.addRule('wechatImages', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filter: (node: any) => node.nodeName === 'IMG',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      replacement: (_content: string, node: any) => {
        const src = node.getAttribute('src') || node.getAttribute('data-src') || ''
        const alt = node.getAttribute('alt') || ''
        return src ? `![${alt}](${src})` : ''
      },
    })

    const wrappedHtml = `<!DOCTYPE html><html><body>${article.content || ''}</body></html>`
    const { document: contentDoc } = parseHTML(wrappedHtml)
    const markdown = turndownService.turndown(contentDoc.body)

    const siteName = isWechat ? '微信公众号' : parsedUrl.hostname
    const fullMarkdown = `# ${article.title}\n\n> 来源: [${siteName}](${url})\n\n${markdown}`

    return c.json({
      success: true,
      data: {
        title: article.title,
        content: fullMarkdown,
        excerpt: article.excerpt,
        siteName: article.siteName || siteName,
        url: url,
      },
    }, 200, corsHeaders)
  } catch (error) {
    console.error('Parse URL error:', error)
    return c.json(
      { error: error instanceof Error ? error.message : '解析失败' },
      500,
      corsHeaders
    )
  }
})

export { app as parseUrl }
