const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 从 Diagram+ HTML 中提取主 SVG，并携带页面级图表样式和字体声明。
 * 预览仍在隔离 iframe 中进行；该函数仅用于导出和缩略图。
 */
export function extractStandaloneSvg(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const sourceSvg = doc.querySelector('svg')
  if (!sourceSvg) throw new Error('HTML 中未找到 SVG 图形')

  const svg = sourceSvg.cloneNode(true) as SVGElement
  svg.setAttribute('xmlns', SVG_NS)

  const pageStyles = Array.from(doc.querySelectorAll('style'))
    .filter((style) => !sourceSvg.contains(style))
    .map((style) => style.textContent ?? '')
  const fontImports = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'))
    .map((link) => link.getAttribute('href') ?? '')
    .filter((href) => href.startsWith('https://fonts.googleapis.com/css2'))
    .map((href) => `@import url("${href}");`)

  const css = [...fontImports, ...pageStyles].filter(Boolean).join('\n')
  if (css) {
    let defs = svg.querySelector('defs')
    if (!defs) {
      defs = doc.createElementNS(SVG_NS, 'defs')
      const title = svg.querySelector(':scope > title')
      const desc = svg.querySelector(':scope > desc')
      const anchor = desc ?? title
      if (anchor) anchor.after(defs)
      else svg.prepend(defs)
    }
    const style = doc.createElementNS(SVG_NS, 'style')
    style.textContent = css
    defs.prepend(style)
  }

  return new XMLSerializer().serializeToString(svg)
}

function getSvgDimensions(svgText: string): { width: number; height: number } {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] }
  }

  const width = Number.parseFloat(svg.getAttribute('width') ?? '')
  const height = Number.parseFloat(svg.getAttribute('height') ?? '')
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height }
  }
  throw new Error('SVG 缺少有效的 viewBox 或尺寸')
}

/** 将 SVG 栅格化为 PNG data URL；导出用 2×，项目缩略图限制在 400×300 内。 */
export async function renderSvgToPngDataUrl(
  svgText: string,
  scale = 2,
  maxWidth?: number,
  maxHeight?: number,
): Promise<string> {
  const { width, height } = getSvgDimensions(svgText)
  let outputScale = scale
  if (maxWidth && maxHeight) {
    outputScale = Math.min(scale, maxWidth / width, maxHeight / height)
  }

  const objectUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('SVG 图片加载失败'))
      image.src = objectUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * outputScale))
    canvas.height = Math.max(1, Math.round(height * outputScale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器不支持 Canvas 导出')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
