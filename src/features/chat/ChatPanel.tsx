import { useState, useRef, useEffect } from 'react'
import { Send, ImagePlus, FileText, User, Bot, X, MessageSquarePlus, Loader2, CheckCircle2 } from 'lucide-react'
import { Button, Loading } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore, selectIsEmpty } from '@/stores/editorStore'
import { useAIGenerate } from '@/hooks/useAIGenerate'
import { useToast } from '@/hooks/useToast'
import {
  validateImageFile,
  validateDocumentFile,
  fileToBase64,
  parseDocument,
  selectFiles,
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from '@/lib/fileUtils'
import type { Attachment, ImageAttachment, DocumentAttachment } from '@/types'

export function ChatPanel() {
  const [inputValue, setInputValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isProcessingFile, setIsProcessingFile] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasHandledInitialPrompt = useRef(false)

  const { messages, isStreaming, initialPrompt, initialAttachments, clearInitialPrompt, clearMessages } = useChatStore()
  const isCanvasEmpty = useEditorStore(selectIsEmpty)
  const { generate } = useAIGenerate()
  const { error: showError } = useToast()

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

  const handleImageUpload = async () => {
    const files = await selectFiles(SUPPORTED_IMAGE_TYPES.join(','))
    if (!files || files.length === 0) return

    setIsProcessingFile(true)
    try {
      const file = files[0]
      const validation = validateImageFile(file)
      if (!validation.valid) {
        showError(validation.error!)
        return
      }

      const dataUrl = await fileToBase64(file)
      const imageAttachment: ImageAttachment = {
        type: 'image',
        dataUrl,
        fileName: file.name,
      }
      setAttachments((prev) => [...prev, imageAttachment])
    } catch (err) {
      showError('图片处理失败')
      console.error(err)
    } finally {
      setIsProcessingFile(false)
    }
  }

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

  // 获取AI消息的状态显示
  const getStatusDisplay = (status: string) => {
    switch (status) {
      case 'pending':
        return { text: '等待中...', icon: <Loader2 className="h-4 w-4 animate-spin" /> }
      case 'streaming':
        return { text: '绘制中...', icon: <Loader2 className="h-4 w-4 animate-spin" /> }
      case 'complete':
        return { text: '绘制完成', icon: <CheckCircle2 className="h-4 w-4 text-green-500" /> }
      case 'error':
        return { text: '出错了', icon: <X className="h-4 w-4 text-red-500" /> }
      default:
        return { text: '处理中...', icon: <Loader2 className="h-4 w-4 animate-spin" /> }
    }
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-1">
        <div>
          <h2 className="font-medium text-primary">AI 助手</h2>
          <p className="text-xs text-muted">
            {isCanvasEmpty ? '新建图表' : '基于当前图表修改'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          title="新建对话"
          onClick={clearMessages}
          disabled={isStreaming || messages.length === 0}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted">
            <Bot className="mb-4 h-12 w-12 opacity-50" />
            <p className="text-sm">
              描述你的需求
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 mb-4 ${
                msg.role === 'user' ? 'flex-row-reverse' : ''
              }`}
            >
              {/* Avatar */}
              <div
                className={`flex h-8 w-8 flex-shrink-0 items-center justify-center ${
                  msg.role === 'user'
                    ? 'bg-primary text-surface'
                    : 'border border-border bg-surface text-primary'
                }`}
              >
                {msg.role === 'user' ? (
                  <User className="h-4 w-4" />
                ) : (
                  <Bot className="h-4 w-4" />
                )}
              </div>

              {/* Content */}
              <div
                className={`max-w-[80%] px-3 py-2 ${
                  msg.role === 'user'
                    ? 'bg-primary text-surface'
                    : 'border border-border bg-background'
                }`}
              >
                {/* Show attachments for user messages */}
                {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {msg.attachments.map((att, idx) => (
                      <div key={idx} className="text-xs opacity-80">
                        {att.type === 'image' ? (
                          <img
                            src={att.dataUrl}
                            alt={att.fileName}
                            className="max-h-20 max-w-20 object-cover border border-surface/30"
                          />
                        ) : (
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            {att.fileName}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {/* AI消息使用状态板显示 */}
                {msg.role === 'assistant' ? (
                  msg.status === 'complete' ? (
                    <div className="flex items-center gap-2">
                      {getStatusDisplay(msg.status).icon}
                      <span className="text-sm">{getStatusDisplay(msg.status).text}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {getStatusDisplay(msg.status).icon}
                      <span className="text-sm">{getStatusDisplay(msg.status).text}</span>
                    </div>
                  )
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                )}
              </div>
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
                {att.type === 'image' ? (
                  <img
                    src={att.dataUrl}
                    alt={att.fileName}
                    className="h-8 w-8 object-cover"
                  />
                ) : (
                  <>
                    <FileText className="h-3 w-3" />
                    <span className="max-w-24 truncate">{att.fileName}</span>
                  </>
                )}
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
                title="上传图片"
                onClick={handleImageUpload}
                disabled={isStreaming || isProcessingFile}
                className="h-8 w-8"
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="上传文档 (docx, txt, md)"
                onClick={handleDocumentUpload}
                disabled={isStreaming || isProcessingFile}
                className="h-8 w-8"
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
              className="h-8"
            >
              <Send className="h-4 w-4 mr-1" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
