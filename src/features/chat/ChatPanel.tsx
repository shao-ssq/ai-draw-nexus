import { useState, useRef, useEffect } from 'react'
import {
  Send,
  FileText,
  X,
  MessageSquarePlus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  PanelLeftClose,
  Sparkles,
  Brain,
  Image as ImageIcon,
} from 'lucide-react'
import { Button, Loading } from '@/components/ui'
import {
  useChatStore,
  selectActiveMessages,
  selectActiveIsStreaming,
} from '@/stores/chatStore'
import {
  useEditorStore,
  selectIsEmpty,
  selectEngineType,
} from '@/stores/editorStore'
import { useAIGenerate } from '@/hooks/useAIGenerate'
import { useToast } from '@/hooks/useToast'
import {
  validateDocumentFile,
  validateImageFile,
  parseDocument,
  readFileAsDataUrl,
  selectFiles,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  MAX_DOCUMENT_COUNT,
  MAX_IMAGE_COUNT,
} from '@/lib/fileUtils'
import { MarkdownRenderer } from './MarkdownRenderer'
import type { Attachment, DocumentAttachment, ImageAttachment, ChatMessage, EngineType, ThinkingLevel, Image2Params } from '@/types'
import { ThinkingLevelSelector } from './ThinkingLevelSelector'
import { Image2ParamsBar } from './Image2ParamsBar'
import { DEFAULT_IMAGE2_PARAMS } from '@/types'

const ENGINE_LABEL: Record<EngineType, string> = {
  mermaid: 'Mermaid Agent',
  excalidraw: 'Excalidraw Agent',
  drawio: 'DrawIO Agent',
  image2: 'Image2 Agent',
}

interface ChatPanelProps {
  onCollapse?: () => void
}

function ProcessChip({ msg }: { msg: ChatMessage }) {
  const { status, phaseLabel, stepInfo } = msg
  const isActive = status === 'pending' || status === 'streaming'
  const isError = status === 'error'
  const isComplete = status === 'complete'

  const summaryText = phaseLabel
    || (status === 'pending' ? '等待中...'
      : status === 'streaming' ? '绘制中...'
        : status === 'error' ? '出错'
          : '绘制完成')

  return (
    <span className={`ai-status-chip ${isError ? 'is-error' : isComplete ? 'is-complete' : 'is-active'}`}>
      {isActive ? (
        <Loader2 className="ai-spinner" />
      ) : isError ? (
        <AlertCircle className="h-3 w-3" />
      ) : isComplete ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <Loader2 className="ai-spinner" />
      )}
      <span className="ai-status-text">{summaryText}</span>
      {stepInfo && (
        <span className="ai-status-badge">{stepInfo.current}/{stepInfo.total}</span>
      )}
    </span>
  )
}

function AssistantMessageCard({
  msg,
  onRegenerate,
  modelInfo,
}: {
  msg: ChatMessage
  onRegenerate: () => void
  modelInfo?: { modelId: string } | null
}) {
  const [reasoningExpanded, setReasoningExpanded] = useState(false)
  const reasoningScrollRef = useRef<HTMLDivElement>(null)
  // 用户主动上滚时，停止自动跟随；用 ref 避免触发额外重渲染
  const isUserScrolledUpRef = useRef(false)
  // 记录上一次的 isThinking：仅在 true→false 的瞬间清空展开偏好
  const prevIsThinkingRef = useRef(false)
  const isStreaming = msg.status === 'streaming' || msg.status === 'pending'
  // "是否正在思考"只看 phaseLabel（Kimi 的 onThinking(true/false) 精确控制），
  // 不再用 reasoningContent 兜底——否则 reasoningContent 一直有值，isThinking 会在整个流式期间都为 true，
  // 导致"思考结束 → 开始吐内容"这个真正的折叠时机被错过，要等整次生成完成才折叠。
  const isThinking = msg.phaseLabel === '思考中...'
  const modelTag = msg.engineType ? ENGINE_LABEL[msg.engineType] : 'AI Agent'
  const showRegenerate = !isStreaming && !!msg.content && msg.status !== 'error'
  // image2 走"设计师 LLM → gpt-image-2"两步链路，modelInfo.modelId 是中间那个设计师 LLM
  // （gemini-3.8-flash 之类），不是真正"出图"的模型，挂上去会误导用户。
  // 等后端 /api/model-info 支持按引擎返回时再补真正的图像模型名。
  const modelName =
    msg.engineType === 'image2'
      ? ''
      : modelInfo?.modelId
        ? ` · ${modelInfo.modelId}`
        : ''

  // 思考时强制展开；思考一结束立即折叠（清掉用户在思考中点击 header 留下的"展开"状态）
  const reasoningOpen = msg.reasoningContent
    ? (isThinking || reasoningExpanded)
    : false

  // image2：设计师 LLM 输出的图像 prompt（content 字段）走折叠框，默认收起
  const [promptExpanded, setPromptExpanded] = useState(false)
  const isImage2 = msg.engineType === 'image2'

  // 思考结束的瞬间：清空展开偏好，确保 box 自动折叠（不被之前的点击残留）
  useEffect(() => {
    if (prevIsThinkingRef.current && !isThinking) {
      setReasoningExpanded(false)
    }
    prevIsThinkingRef.current = isThinking
  }, [isThinking])

  // 思考内容流式追加时自动滚底，但用户已上滚则停止跟随
  useEffect(() => {
    if (!reasoningOpen) return
    if (!isStreaming) return
    if (isUserScrolledUpRef.current) return
    const el = reasoningScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [msg.reasoningContent, reasoningOpen, isStreaming])

  // 用户在思考框内手动滚动时，判断是否已离开底部
  const handleReasoningScroll = () => {
    const el = reasoningScrollRef.current
    if (!el) return
    // 距离底部 > 8px 视为"已上滚"，停止自动跟随；滚回底部则恢复跟随
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    isUserScrolledUpRef.current = distanceFromBottom > 8
  }

  return (
    <div className="ai-message-card">
      {/* 头部 */}
      <div className="ai-msg-header">
        <span className="ai-avatar">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="ai-model-tag">{modelTag}{modelName}</span>
        <ProcessChip msg={msg} />
      </div>

      {/* 思考过程框：流式中强制展开，结束后折叠 */}
      {msg.reasoningContent && (
        <div className="ai-reasoning-box">
          <button
            className="ai-reasoning-header"
            onClick={() => setReasoningExpanded((v) => !v)}
            type="button"
          >
            <Brain className="h-3 w-3 flex-shrink-0" />
            <span className="text-xs font-medium">思考过程</span>
            <span className="ai-reasoning-toggle">
              {reasoningOpen ? '▲' : '▼'}
            </span>
          </button>
          {reasoningOpen && (
            <div
              className="ai-reasoning-content"
              ref={reasoningScrollRef}
              onScroll={handleReasoningScroll}
            >
              <pre className="whitespace-pre-wrap break-all text-xs text-muted-foreground leading-relaxed">
                {msg.reasoningContent}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 正文内容区 —— image2 的折叠 prompt 框在这里 */}
      <div className="ai-msg-body">
        {isImage2 ? (
          // image2 的 content 是设计师 LLM 设计的图像 prompt，折叠展示
          msg.content ? (
            <div className="ai-reasoning-box">
              <button
                className="ai-reasoning-header"
                onClick={() => setPromptExpanded((v) => !v)}
                type="button"
              >
                <Brain className="h-3 w-3 flex-shrink-0" />
                <span className="text-xs font-medium">图片描述</span>
                <span className="ai-reasoning-toggle">
                  {promptExpanded ? '▲' : '▼'}
                </span>
              </button>
              {promptExpanded && (
                <div className="ai-reasoning-content">
                  <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground leading-relaxed">
                    {msg.content}
                  </pre>
                </div>
              )}
            </div>
          ) : isStreaming ? (
            <p className="ai-placeholder">正在生成回复…</p>
          ) : null
        ) : msg.content ? (
          <MarkdownRenderer
            content={msg.content}
            engineType={msg.engineType}
            isStreaming={isStreaming}
            showRegenerate={showRegenerate}
            onRegenerate={onRegenerate}
          />
        ) : isStreaming ? (
          <p className="ai-placeholder">正在生成回复…</p>
        ) : null}
        {isStreaming && msg.content && (
          <span className="stream-caret" aria-hidden />
        )}
      </div>

      {/* image2 专属：生成的图片放在"图片描述"折叠框下面，作为主视觉 */}
      {isImage2 && msg.attachments?.some((a) => a.type === 'image') && (
        <div className="mt-3 space-y-2">
          {msg.attachments
            .filter((a): a is ImageAttachment => a.type === 'image')
            .map((att, idx) => (
              <a
                key={idx}
                href={att.dataUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block overflow-hidden rounded-lg border border-border bg-background"
              >
                <img
                  src={att.dataUrl}
                  alt={att.fileName}
                  className="block max-h-[480px] w-full object-contain"
                />
                <div className="border-t border-border bg-surface px-3 py-1.5 text-xs text-muted">
                  {att.fileName}
                </div>
              </a>
            ))}
        </div>
      )}
    </div>
  )
}

export function ChatPanel({ onCollapse }: ChatPanelProps = {}) {
  const [inputValue, setInputValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isProcessingFile, setIsProcessingFile] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium')
  const [image2Params, setImage2Params] = useState<Image2Params>(DEFAULT_IMAGE2_PARAMS)
  const [modelInfo, setModelInfo] = useState<{ modelId: string } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const prevMsgCountRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasHandledInitialPrompt = useRef(false)

  // 字典化 store —— ChatPanel 只看当前活跃项目的消息和流式状态
  const messages = useChatStore(selectActiveMessages)
  const isStreaming = useChatStore(selectActiveIsStreaming)
  const currentProjectId = useChatStore((s) => s.currentProjectId)
  const initialPrompt = useChatStore((s) => s.initialPrompt)
  const initialAttachments = useChatStore((s) => s.initialAttachments)
  const initialThinkingMode = useChatStore((s) => s.initialThinkingMode)
  const initialImage2Params = useChatStore((s) => s.initialImage2Params)
  const clearInitialPrompt = useChatStore((s) => s.clearInitialPrompt)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const abortStream = useChatStore((s) => s.abortStream)

  const isCanvasEmpty = useEditorStore(selectIsEmpty)
  const engineType = useEditorStore(selectEngineType)
  const { generate } = useAIGenerate()
  const { error: showError, success: showSuccess } = useToast()

  // 加载当前模型信息 —— 按 engine 区分：image2 走自己的图像模型，
  // text engines 走主 LLM（gemini/claude）
  useEffect(() => {
    const engineQuery = engineType ? `?engine=${engineType}` : ''
    fetch(`/api/model-info${engineQuery}`)
      .then((r) => r.json())
      .then((data) => setModelInfo(data))
      .catch(() => {})
  }, [engineType])

  // 思考档位默认值：仅在 ChatPanel 首次挂载时设置一次（按首页 preference 初始化），
  // 之后由用户手动切换，useEffect 不再被依赖变化触发覆盖。
  // 修 bug：旧逻辑 deps 是 [engineType, initialThinkingMode]，engineType 一变就重跑，
  // 把用户手动改过的档位又设回默认。
  const hasInitializedThinkingRef = useRef(false)
  useEffect(() => {
    if (hasInitializedThinkingRef.current) return
    hasInitializedThinkingRef.current = true
    // 首页 preference 优先；否则按默认 medium
    if (initialThinkingMode) {
      setThinkingLevel(initialThinkingMode)
    } else {
      setThinkingLevel('medium')
    }
  }, [initialThinkingMode])

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      showSuccess('已复制')
      setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1500)
    } catch (err) {
      showError('复制失败')
      console.error(err)
    }
  }

  // Auto-scroll to bottom
  useEffect(() => {
    // 历史记录批量加载（条数骤增 >1）时直接跳到底部，流式增量时平滑滚动
    const jumped = messages.length - prevMsgCountRef.current > 1
    prevMsgCountRef.current = messages.length
    messagesEndRef.current?.scrollIntoView({ behavior: jumped ? 'auto' : 'smooth' })
  }, [messages])

  // Handle initial prompt from Quick Start (Path A)
  useEffect(() => {
    if (initialPrompt && !hasHandledInitialPrompt.current && currentProjectId) {
      hasHandledInitialPrompt.current = true
      const attachmentsToSend = initialAttachments ?? undefined
      // 从首页进来时，思考档位直接用首页选择（initialThinkingMode），
      // 不依赖 ChatPanel 的 thinkingLevel state（闭包内可能还未初始化为正确值）
      const initialMode: ThinkingLevel = initialThinkingMode
      // image2 参数同步首页设置
      const initialParams = initialImage2Params ?? image2Params
      clearInitialPrompt()
      handleSend(initialPrompt, attachmentsToSend, initialMode, initialParams)
    }
  }, [initialPrompt, initialAttachments, initialThinkingMode, initialImage2Params, currentProjectId])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [inputValue])

  const handleDocumentUpload = async () => {
    const files = await selectFiles(SUPPORTED_DOCUMENT_EXTENSIONS.join(','), true)
    if (!files || files.length === 0) return

    // 先按"文档最多 5 个"截断，剩下走校验+解析
    const currentDocCount = attachments.filter(att => att.type === 'document').length
    const available = MAX_DOCUMENT_COUNT - currentDocCount
    if (available <= 0) {
      showError(`文档最多上传 ${MAX_DOCUMENT_COUNT} 个（单个 ≤1MB）`)
      return
    }
    const fileArr = Array.from(files)
    if (fileArr.length > available) {
      showError(`只能再上传 ${available} 个文档，共 ${MAX_DOCUMENT_COUNT} 个上限`)
    }
    const filesToProcess = fileArr.slice(0, available)

    setIsProcessingFile(true)
    try {
      const newAttachments: DocumentAttachment[] = []
      for (const file of filesToProcess) {
        const validation = validateDocumentFile(file)
        if (!validation.valid) {
          showError(validation.error!)
          continue
        }
        const content = await parseDocument(file)
        newAttachments.push({
          type: 'document',
          content,
          fileName: file.name,
        })
      }
      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments])
      }
    } catch (err) {
      showError('文档处理失败')
      console.error(err)
    } finally {
      setIsProcessingFile(false)
    }
  }

  const handleImageUpload = async () => {
    // 清空已有图片，保留文档附件（再次点击即替换）
    setAttachments(prev => prev.filter(att => att.type !== 'image'))

    const files = await selectFiles(SUPPORTED_IMAGE_EXTENSIONS.join(','), true)
    if (!files || files.length === 0) return

    const fileArr = Array.from(files)
    // 限制最多 1 张
    if (fileArr.length > MAX_IMAGE_COUNT) {
      showError(`图片最多上传 ${MAX_IMAGE_COUNT} 张，已取第一张`)
    }
    const filesToProcess = fileArr.slice(0, MAX_IMAGE_COUNT)

    setIsProcessingFile(true)
    try {
      const newAttachments: ImageAttachment[] = []
      for (const file of filesToProcess) {
        const validation = validateImageFile(file)
        if (!validation.valid) {
          showError(validation.error!)
          continue
        }
        const dataUrl = await readFileAsDataUrl(file)
        newAttachments.push({
          type: 'image',
          dataUrl,
          fileName: file.name,
          mimeType: file.type || 'image/png',
        })
      }
      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments])
      }
    } catch (err) {
      showError('图片处理失败')
      console.error(err)
    } finally {
      setIsProcessingFile(false)
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSend = async (
    text?: string,
    initialAtts?: Attachment[],
    // 从首页 QuickStart 进入时直接传思考档位，避免依赖闭包里未初始化的 thinkingLevel
    forceThinkingLevel?: ThinkingLevel,
    forceImage2Params?: Image2Params | null,
  ) => {
    if (!currentProjectId) return
    const message = text || inputValue.trim()
    if ((!message && attachments.length === 0 && !initialAtts?.length) || isStreaming) return

    const currentAttachments = initialAtts ?? (attachments.length > 0 ? [...attachments] : undefined)
    setInputValue('')
    setAttachments([])
    const effectiveThinking: ThinkingLevel = forceThinkingLevel ?? thinkingLevel
    const effectiveParams: Image2Params | null = forceImage2Params ?? image2Params
    await generate(
      currentProjectId,
      message,
      isCanvasEmpty,
      currentAttachments,
      effectiveThinking,
      effectiveParams,
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // 重新生成：找到最后一条用户消息并以其内容重新触发
  const handleRegenerate = async () => {
    if (isStreaming || !currentProjectId) return
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMsg) return
    await generate(
      currentProjectId,
      lastUserMsg.content,
      isCanvasEmpty,
      lastUserMsg.attachments,
      thinkingLevel,
      image2Params,
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="机灵鬼儿" className="h-8 w-8 rounded-lg object-contain" />
          <h2 className="font-medium text-primary">助手</h2>
          {/* image2 项目下 modelInfo.modelId 是中间层设计师 LLM（gemini-3.8-flash 等），
              不是真正出图的 gpt-image-2，展示出来会误导用户。这里隐藏，等后端
              /api/model-info 支持按引擎返回再补。 */}
          {modelInfo?.modelId && engineType !== 'image2' && (
            <span className="text-xs text-muted font-normal">{modelInfo.modelId}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="收起侧栏"
            onClick={onCollapse}
            className="rounded-lg border border-[#e5e7eb]"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="新建对话"
            onClick={() => currentProjectId && clearMessages(currentProjectId)}
            disabled={isStreaming || messages.length === 0}
            className="rounded-lg border border-[#e5e7eb]"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="ai-messages-scroll flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted">
            <p className="text-sm">
              描述你的需求
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`mb-4 ${msg.role === 'user' ? 'flex flex-col items-end' : 'flex flex-col items-start'}`}
            >
              {msg.role === 'assistant' ? (
                <AssistantMessageCard
                  msg={msg}
                  onRegenerate={handleRegenerate}
                  modelInfo={modelInfo}
                />
              ) : (
                <>
                  {/* 用户消息气泡 */}
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-surface">
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {msg.attachments.map((att, idx) => (
                          <div key={idx} className="text-xs opacity-80">
                            <span className="flex items-center gap-1">
                              {att.type === 'image' ? (
                                <img
                                  src={att.dataUrl}
                                  alt={att.fileName}
                                  className="h-8 w-8 rounded object-cover"
                                />
                              ) : (
                                <FileText className="h-3 w-3" />
                              )}
                              {att.fileName}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                  {/* 用户消息的复制按钮（位于消息下方） */}
                  <button
                    onClick={() => handleCopy(msg.content, msg.id)}
                    title="复制"
                    className="mt-1 flex h-6 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted transition-colors hover:bg-background hover:text-primary"
                  >
                    {copiedId === msg.id ? (
                      <Check className="h-3 w-3 text-green-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>{copiedId === msg.id ? '已复制' : '复制'}</span>
                  </button>
                </>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Attachment Preview - 消息列表下方：缩略图 / 文件名 / 移除按钮 */}
      {attachments.length > 0 && (
        <div className="border-t border-border bg-background/50 px-4 py-2">
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {attachments.map((att, idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-1.5"
              >
                {/* 左侧：缩略图（图片）或文档图标 */}
                {att.type === 'image' ? (
                  <img
                    src={att.dataUrl}
                    alt={att.fileName}
                    className="h-9 w-9 flex-shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded bg-primary/5">
                    <FileText className="h-4 w-4 text-muted" />
                  </div>
                )}
                {/* 中间：文件名 */}
                <span className="flex-1 min-w-0 truncate text-sm text-primary">
                  {att.fileName}
                </span>
                {/* 右侧：移除按钮 */}
                <button
                  onClick={() => removeAttachment(idx)}
                  title="移除附件"
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-background hover:text-primary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input Area - 优化后的大输入框设计 */}
      <div className="border-t border-border p-4">
        {/* Image2 生成参数：仅当项目引擎是 image2 时显示 */}
        {engineType === 'image2' && (
          <div className="mb-2">
            <Image2ParamsBar
              value={image2Params}
              onChange={setImage2Params}
            />
          </div>
        )}
        <div className="relative flex flex-col border border-border rounded-lg bg-background focus-within:border-primary transition-colors">
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            placeholder="输入你的消息..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-12 text-sm outline-none placeholder:text-muted disabled:opacity-50"
            style={{ minHeight: '120px', maxHeight: '200px' }}
          />

          {/* Bottom toolbar inside input */}
          <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                title="上传文档（最多 5 个，单个 ≤1MB；docx / txt / md）"
                onClick={handleDocumentUpload}
                disabled={isStreaming || isProcessingFile}
                className="h-8 w-8 rounded-lg border border-border"
              >
                <FileText className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="上传图片（最多 1 张，单个 ≤1MB，再次点击替换）"
                onClick={handleImageUpload}
                disabled={isStreaming || isProcessingFile}
                className="h-8 w-8 rounded-lg border border-border"
              >
                <ImageIcon className="h-4 w-4" />
              </Button>
              {isProcessingFile && (
                <span className="flex items-center text-xs text-muted ml-2">
                  <Loading size="sm" className="mr-1" />
                  处理中...
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <ThinkingLevelSelector
                value={thinkingLevel}
                onChange={setThinkingLevel}
                variant="compact"
                disabled={isStreaming}
              />
              <Button
                onClick={() => handleSend()}
                disabled={(!inputValue.trim() && attachments.length === 0) || isStreaming}
                size="sm"
                className="h-8 rounded-lg border border-surface/30"
              >
                <Send className="h-4 w-4 mr-1" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
