import { useRef, useCallback } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { usePayloadStore } from '@/stores/payloadStore'
import { VersionRepository } from '@/services/versionRepository'
import { ProjectRepository } from '@/services/projectRepository'
import {
  SYSTEM_PROMPTS,
  buildInitialPrompt,
  buildEditPrompt,
  extractCode,
} from '@/lib/promptBuilder'
import { generateThumbnail } from '@/lib/thumbnail'
import { aiService } from '@/services/aiService'
import { validateContent } from '@/lib/validators'
import { ensureMxfileWrapped } from '@/lib/drawioXml'
import { useToast } from '@/hooks/useToast'
import type { PayloadMessage, EngineType, Attachment, ContentPart } from '@/types'

// Enable streaming by default, can be configured
const USE_STREAMING = true

// Maximum retry attempts for Mermaid auto-fix
const MAX_MERMAID_FIX_ATTEMPTS = 3

// 标题截断长度
const TITLE_MAX_LENGTH = 24

/**
 * 判断是否为默认占位标题（仅这类标题会被自动改名）
 */
function isPlaceholderTitle(title: string): boolean {
  return title === '未命名' || title.startsWith('Untitled-')
}

/**
 * 从用户输入派生标题：压缩空白后截取前若干字符
 */
function deriveTitleFromInput(input: string): string {
  const cleaned = input.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.length > TITLE_MAX_LENGTH
    ? cleaned.slice(0, TITLE_MAX_LENGTH) + '…'
    : cleaned
}

/**
 * 从流式累积的 excalidraw JSON 文本中，增量提取已完整的顶层元素对象。
 * 返回一个合法的 JSON 数组字符串（仅含已完整的元素），用于流式过程中实时渲染画布。
 * 若尚无完整元素，返回 null。
 *
 * 原理：用括号深度状态机扫描，每当一个顶层 {...} 对象闭合（depth 1→0），
 * 即截取该对象子串。未写完的对象（depth 未归零）会被丢弃，保证输出可解析。
 */
function extractPartialExcalidrawArray(src: string): string | null {
  const start = src.indexOf('[')
  if (start === -1) return null
  const objs: string[] = []
  let depth = 0
  let inStr = false
  let escape = false
  let objStart = -1
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objStart !== -1) {
        objs.push(src.slice(objStart, i + 1))
        objStart = -1
      }
    }
  }
  if (objs.length === 0) return null
  return '[' + objs.join(',') + ']'
}

/**
 * Build content from text and optional document attachments.
 * 图片上传已移除：仅支持文本与文档（docx/txt/md）附件。
 * @param text - The text content
 * @param attachments - Optional user document attachments
 */
function buildMultimodalContent(
  text: string,
  attachments?: Attachment[]
): string | ContentPart[] {
  const hasAttachments = attachments && attachments.length > 0

  if (!hasAttachments) {
    return text
  }

  const parts: ContentPart[] = []

  // Add text content
  if (text) {
    parts.push({ type: 'text', text })
  }

  // Add user document attachments (append extracted text)
  for (const attachment of attachments) {
    if (attachment.type === 'document') {
      parts.push({
        type: 'text',
        text: `\n\n[Document: ${attachment.fileName}]\n${attachment.content}`,
      })
    }
  }

  return parts
}

export function useAIGenerate() {
  const {
    addMessage,
    updateMessage,
    setStreaming,
  } = useChatStore()

  const {
    currentProject,
    currentContent,
    setContent,
    setContentFromVersion,
    setLoading,
    setProject,
  } = useEditorStore()

  const { setMessages } = usePayloadStore()
  const { success, error: showError } = useToast()

  // 流式实时渲染节流：excalidraw 边生成边画，限频避免频繁 updateScene 卡顿
  const lastStreamRenderRef = useRef(0)

  /**
   * 流式累积回调：更新聊天消息内容，并对 excalidraw 增量渲染画布。
   * excalidraw 输出为 JSON 数组，每元素独占一行；此处提取已完整的元素，
   * 节流（≥250ms）写入 currentContent，让画布边生成边显示。
   */
  const handleStreamAccumulated = useCallback((
    assistantMsgId: string,
    engineType: EngineType,
    accumulated: string,
    onThinking?: (isThinking: boolean) => void
  ) => {
    updateMessage(assistantMsgId, { content: accumulated })
    if (engineType !== 'excalidraw') return
    const now = Date.now()
    if (now - lastStreamRenderRef.current < 250) return
    lastStreamRenderRef.current = now
    const partial = extractPartialExcalidrawArray(accumulated)
    if (!partial) return
    try {
      JSON.parse(partial) // 校验合法后再写入
      setContent(partial)
    } catch {
      // 仍有不完整片段，跳过本次
    }
  }, [updateMessage, setContent])

  /**
   * Generate diagram using AI with streaming support
   * @param userInput - User's description or modification request
   * @param isInitial - Whether this is initial generation (empty canvas)
   * @param attachments - Optional attachments (images or documents)
   */
  const generate = async (
    userInput: string,
    isInitial: boolean,
    attachments?: Attachment[],
    thinkingMode?: 'enabled' | 'disabled',
  ) => {
    if (!currentProject) return

    const engineType = currentProject.engineType
    const systemPrompt = SYSTEM_PROMPTS[engineType]
    // 引擎默认思考策略：全部默认 disabled。
    // 历史曾给 Excalidraw 默认 enabled，但 GLM 等兼容端点 stream+thinking 组合会触发上游 500。
    // 用户可在 UI 显式开启 thinking 切换。
    const effectiveThinking: 'enabled' | 'disabled' =
      thinkingMode ?? 'disabled'

    // 首次生成时，发送即根据用户输入自动改名（仅此一次，后续编辑不再触发）
    // 必须在 AI 调用前执行，并基于 store 最新值合并，避免被后续 setProject 覆盖
    if (isInitial && isPlaceholderTitle(currentProject.title)) {
      const derivedTitle = deriveTitleFromInput(userInput)
      if (derivedTitle) {
        await ProjectRepository.update(currentProject.id, { title: derivedTitle })
        setProject({ ...useEditorStore.getState().currentProject!, title: derivedTitle })
      }
    }

    // Add user message to UI (with attachments)
    addMessage({
      role: 'user',
      content: userInput,
      status: 'complete',
      attachments,
    })

    // Add assistant message placeholder
    const assistantMsgId = addMessage({
      role: 'assistant',
      content: '',
      status: 'streaming',
      phaseLabel: isInitial ? '正在生成图表' : '正在修改图表',
      engineType,
    })

    setStreaming(true)
    setLoading(true)
    // 重置流式渲染节流计时，每次生成独立计时
    lastStreamRenderRef.current = 0

    try {
      let finalCode: string

      if (isInitial) {
        // 暂时全都使用一步生成
        const useTwoPhase = false

        if (useTwoPhase) {
          finalCode = await twoPhaseGeneration(
            userInput,
            engineType,
            systemPrompt,
            assistantMsgId,
            attachments,
            effectiveThinking
          )
        } else {
          finalCode = await singlePhaseInitialGeneration(
            userInput,
            engineType,
            systemPrompt,
            assistantMsgId,
            attachments,
            effectiveThinking
          )
        }
      } else {
        // Single-phase for edits.
        // 不再发送缩略图：编辑 prompt 已包含完整 currentCode 源码作为上下文，
        // 且部分 Provider/模型不支持 image_url，发送缩略图会触发 400 错误。
        finalCode = await singlePhaseGeneration(
          userInput,
          currentContent,
          engineType,
          systemPrompt,
          assistantMsgId,
          attachments,
          effectiveThinking
        )
      }

      // Validate the generated content with auto-fix for Mermaid
      console.log('finalCode', finalCode)
      let validatedCode = finalCode
      let validation = await validateContent(validatedCode, engineType)

      // Auto-fix mechanism for Mermaid engine
      if (!validation.valid && engineType === 'mermaid') {
        validatedCode = await attemptMermaidAutoFix(
          validatedCode,
          validation.error || 'Unknown error',
          systemPrompt,
          assistantMsgId,
          effectiveThinking
        )
        // Re-validate after fix attempts
        validation = await validateContent(validatedCode, engineType)
      }

      if (!validation.valid) {
        throw new Error(`Invalid ${engineType} output: ${validation.error}`)
      }

      // Use the validated (possibly fixed) code
      // For drawio, the AI emits bare <mxCell> fragments (per the prompt). Wrap
      // them in <mxfile><diagram><mxGraphModel>... so drawio's setFileData and
      // our IndexedDB version store a complete single-page diagram.
      finalCode =
        engineType === 'drawio'
          ? ensureMxfileWrapped(validatedCode)
          : validatedCode

      // Update content (AI generation auto-saves, so mark as saved)
      setContentFromVersion(finalCode)

      // Update assistant message: 保留已流式输出的代码内容，仅切换状态
      const streamedContent = useChatStore
        .getState()
        .messages.find((m) => m.id === assistantMsgId)?.content
      updateMessage(assistantMsgId, {
        content: streamedContent && streamedContent.trim()
          ? streamedContent
          : '图表已生成，可在右侧画布查看或导出。',
        status: 'complete',
        phaseLabel: '绘制完成',
      })

      // Save version
      await VersionRepository.create({
        projectId: currentProject.id,
        content: finalCode,
        changeSummary: isInitial ? '初始生成' : 'AI 修改',
      })

      // Generate and save thumbnail
      // For drawio, use the registered thumbnailGetter from CanvasArea for accurate rendering
      try {
        let thumbnail: string = ''
        if (engineType === 'drawio') {
          // For drawio, wait a bit for the editor to be ready after content update
          // Then retry getting thumbnail with delay
          const getThumbnailWithRetry = async (maxRetries = 3, delay = 500): Promise<string> => {
            for (let i = 0; i < maxRetries; i++) {
              // Wait for editor to process the new content
              await new Promise(resolve => setTimeout(resolve, delay))
              // Get fresh thumbnailGetter from store
              const getter = useEditorStore.getState().thumbnailGetter
              if (getter) {
                const result = await getter()
                if (result) return result
              }
            }
            return ''
          }
          thumbnail = await getThumbnailWithRetry()
        } else {
          // Use fallback method for other engines
          thumbnail = await generateThumbnail(finalCode, engineType)
        }
        if (thumbnail) {
          await ProjectRepository.update(currentProject.id, { thumbnail })
          // Update currentProject in store so thumbnail is visible immediately
          // 基于 store 最新值合并，避免覆盖此前已更新的 title
          setProject({ ...useEditorStore.getState().currentProject!, thumbnail })
        }
      } catch (err) {
        console.error('Failed to generate thumbnail:', err)
      }

      // Update project timestamp
      await ProjectRepository.update(currentProject.id, {})

      success('图表生成成功')

    } catch (error) {
      console.error('AI generation failed:', error)
      const errMsg = error instanceof Error ? error.message : '生成失败'
      updateMessage(assistantMsgId, {
        content: `生成失败：${errMsg}`,
        status: 'error',
        phaseLabel: '出错',
      })
      showError(errMsg)
    } finally {
      setStreaming(false)
      setLoading(false)
    }
  }

  /**
   * Two-phase generation for initial creation (drawio/excalidraw)
   */
  const twoPhaseGeneration = async (
    userInput: string,
    engineType: EngineType,
    systemPrompt: string,
    assistantMsgId: string,
    attachments: Attachment[] | undefined,
    thinkingMode: 'enabled' | 'disabled'
  ): Promise<string> => {
    // Phase 1: Generate elements
    updateMessage(assistantMsgId, {
      content: '',
      status: 'streaming',
      phaseLabel: '阶段 1/2：生成元素',
      stepInfo: { current: 1, total: 2 },
    })

    const phase1Prompt = buildInitialPrompt(userInput, true, 'elements')
    const phase1Content = buildMultimodalContent(phase1Prompt, attachments)

    const phase1Messages: PayloadMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: phase1Content },
    ]

    setMessages(phase1Messages)

    let elements: string
    if (USE_STREAMING) {
      const response = await aiService.streamChat(
        phase1Messages,
        (_chunk, accumulated) => {
          updateMessage(assistantMsgId, {
            content: accumulated,
          })
        },
        thinkingMode
      )
      elements = extractCode(response, engineType)
    } else {
      const response = await aiService.chat(phase1Messages)
      elements = extractCode(response, engineType)
    }

    // Phase 2: Generate links/connections
    updateMessage(assistantMsgId, {
      content: '',
      status: 'streaming',
      phaseLabel: '阶段 2/2：生成连接',
      stepInfo: { current: 2, total: 2 },
    })

    // Phase 2 prompt (no thumbnail-as-image: image upload removed)
    const phase2Prompt = buildInitialPrompt(userInput, true, 'links', elements)
    const phase2Content = buildMultimodalContent(phase2Prompt, attachments)
    const phase2Messages: PayloadMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: phase1Content },
      { role: 'assistant', content: elements },
      { role: 'user', content: phase2Content },
    ]

    setMessages(phase2Messages)

    if (USE_STREAMING) {
      const response = await aiService.streamChat(
        phase2Messages,
        (_chunk, accumulated) => {
          updateMessage(assistantMsgId, {
            content: accumulated,
          })
        },
        thinkingMode
      )
      return extractCode(response, engineType)
    } else {
      const response = await aiService.chat(phase2Messages)
      return extractCode(response, engineType)
    }
  }

  /**
   * Single-phase generation for initial creation (mermaid)
   */
  const singlePhaseInitialGeneration = async (
    userInput: string,
    engineType: EngineType,
    systemPrompt: string,
    assistantMsgId: string,
    attachments: Attachment[] | undefined,
    thinkingMode: 'enabled' | 'disabled'
  ): Promise<string> => {
    updateMessage(assistantMsgId, {
      content: '',
      status: 'streaming',
      phaseLabel: '正在生成图表',
    })

    const prompt = buildInitialPrompt(userInput, false, undefined, undefined, engineType)
    const content = buildMultimodalContent(prompt, attachments)

    const messages: PayloadMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: content },
    ]

    setMessages(messages)

    if (USE_STREAMING) {
      // 保存原始 phaseLabel，思考结束后恢复
      const originalPhaseLabel = '正在生成图表'
      const response = await aiService.streamChat(
        messages,
        (_chunk, accumulated) => {
          handleStreamAccumulated(assistantMsgId, engineType, accumulated)
        },
        thinkingMode,
        undefined, // onComplete
        (isThinking: boolean) => {
          updateMessage(assistantMsgId, {
            phaseLabel: isThinking ? '思考中...' : originalPhaseLabel,
          })
        }
      )
      return extractCode(response, engineType)
    } else {
      const response = await aiService.chat(messages)
      return extractCode(response, engineType)
    }
  }

  /**
   * Single-phase generation for edits.
   * 编辑请求不附带缩略图：currentCode 源码已作为完整上下文，
   * 且避免对不支持 image_url 的 Provider 触发 400。
   */
  const singlePhaseGeneration = async (
    userInput: string,
    currentCode: string,
    engineType: EngineType,
    systemPrompt: string,
    assistantMsgId: string,
    attachments: Attachment[] | undefined,
    thinkingMode: 'enabled' | 'disabled'
  ): Promise<string> => {
    const editPrompt = buildEditPrompt(currentCode, userInput)
    const editContent = buildMultimodalContent(editPrompt, attachments)

    const messages: PayloadMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: editContent },
    ]

    setMessages(messages)

    if (USE_STREAMING) {
      // 保存原始 phaseLabel，思考结束后恢复
      const originalPhaseLabel = '正在修改图表'
      const response = await aiService.streamChat(
        messages,
        (_chunk, accumulated) => {
          handleStreamAccumulated(assistantMsgId, engineType, accumulated)
        },
        thinkingMode,
        undefined, // onComplete
        (isThinking: boolean) => {
          updateMessage(assistantMsgId, {
            phaseLabel: isThinking ? '思考中...' : originalPhaseLabel,
          })
        }
      )
      return extractCode(response, engineType)
    } else {
      const response = await aiService.chat(messages)
      return extractCode(response, engineType)
    }
  }

  /**
   * Attempt to auto-fix Mermaid code errors by asking AI to fix them
   */
  const attemptMermaidAutoFix = async (
    failedCode: string,
    errorMessage: string,
    systemPrompt: string,
    assistantMsgId: string,
    thinkingMode: 'enabled' | 'disabled'
  ): Promise<string> => {
    let currentCode = failedCode
    let currentError = errorMessage
    let attempts = 0

    while (attempts < MAX_MERMAID_FIX_ATTEMPTS) {
      attempts++

      updateMessage(assistantMsgId, {
        content: '',
        status: 'streaming',
        phaseLabel: `修复报错 (尝试 ${attempts}/${MAX_MERMAID_FIX_ATTEMPTS})`,
        stepInfo: { current: attempts, total: MAX_MERMAID_FIX_ATTEMPTS },
      })

      const fixPrompt = `请修复下面 Mermaid 代码中的错误，只返回修复后的代码。
      报错："""${currentError}"""
      当前代码："""${currentCode}"""`

      const messages: PayloadMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: fixPrompt },
      ]

      setMessages(messages)

      let fixedCode: string
      if (USE_STREAMING) {
        const response = await aiService.streamChat(
          messages,
          (_chunk, accumulated) => {
            updateMessage(assistantMsgId, {
              content: accumulated,
            })
          },
          thinkingMode
        )
        fixedCode = extractCode(response, 'mermaid')
      } else {
        const response = await aiService.chat(messages)
        fixedCode = extractCode(response, 'mermaid')
      }

      // Validate the fixed code
      const validation = await validateContent(fixedCode, 'mermaid')
      if (validation.valid) {
        return fixedCode
      }

      // Update for next iteration
      currentCode = fixedCode
      currentError = validation.error || 'Unknown error'
    }

    // Return the last attempted code (will be validated again in caller)
    return currentCode
  }

  return { generate }
}
