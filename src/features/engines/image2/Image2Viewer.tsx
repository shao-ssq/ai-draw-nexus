import { useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { ImageOff } from 'lucide-react'

export interface Image2ViewerRef {
  exportAsSvg: () => void
  exportAsPng: () => void  // 保留兼容名，内部按 JPG 导出（EditorPage 走 canvasRef.current.exportAsPng）
  exportAsSource: () => void
  showSourceCode: () => void
  hideSourceCode: () => void
  toggleSourceCode: () => void
  getThumbnail: () => Promise<string>
}

interface Image2ViewerProps {
  /** 图片的 base64 data URL（data:image/...;base64,...），空字符串表示还没生成 */
  code: string
}

/**
 * Image2 结果查看器。
 *
 * content 字段直接存图片的 base64 data URL；不做任何代码解析或运行。
 * 顶部不带工具条 —— 复制 / 放大 / 下载按钮全部移除（导出由 EditorPage 顶部的"导出 JPG"按钮触发）。
 */
export const Image2Viewer = forwardRef<Image2ViewerRef, Image2ViewerProps>(
  function Image2Viewer({ code }, ref) {
    const [showSource, setShowSource] = useState(false)

    // 把 Blob 触发成下载
    const downloadBlob = useCallback((blob: Blob, filename: string) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, [])

    /**
     * 直接按 JPG 导出。dataUrl 是 PNG/JPEG 任意；用 canvas 重新绘制 → toBlob('image/jpeg', 0.92)。
     * JPG 不支持 alpha 通道，所以先填白底（半透明白图会变成纯白）。
     */
    const exportAsJpg = useCallback(async () => {
      if (!code) return
      try {
        const img = new Image()
        img.src = code
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('image load failed'))
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas 2d context not available')
        // JPG 不支持 alpha，铺白底避免透明区域变黑
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0)
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
            'image/jpeg',
            0.92,
          )
        })
        downloadBlob(blob, `image2-${Date.now()}.jpg`)
      } catch {
        /* 静默：data URL 解析失败 / canvas 不支持 / toBlob 失败都跳过 */
      }
    }, [code, downloadBlob])

    // 兼容老接口名（EditorPage canvasRef.current.exportAsPng 仍叫这个名字）
    const exportAsPng = exportAsJpg
    // image2 没有"原生 SVG"，统一按 JPG 下载；后缀 .svg 由用户自决
    const exportAsSvg = exportAsJpg
    const exportAsSource = useCallback(() => {
      if (!code) return
      const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
      downloadBlob(blob, `image2-dataurl-${Date.now()}.txt`)
    }, [code, downloadBlob])

    useImperativeHandle(ref, () => ({
      exportAsSvg,
      exportAsPng,
      exportAsSource,
      showSourceCode: () => setShowSource(true),
      hideSourceCode: () => setShowSource(false),
      toggleSourceCode: () => setShowSource((v) => !v),
      getThumbnail: async () => code,
    }), [code, exportAsSvg, exportAsPng, exportAsSource])

    if (!code) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-background">
          <div className="text-center text-muted">
            <ImageOff className="mx-auto mb-3 h-12 w-12 opacity-30" />
            <p className="text-sm">还没有生成图片</p>
            <p className="mt-1 text-xs opacity-70">在左侧输入描述后点击发送</p>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto p-4 bg-background">
        {showSource ? (
          <pre className="max-h-full w-full overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface p-3 text-xs text-muted">
            {code}
          </pre>
        ) : (
          <img
            src={code}
            alt="Image2 生成结果"
            className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
          />
        )}
      </div>
    )
  },
)
