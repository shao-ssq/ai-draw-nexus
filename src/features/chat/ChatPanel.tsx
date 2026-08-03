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
  RotateCw,
} from 'lucide-react'
import { Button, Loading } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore, selectIsEmpty } from '@/stores/editorStore'
import { useAIGenerate } from '@/hooks/useAIGenerate'
import { useToast } from '@/hooks/useToast'
import {
  validateDocumentFile,
  parseDocument,
  selectFiles,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from '@/lib/fileUtils'
import { MarkdownRenderer } from './MarkdownRenderer'
import type { Attachment, DocumentAttachment, ChatMessage, EngineType } from '@/types'

const ENGINE_LABEL: Record<EngineType, string> = {
  mermaid: 'Mermaid Agent',
  excalidraw: 'Excalidraw Agent',
  drawio: 'DrawIO Agent',
}

interface ChatPanelProps {
  onCollapse?: () => void
}

function ProcessBox({ msg }: { msg: ChatMessage }) {
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
    <details className="ai-process-box" open={isActive || isError}>
      <summary className="ai-process-summary">
        {isActive ? (
          <Loader2 className="ai-spinner" />
        ) : isError ? (
          <AlertCircle className="h-3 w-3 text-red-500" />
        ) : isComplete ? (
          <CheckCircle2 className="h-3 w-3 text-green-500" />
        ) : (
          <Loader2 className="ai-spinner" />
        )}
        <span className="ai-status-text">{summaryText}</span>
        {stepInfo && (
          <span className="ai-status-badge">{stepInfo.current}/{stepInfo.total}</span>
        )}
      </summary>
    </details>
  )
}

function AssistantMessageCard({
  msg,
  onCopy,
  copied,
  onRegenerate,
}: {
  msg: ChatMessage
  onCopy: (text: string, id: string) => void
  copied: string | null
  onRegenerate: () => void
}) {
  const isStreaming = msg.status === 'streaming' || msg.status === 'pending'
  const modelTag = msg.engineType ? ENGINE_LABEL[msg.engineType] : 'AI 助手'

  return (
    <div className="ai-message-card">
      {/* 头部 */}
      <div className="ai-msg-header">
        <span className="ai-avatar">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="ai-sender">AI 助手</span>
        <span className="ai-model-tag">{modelTag}</span>
      </div>

      {/* 过程状态折叠框 */}
      <ProcessBox msg={msg} />

      {/* 正文内容区 */}
      <div className="ai-msg-body">
        {msg.content ? (
          <MarkdownRenderer content={msg.content} />
        ) : isStreaming ? (
          <p className="ai-placeholder">正在生成回复…</p>
        ) : null}
        {isStreaming && msg.content && (
          <span className="stream-caret" aria-hidden />
        )}
      </div>

      {/* 底部操作栏 */}
      {!isStreaming && msg.content && msg.status !== 'error' && (
        <div className="ai-msg-actions">
          <button
            className="ai-action-btn"
            onClick={() => onCopy(msg.content, msg.id)}
            type="button"
          >
            {copied === msg.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            <span>{copied === msg.id ? '已复制' : '复制'}</span>
          </button>
          <button className="ai-action-btn" onClick={onRegenerate} type="button">
            <RotateCw className="h-3 w-3" />
            <span>重新生成</span>
          </button>
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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasHandledInitialPrompt = useRef(false)

  const { messages, isStreaming, initialPrompt, initialAttachments, clearInitialPrompt, clearMessages } = useChatStore()
  const isCanvasEmpty = useEditorStore(selectIsEmpty)
  const { generate } = useAIGenerate()
  const { error: showError, success: showSuccess } = useToast()

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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Handle initial prompt from Quick Start (Path A)
  useEffect(() => {
    if (initialPrompt && !hasHandledInitialPrompt.current) {
      hasHandledInitialPrompt.current = true
      const attachmentsToSend = initialAttachments ?? undefined
      clearInitialPrompt()
      handleSend(initialPrompt, attachmentsToSend)
    }
  }, [initialPrompt, initialAttachments])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [inputValue])

  const handleDocumentUpload = async () => {
    const files = await selectFiles(SUPPORTED_DOCUMENT_EXTENSIONS.join(','))
    if (!files || files.length === 0) return

    setIsProcessingFile(true)
    try {
      const file = files[0]
      const validation = validateDocumentFile(file)
      if (!validation.valid) {
        showError(validation.error!)
        return
      }

      const content = await parseDocument(file)
      const docAttachment: DocumentAttachment = {
        type: 'document',
        content,
        fileName: file.name,
      }
      setAttachments((prev) => [...prev, docAttachment])
    } catch (err) {
      showError('文档处理失败')
      console.error(err)
    } finally {
      setIsProcessingFile(false)
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSend = async (text?: string, initialAtts?: Attachment[]) => {
    const message = text || inputValue.trim()
    if ((!message && attachments.length === 0 && !initialAtts?.length) || isStreaming) return

    const currentAttachments = initialAtts ?? (attachments.length > 0 ? [...attachments] : undefined)
    setInputValue('')
    setAttachments([])
    await generate(message, isCanvasEmpty, currentAttachments)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // 重新生成：找到最后一条用户消息并以其内容重新触发
  const handleRegenerate = async () => {
    if (isStreaming) return
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMsg) return
    await generate(lastUserMsg.content, isCanvasEmpty, lastUserMsg.attachments)
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="WeDraw" className="h-8 w-8 rounded-lg object-contain" />
          <h2 className="font-medium text-primary">助手</h2>
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
            onClick={clearMessages}
            disabled={isStreaming || messages.length === 0}
            className="rounded-lg border border-[#e5e7eb]"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
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
              className={`mb-4 ${msg.role === 'user' ? 'flex flex-col items-end' : 'flex justify-start'}`}
            >
              {msg.role === 'assistant' ? (
                <AssistantMessageCard
                  msg={msg}
                  onCopy={handleCopy}
                  copied={copiedId}
                  onRegenerate={handleRegenerate}
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
                              <FileText className="h-3 w-3" />
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

      {/* Attachment Preview */}
      {attachments.length > 0 && (
        <div className="border-t border-border px-4 py-2">
          <div className="flex flex-wrap gap-2">
            {attachments.map((att, idx) => (
              <div
                key={idx}
                className="relative flex items-center gap-1 border border-border bg-background px-2 py-1 text-xs"
              >
                <>
                  <FileText className="h-3 w-3" />
                  <span className="max-w-24 truncate">{att.fileName}</span>
                </>
                <button
                  onClick={() => removeAttachment(idx)}
                  className="ml-1 text-muted hover:text-primary"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input Area - 优化后的大输入框设计 */}
      <div className="border-t border-border p-4">
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
                title="上传文档 (docx, txt, md)"
                onClick={handleDocumentUpload}
                disabled={isStreaming || isProcessingFile}
                className="h-8 w-8 rounded-lg border border-border"
              >
                <FileText className="h-4 w-4" />
              </Button>
              {isProcessingFile && (
                <span className="flex items-center text-xs text-muted ml-2">
                  <Loading size="sm" className="mr-1" />
                  处理中...
                </span>
              )}
            </div>
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
  )
}
