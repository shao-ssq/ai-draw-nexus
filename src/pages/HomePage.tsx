import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Send, Image as ImageIcon, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { AppSidebar, AppHeader, CreateProjectDialog } from '@/components/layout'
import { ENGINES, QUICK_ACTIONS } from '@/constants'
import type { EngineType, Attachment, DocumentAttachment, ImageAttachment, ThinkingLevel, Image2Params } from '@/types'
import { ProjectRepository } from '@/services/projectRepository'
import { useChatStore } from '@/stores/chatStore'
import { useTypewriter } from '@/hooks/useTypewriter'
import { parseDocument, readFileAsDataUrl, SUPPORTED_IMAGE_EXTENSIONS, MAX_DOCUMENT_COUNT, MAX_IMAGE_COUNT, validateImageFile } from '@/lib/fileUtils'
import { useToast } from '@/hooks/useToast'
import { clearDrawioModifiedBeforeUnload } from '@/lib/drawioLifecycle'
import { ThinkingLevelSelector } from '@/features/chat/ThinkingLevelSelector'
import { Image2ParamsBar } from '@/features/chat/Image2ParamsBar'
import { DEFAULT_IMAGE2_PARAMS } from '@/types'

// 判断 File 是否为图片（用于在提交阶段分派到不同处理路径）
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.name)
}

export function HomePage() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [selectedEngine, setSelectedEngine] = useState<EngineType>('mermaid')
  const [isLoading, setIsLoading] = useState(false)
  const [attachments, setAttachments] = useState<File[]>([])
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium')
  const [image2Params, setImage2Params] = useState<Image2Params>(DEFAULT_IMAGE2_PARAMS)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const setInitialPrompt = useChatStore((state) => state.setInitialPrompt)
  const { error: showError } = useToast()

  // 输入框打字机演示：作为背景文字循环播放示例 prompt（不写入真实 prompt）
  const [typedDemo, setTypedDemo] = useState('')
  const [isTyping, setIsTyping] = useState(true)
  const { stop: stopTypewriter } = useTypewriter(setTypedDemo, QUICK_ACTIONS.map((a) => a.prompt))

  // 新建项目弹窗状态
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)

  const handleQuickStart = async () => {
    if (!prompt.trim()) return

    setIsLoading(true)
    try {
      const project = await ProjectRepository.create({
        title: `Untitled-${Date.now()}`,
        engineType: selectedEngine,
      })

      // 转换文件附件为 Attachment 类型
      const convertedAttachments: Attachment[] = []

      for (const file of attachments) {
        if (isImageFile(file)) {
          const dataUrl = await readFileAsDataUrl(file)
          const imgAtt: ImageAttachment = {
            type: 'image',
            dataUrl,
            fileName: file.name,
            mimeType: file.type || 'image/png',
          }
          convertedAttachments.push(imgAtt)
        } else {
          const content = await parseDocument(file)
          const docAtt: DocumentAttachment = {
            type: 'document',
            content,
            fileName: file.name,
          }
          convertedAttachments.push(docAtt)
        }
      }

      // 传递 prompt 和附件
      const allAttachments = convertedAttachments.length > 0 ? convertedAttachments : null
      setInitialPrompt(prompt.trim(), allAttachments, thinkingLevel, image2Params)

      // DRAWIO 的 EditorUi 是跨项目复用的全局单例，切到新项目时软切换（resetCanvas + setFileData）
      // 不能完全清理旧状态 —— 第二个 DRAWIO 项目画布灰空就是这个问题。强制整页 reload
      // 让 EditorUi 从零初始化，简单可靠。其他引擎（mermaid/excalidraw/image2）走 navigate
      // 即可。
      if (selectedEngine === 'drawio') {
        // 清掉 drawio 的 modified 状态，否则它的 beforeunload 监听器会弹"Changes..."对话框
        clearDrawioModifiedBeforeUnload()
        window.location.assign(`/editor/${project.id}`)
      } else {
        navigate(`/editor/${project.id}`)
      }
    } catch (error) {
      console.error('Failed to create project:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      stopTypewriter()
      setIsTyping(false)
      handleQuickStart()
    }
  }

  const handleAttachmentClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const newFiles = Array.from(files)

    // 副作用（toast）必须放在 setState 外面 —— React 18 StrictMode
    // 会双调用 setState 的 updater 回调，把副作用也双触发。
    const currentDocCount = attachments.filter(f => !isImageFile(f)).length
    const available = MAX_DOCUMENT_COUNT - currentDocCount

    if (available <= 0) {
      showError(`文档最多上传 ${MAX_DOCUMENT_COUNT} 个（单个 ≤1MB）`)
      return
    }
    if (newFiles.length > available) {
      showError(`只能再上传 ${available} 个文档，共 ${MAX_DOCUMENT_COUNT} 个上限`)
      setAttachments(prev => [...prev, ...newFiles.slice(0, available)])
      return
    }
    setAttachments(prev => [...prev, ...newFiles])
  }

  const handleImageAttachmentClick = () => {
    // 直接触发文件选择；"替换旧图"的过滤逻辑放在 onChange 里，
    // 避免 setAttachments 与 click() 之间的竞态。
    imageInputRef.current?.click()
  }

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const newFiles = Array.from(files)

    // 限制最多 1 张，超额提示并截断
    if (newFiles.length > MAX_IMAGE_COUNT) {
      showError(`图片最多上传 ${MAX_IMAGE_COUNT} 张，已取第一张`)
    }
    const filesToAdd = newFiles.slice(0, MAX_IMAGE_COUNT)

    // 校验（1MB / 格式）
    for (const file of filesToAdd) {
      const validation = validateImageFile(file)
      if (!validation.valid) {
        showError(validation.error!)
        return
      }
    }

    // 必须先把 FileList 拍成数组快照，因为下面 e.target.value = ''
    // 会立刻清空 FileList，导致 setAttachments 回调里 Array.from 拿到空。
    setAttachments(prev => [
      ...prev.filter(f => !isImageFile(f)), // 清掉旧图片，保留文档
      ...filesToAdd,
    ])
    // 重置 input.value，允许同一文件再次选择
    e.target.value = ''
  }

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-background">
      {/* Mesh Gradient 光晕背景 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 -top-40 h-[36rem] w-[36rem] rounded-full bg-rose-200/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-40 top-0 h-[36rem] w-[36rem] rounded-full bg-teal-200/20 blur-3xl"
      />

      {/* Floating Sidebar Navigation */}
      <AppSidebar onCreateProject={() => setIsCreateDialogOpen(true)} />

      {/* Main Content */}
      <main className="flex flex-1 flex-col">
        {/* Header */}
        <AppHeader />

        {/* Hero Section */}
        <div className="flex flex-1 flex-col items-center justify-start px-8 pt-45 pb-12">
          {/* Promotional Banner */}
          {/* <div className="mb-8 flex items-center gap-2 rounded-full bg-accent-light px-4 py-2">
            <span className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-surface">
              NEW
            </span>
            <span className="text-sm text-primary">
              立即升级，享受365天无限制使用！
            </span>
            <span className="cursor-pointer text-sm font-medium text-accent">
              立即升级 →
            </span>
          </div> */}

          {/* Logo & Slogan */}
          <div className="mb-8 flex flex-col items-center">
            <div className="mb-4 flex items-center gap-3">
              {/* <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
                <Sparkles className="h-6 w-6 text-surface" />
              </div> */}
              <h1 className="text-3xl font-bold text-primary">
                  想到就能画到 —— 机灵鬼<span className="text-xl">儿</span>
              </h1>
            </div>
            <p className="text-muted"></p>
          </div>

          {/* Chat Input Box */}
          <div className="mb-6 w-full max-w-[860px]">
            <div className="flex flex-col gap-4 rounded-3xl border border-border bg-surface px-6 pb-4 pt-5 shadow-[0_10px_30px_-5px_rgba(0,0,0,0.05),0_4px_12px_-2px_rgba(0,0,0,0.02)] transition-[box-shadow,border-color] focus-within:border-[rgba(156,163,175,0.5)] focus-within:shadow-[0_12px_36px_-5px_rgba(0,0,0,0.08)]">
              {/* 附件预览区域 - 输入框顶部：缩略图 / 文件名 / 移除按钮 */}
              {attachments.length > 0 && (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {attachments.map((file, index) => {
                    const image = isImageFile(file)
                    const previewUrl = image ? URL.createObjectURL(file) : null
                    return (
                      <div
                        key={`file-${index}`}
                        className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-1.5"
                      >
                        {/* 左侧：缩略图（图片）或文档图标 */}
                        {image && previewUrl ? (
                          <img
                            src={previewUrl}
                            alt={file.name}
                            className="h-9 w-9 flex-shrink-0 rounded object-cover"
                          />
                        ) : (
                          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded bg-primary/5">
                            <FileText className="h-4 w-4 text-muted" />
                          </div>
                        )}
                        {/* 中间：文件名 */}
                        <span className="flex-1 min-w-0 truncate text-sm text-primary">
                          {file.name}
                        </span>
                        {/* 右侧：移除按钮 */}
                        <button
                          onClick={() => removeAttachment(index)}
                          title="移除附件"
                          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-primary"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="relative">
                {/* 打字机背景演示文字 */}
                {isTyping && !prompt.trim() && (
                  <div className="pointer-events-none absolute inset-0 flex items-start px-2 py-2 text-[15px] leading-relaxed text-[#9ca3af]">
                    <span>{typedDemo}</span>
                    <span className="ml-0.5 mt-[3px] inline-block h-[18px] w-[2px] animate-[caret-blink_1s_steps(1)_infinite] bg-[#9ca3af]" />
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  placeholder={isTyping ? '' : '描述你想要绘制的图表，机灵鬼儿 会帮你完成...'}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onFocus={() => {
                    stopTypewriter()
                    setIsTyping(false)
                  }}
                  onKeyDown={handleKeyDown}
                  disabled={isLoading}
                  className="min-h-[100px] w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-[#1f2937] placeholder:text-[#9ca3af] focus:outline-none"
                />
              </div>

              {/* 隐藏的文件输入 */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileChange}
                className="hidden"
                accept=".docx,.txt,.md"
              />
              <input
                ref={imageInputRef}
                type="file"
                multiple
                onChange={handleImageFileChange}
                className="hidden"
                accept={SUPPORTED_IMAGE_EXTENSIONS.join(',')}
              />

              {/* Image2 生成参数：仅当选中 image2 引擎时显示 */}
              {selectedEngine === 'image2' && (
                <Image2ParamsBar
                  value={image2Params}
                  onChange={setImage2Params}
                />
              )}

              {/* 底部工具栏 */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* 左侧：图表类型标签组 */}
                <div className="flex flex-wrap items-center gap-2">
                  {ENGINES.map((engine) => {
                    const dotColor: Record<string, string> = {
                      mermaid: 'bg-indigo-500',
                      excalidraw: 'bg-orange-500',
                      drawio: 'bg-emerald-500',
                      image2: 'bg-sky-500',
                    }
                    const descriptions: Record<string, string> = {
                      mermaid: '适合流程、时序、ER 等结构化图；文本语法清晰，便于版本管理和后续手工修改。',
                      excalidraw: '适合方案草图、白板讨论和产品构思；手绘感更自然，表达关系比追求精确排版更重要。',
                      drawio: '适合架构、拓扑、UML 和交付级技术图；图元库丰富，适合复杂系统和规范化排版。',
                      image2: '文字描述直接生成高保真图像；适合插画、海报、产品图、概念图等非结构化视觉素材。',
                    }
                    const active = selectedEngine === engine.value
                    return (
                      <div key={engine.value} className="group relative">
                        <button
                          onClick={() => setSelectedEngine(engine.value)}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                            active
                              ? 'border-[#9ca3af] bg-[#d1d5db] text-[#111827]'
                              : 'border-border bg-[#f3f4f6] text-[#374151] hover:bg-[#e5e7eb]'
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${dotColor[engine.value]}`} />
                          <span>{engine.label}</span>
                        </button>
                        {/* hover 提示气泡 */}
                        <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-xl bg-primary px-3 py-2 text-xs leading-relaxed text-surface opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
                          {descriptions[engine.value]}
                          <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-primary" />
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 右侧：操作按钮组 */}
                <div className="flex items-center gap-2">
                  {/* 上传文档（最多 5 个，单个 ≤1MB） */}
                  <button
                    onClick={handleAttachmentClick}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-background hover:text-primary"
                    title="上传文档（最多 5 个，单个 ≤1MB）"
                  >
                    <FileText className="h-4 w-4" />
                  </button>

                  {/* 上传图片（最多 1 张，单个 ≤1MB，再次点击替换） */}
                  <button
                    onClick={handleImageAttachmentClick}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-background hover:text-primary"
                    title="上传图片（最多 1 张，单个 ≤1MB，再次点击替换）"
                  >
                    <ImageIcon className="h-4 w-4" />
                  </button>

                  {/* 思考档位选择器（关 / 低 / 中 / 高） */}
                  <ThinkingLevelSelector
                    value={thinkingLevel}
                    onChange={setThinkingLevel}
                    variant="pill"
                  />

                  {/* 发送按钮 */}
                  <Button
                    onClick={handleQuickStart}
                    disabled={!prompt.trim() || isLoading}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {isLoading ? (
                      <span>创建中...</span>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        <span>发送</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
        </div>
      </main>

      {/* Create Project Dialog */}
      <CreateProjectDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
      />
    </div>
  )
}
