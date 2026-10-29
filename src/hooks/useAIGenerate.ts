import { useRef, useCallback } from 'react'
import { useChatStore, registerAbortController, unregisterAbortController } from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { usePayloadStore } from '@/stores/payloadStore'
import { VersionRepository } from '@/services/versionRepository'
import { ProjectRepository } from '@/services/projectRepository'
import {
  buildInitialPrompt,
  buildEditPrompt,
  extractCode,
} from '@/lib/promptBuilder'
import { generateThumbnail } from '@/lib/thumbnail'
import { aiService } from '@/services/aiService'
import { validateContent } from '@/lib/validators'
import { ensureMxfileWrapped, extractPartialDrawioCells } from '@/lib/drawioXml'
import { useToast } from '@/hooks/useToast'
import type { PayloadMessage, EngineType, Attachment, ImageAttachment, ContentPart, ThinkingLevel, Image2Params } from '@/types'

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
 * Build content from text and optional attachments.
 *
 * 文档：append 抽取后的文本
 * 图片：作为 image_url part 发出；服务端 stream-gemini.ts 会拆 dataUrl
 *   转为 Gemini 原生协议的 inline_data { mime_type, data }。
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

  // Add user attachments
  for (const attachment of attachments) {
    if (attachment.type === 'document') {
      parts.push({
        type: 'text',
        text: `\n\n[Document: ${attachment.fileName}]\n${attachment.content}`,
      })
    } else if (attachment.type === 'image') {
      // 多模态：图片作为 image_url part，由服务端翻译为 Gemini 的 inline_data
      parts.push({
        type: 'image_url',
        image_url: { url: attachment.dataUrl },
      })
    }
  }

  return parts
}

/**
 * 后台续跑：项目切换不会取消旧请求。但 generate 启动时仍要锁定 projectId，
 * 所有 store 写入都用字典 slot 路径。这样：
 * - A 在后台跑，切到 B 时 B 的 UI 完全不受 A 的影响
 * - 切回 A 时 A 的当前进度（messages / content）从字典槽读出
 */
export function useAIGenerate() {
  const {
    addMessage,
    updateMessage,
    setStreaming,
  } = useChatStore()

  const {
    setContent,
    setContentFromVersion,
    setProject,
  } = useEditorStore()

  const { setMessages } = usePayloadStore()
  const { success, error: showError } = useToast()

  // 流式实时渲染节流：excalidraw 边生成边画，限频避免频繁 updateScene 卡顿
  const lastStreamRenderRef = useRef(0)

  // reasoning 渐进显示：每帧推进若干字符，模拟"字一个字"出来
  const reasoningRafRef = useRef<number | null>(null)
  const reasoningDisplayRef = useRef('')
  const reasoningTargetRef = useRef('')
  const reasoningMsgIdRef = useRef<string | null>(null)
  const reasoningFirstRef = useRef(true)
  // 当前生成所属 projectId —— 流式回调按这个 id 写入 store，不依赖 currentProjectId
  const reasoningProjectIdRef = useRef<string | null>(null)

  // main content 渐进显示：聊天面板的代码也按 rAF 推进，避免一段一段弹出。
  const contentRafRef = useRef<number | null>(null)
  const contentDisplayRef = useRef('')
  const contentTargetRef = useRef('')
  const contentMsgIdRef = useRef<string | null>(null)
  const contentFirstRef = useRef(true)
  const contentProjectIdRef = useRef<string | null>(null)

  // 当前 generate 的 AbortController —— 用户主动 stop 或切换项目（如果未来要 abort）时调用
  const currentAbortRef = useRef<AbortController | null>(null)

  // main content 渐进 tick：每帧推进 ~1/10 剩余字符
  const tickContent = useCallback(() => {
    contentRafRef.current = null
    const target = contentTargetRef.current
    const displayed = contentDisplayRef.current
    if (target === displayed) return
    const remaining = target.length - displayed.length
    const step = Math.min(remaining, Math.max(1, Math.ceil(remaining / 10)))
    contentDisplayRef.current = target.slice(0, displayed.length + step)
    if (contentMsgIdRef.current && contentProjectIdRef.current) {
      updateMessage(contentProjectIdRef.current, contentMsgIdRef.current, {
        content: contentDisplayRef.current,
      })
    }
    if (contentDisplayRef.current !== target) {
      contentRafRef.current = requestAnimationFrame(tickContent)
    }
  }, [updateMessage])

  // 写入新 chunk：首段直显避免空白卡顿，后续段 rAF 渐进
  const handleContentChunk = useCallback((projectId: string, assistantMsgId: string, accumulated: string) => {
    contentMsgIdRef.current = assistantMsgId
    contentProjectIdRef.current = projectId
    contentTargetRef.current = accumulated
    if (contentFirstRef.current) {
      contentFirstRef.current = false
      contentDisplayRef.current = accumulated
      updateMessage(projectId, assistantMsgId, { content: accumulated })
      return
    }
    if (contentRafRef.current === null) {
      contentRafRef.current = requestAnimationFrame(tickContent)
    }
  }, [tickContent, updateMessage])

  /**
   * 流式累积回调：聊天面板走 typewriter（rAF 渐进），画布用真实 partial 增量。
   * projectId 锁定：所有 store 写入都用这个 id，不受 currentProjectId 影响。
   */
  const handleStreamAccumulated = useCallback((
    projectId: string,
    assistantMsgId: string,
    engineType: EngineType,
    accumulated: string,
  ) => {
    handleContentChunk(projectId, assistantMsgId, accumulated)
    if (engineType !== 'excalidraw' && engineType !== 'drawio') return

    const now = Date.now()
    const renderInterval = engineType === 'drawio' ? 400 : 250
    if (now - lastStreamRenderRef.current < renderInterval) return

    if (engineType === 'drawio') {
      // 只渲染已经闭合的 mxCell，最后一个尚未写完的标签不会进入画布。
      const partial = extractPartialDrawioCells(accumulated)
      if (!partial) return
      lastStreamRenderRef.current = now
      setContent(projectId, ensureMxfileWrapped(partial))
      return
    }

    lastStreamRenderRef.current = now
    const partial = extractPartialExcalidrawArray(accumulated)
    if (!partial) return
    try {
      JSON.parse(partial) // 校验合法后再写入
      setContent(projectId, partial)
    } catch {
      // 仍有不完整片段，跳过本次
    }
  }, [handleContentChunk, setContent])

  // reasoning 内容渐进显示
  const tickReasoning = useCallback(() => {
    reasoningRafRef.current = null
    const target = reasoningTargetRef.current
    const displayed = reasoningDisplayRef.current
    if (target === displayed) return
    const remaining = target.length - displayed.length
    const step = Math.min(remaining, Math.max(1, Math.ceil(remaining / 10)))
    reasoningDisplayRef.current = target.slice(0, displayed.length + step)
    if (reasoningMsgIdRef.current && reasoningProjectIdRef.current) {
      updateMessage(reasoningProjectIdRef.current, reasoningMsgIdRef.current, {
        reasoningContent: reasoningDisplayRef.current,
      })
    }
    if (reasoningDisplayRef.current !== target) {
      reasoningRafRef.current = requestAnimationFrame(tickReasoning)
    }
  }, [updateMessage])

  // reasoning 收到 chunk
  const handleReasoningChunk = useCallback((projectId: string, assistantMsgId: string, accumulated: string) => {
    reasoningMsgIdRef.current = assistantMsgId
    reasoningProjectIdRef.current = projectId
    reasoningTargetRef.current = accumulated
    if (reasoningFirstRef.current) {
      reasoningFirstRef.current = false
      reasoningDisplayRef.current = accumulated
      updateMessage(projectId, assistantMsgId, { reasoningContent: accumulated })
      return
    }
    if (reasoningRafRef.current === null) {
      reasoningRafRef.current = requestAnimationFrame(tickReasoning)
    }
  }, [tickReasoning, updateMessage])

  /**
   * Generate diagram using AI with streaming support
   *
   * 关键：projectId 在调用入口处确定，整个生命周期内所有 store 写入都用这个 id。
   * 即使中途用户在 ProjectsPage 切换了其他项目、当前项目不再是 currentProjectId，
   * 本次 generate 也会继续在后台跑并写到自己 projectId 的槽里。
   */
  const generate = async (
    projectId: string,
    userInput: string,
    isInitial: boolean,
    attachments?: Attachment[],
    thinkingMode?: ThinkingLevel,
    image2Params?: Image2Params | null,
  ) => {
    const project = useEditorStore.getState().projectById[projectId]
    if (!project) {
      console.error(`[useAIGenerate] project ${projectId} not found`)
      return
    }

    // 锁定 projectId —— 后续所有 store 写入都用这个值，不依赖 currentProjectId
    const myProjectId = projectId
    const engineType = project.engineType
    const currentContent = useEditorStore.getState().contentByProject[myProjectId] ?? ''

    // 引擎默认思考策略：默认 medium（适合 Gemini）。
    const effectiveThinking: ThinkingLevel = thinkingMode ?? 'medium'

    // 创建 AbortController 并注册 —— 用户主动 stop 时可调用 currentAbortRef.current?.abort()
    const abortController = new AbortController()
    currentAbortRef.current = abortController
    registerAbortController(myProjectId, abortController)

    // 首次生成时，发送即根据用户输入自动改名（仅此一次，后续编辑不再触发）
    if (isInitial && isPlaceholderTitle(project.title)) {
      const derivedTitle = deriveTitleFromInput(userInput)
      if (derivedTitle) {
        try {
          await ProjectRepository.update(myProjectId, { title: derivedTitle })
          setProject(myProjectId, { ...project, title: derivedTitle })
        } catch (err) {
          console.error('Failed to update title:', err)
        }
      }
    }

    // Add user message to UI (with attachments) —— 写到 myProjectId 的槽
    addMessage(myProjectId, {
      role: 'user',
      content: userInput,
      status: 'complete',
      attachments,
    })

    // Add assistant message placeholder
    const assistantMsgId = addMessage(myProjectId, {
      role: 'assistant',
      content: '',
      status: 'streaming',
      phaseLabel: isInitial ? '正在生成图表' : '正在修改图表',
      engineType,
    })

    setStreaming(myProjectId, true)
    // 重置流式渲染节流计时，每次生成独立计时
    lastStreamRenderRef.current = 0
    // 重置 reasoning 渐进显示状态
    reasoningFirstRef.current = true
    reasoningDisplayRef.current = ''
    reasoningTargetRef.current = ''
    reasoningProjectIdRef.current = myProjectId
    if (reasoningRafRef.current !== null) {
      cancelAnimationFrame(reasoningRafRef.current)
      reasoningRafRef.current = null
    }
    // 重置 main content 渐进显示状态
    contentFirstRef.current = true
    contentDisplayRef.current = ''
    contentTargetRef.current = ''
    contentProjectIdRef.current = myProjectId
    if (contentRafRef.current !== null) {
      cancelAnimationFrame(contentRafRef.current)
      contentRafRef.current = null
    }

    try {
      let finalCode: string

      // image2 是图像生成引擎：两步链路 —— 设计师 LLM → gpt-image-2
      //   1) /api/chat?engine=image2 会注入 SYSTEM_PROMPTS.image2，
      //      让设计师 LLM 把用户需求翻译成图像模型用的 prompt；
      //      第二轮起会把"当前画布上的图"也作为 image_url 喂给 Gemini，
      //      让它看到上一版长什么样，按"再亮一点"这种编辑指令设计合理的新 prompt。
      //   2) 把那段 prompt 原封不动 POST 给 /api/generate-image（gpt-image-2），
      //      拿回 base64 data URL 当 content。每轮都重画，不走 in-place edits 端点。
      if (engineType === 'image2') {
        await generateImage2(
          myProjectId,
          userInput,
          assistantMsgId,
          attachments,
          image2Params ?? null,
          currentContent,
          abortController.signal,
        )
        return
      }

      if (isInitial) {
        // 暂时全都使用一步生成
        const useTwoPhase = false

        if (useTwoPhase) {
          finalCode = await twoPhaseGeneration(
            myProjectId,
            userInput,
            engineType,
            assistantMsgId,
            attachments,
            effectiveThinking,
            abortController.signal,
          )
        } else {
          finalCode = await singlePhaseInitialGeneration(
            myProjectId,
            userInput,
            engineType,
            assistantMsgId,
            attachments,
            effectiveThinking,
            abortController.signal,
          )
        }
      } else {
        // 编辑模式：不附带缩略图（currentCode 源码已作为完整上下文）
        finalCode = await singlePhaseGeneration(
          myProjectId,
          userInput,
          currentContent,
          engineType,
          assistantMsgId,
          attachments,
          effectiveThinking,
          abortController.signal,
        )
      }

      // Validate the generated content with auto-fix for Mermaid
      console.log('finalCode', finalCode)
      let validatedCode = finalCode
      let validation = await validateContent(validatedCode, engineType)

      // Auto-fix mechanism for Mermaid engine
      if (!validation.valid && engineType === 'mermaid') {
        validatedCode = await attemptMermaidAutoFix(
          myProjectId,
          validatedCode,
          validation.error || 'Unknown error',
          assistantMsgId,
          effectiveThinking,
          abortController.signal,
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
      setContentFromVersion(myProjectId, finalCode)

      // 流式结束：取消 main content 的 rAF 渐进，强制把 finalCode 写进聊天面板。
      if (contentRafRef.current !== null) {
        cancelAnimationFrame(contentRafRef.current)
        contentRafRef.current = null
      }
      contentDisplayRef.current = finalCode
      contentTargetRef.current = finalCode

      // Update assistant message: 写入最终代码（与画布一致），切换状态
      updateMessage(myProjectId, assistantMsgId, {
        content: finalCode && finalCode.trim()
          ? finalCode
          : '图表已生成，可在右侧画布查看或导出。',
        status: 'complete',
        phaseLabel: '绘制完成',
      })

      // Save version
      await VersionRepository.create({
        projectId: myProjectId,
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
              // Get fresh thumbnailGetter for THIS project (按 projectId 查字典)
              const getter = useEditorStore.getState().thumbnailGetterByProject[myProjectId]
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
          await ProjectRepository.update(myProjectId, { thumbnail })
          // Update project in store (按 projectId 写)
          const previous = useEditorStore.getState().projectById[myProjectId]
          if (previous) {
            setProject(myProjectId, { ...previous, thumbnail })
          }
        }
      } catch (err) {
        console.error('Failed to generate thumbnail:', err)
      }

      // Update project timestamp
      await ProjectRepository.update(myProjectId, {})

      success('图表生成成功')

    } catch (error) {
      // AbortError 不显示错误 —— 是用户主动取消或组件卸载
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }
      console.error('AI generation failed:', error)
      const errMsg = error instanceof Error ? error.message : '生成失败'
      updateMessage(myProjectId, assistantMsgId, {
        content: `生成失败：${errMsg}`,
        status: 'error',
        phaseLabel: '出错',
      })
      showError(errMsg)
    } finally {
      // 流式结束清理 —— 只关 myProjectId 的 streaming 状态
      setStreaming(myProjectId, false)
      // 注销 controller —— 只对当前正在跑的那个；如果已经被新 generate 接管，不要碰
      if (currentAbortRef.current === abortController) {
        currentAbortRef.current = null
      }
      unregisterAbortController(myProjectId)
    }
  }

  /**
   * Two-phase generation for initial creation (drawio/excalidraw)
   */
  const twoPhaseGeneration = async (
    projectId: string,
    userInput: string,
    engineType: EngineType,
    assistantMsgId: string,
    attachments: Attachment[] | undefined,
    thinkingMode: ThinkingLevel,
    signal: AbortSignal,
  ): Promise<string> => {
    // Phase 1: Generate elements
    updateMessage(projectId, assistantMsgId, {
      content: '',
      status: 'streaming',
      phaseLabel: '阶段 1/2：生成元素',
      stepInfo: { current: 1, total: 2 },
    })

    const phase1Prompt = buildInitialPrompt(userInput, true, 'elements')
    const phase1Content = buildMultimodalContent(phase1Prompt, attachments)

    // 注意：不再发送 system prompt——服务端会按 engine 注入。
    const phase1Messages: PayloadMessage[] = [
      { role: 'user', content: phase1Content },
    ]

    setMessages(phase1Messages)

    let elements: string
    if (USE_STREAMING) {
      const response = await aiService.streamChat(
        phase1Messages,
        engineType,
        (_chunk, accumulated) => {
          updateMessage(projectId, assistantMsgId, {
            content: accumulated,
          })
        },
        thinkingMode,
        undefined,
        undefined,
        undefined,
        signal,
      )
      elements = extractCode(response, engineType)
    } else {
      const response = await aiService.chat(phase1Messages, engineType)
      elements = extractCode(response, engineType)
    }

    // Phase 2: Generate links/connections
    updateMessage(projectId, assistantMsgId, {
      content: '',
      status: 'streaming',
      phaseLabel: '阶段 2/2：生成连接',
      stepInfo: { current: 2, total: 2 },
    })

    // Phase 2 prompt (no thumbnail-as-image: image upload removed)
    const phase2Prompt = buildInitialPrompt(userInput, true, 'links', elements)
    const phase2Content = buildMultimodalContent(phase2Prompt, attachments)
    const phase2Messages: PayloadMessage[] = [
      { role: 'user', content: phase1Content },
      { role: 'assistant', content: elements },
      { role: 'user', content: phase2Content },
    ]

    setMessages(phase2Messages)

    if (USE_STREAMING) {
      const response = await aiService.streamChat(
        phase2Messages,
        engineType,
        (_chunk, accumulated) => {
          updateMessage(projectId, assistantMsgId, {
            content: accumulated,
          })
        },
        thinkingMode,
        undefined,
        undefined,
        undefined,
        signal,
      )
      return extractCode(response, engineType)
    } else {
      const response = await aiService.chat(phase2Messages, engineType)
      return extractCode(response, engineType)
    }
  }

  /**
   * Single-phase generation for initial creation (mermaid)
   */
  const singlePhaseInitialGeneration = async (
    projectId: string,
    userInput: string,
    engineType: EngineType,
    assistantMsgId: string,
    attachments: Attachment[] | undefined,
    thinkingMode: ThinkingLevel,
    signal: AbortSignal,
  ): Promise<string> => {
    updateMessage(projectId, assistantMsgId, {
      content: '',
      status: 'streaming',
      phaseLabel: '正在生成图表',
    })

    const prompt = buildInitialPrompt(userInput, false, undefined, undefined, engineType)
    const content = buildMultimodalContent(prompt, attachments)

    // 注意：不再发送 system prompt——服务端会按 engine 注入。
    const messages: PayloadMessage[] = [
      { role: 'user', content: content },
    ]

    setMessages(messages)

    if (USE_STREAMING) {
      // 保存原始 phaseLabel，思考结束后恢复
      const originalPhaseLabel = '正在生成图表'
      const response = await aiService.streamChat(
        messages,
        engineType,
        (_chunk, accumulated) => {
          handleStreamAccumulated(projectId, assistantMsgId, engineType, accumulated)
        },
        thinkingMode,
        undefined, // onComplete
        (isThinking: boolean) => {
          updateMessage(projectId, assistantMsgId, {
            phaseLabel: isThinking ? '思考中...' : originalPhaseLabel,
          })
        },
        (_chunk: string, reasoningAccumulated: string) => {
          handleReasoningChunk(projectId, assistantMsgId, reasoningAccumulated)
        },
        signal,
      )
      return extractCode(response, engineType)
    } else {
      const response = await aiService.chat(messages, engineType)
      return extractCode(response, engineType)
    }
  }

  /**
   * Single-phase generation for edits.
   */
  const singlePhaseGeneration = async (
    projectId: string,
    userInput: string,
    currentCode: string,
    engineType: EngineType,
    assistantMsgId: string,
    attachments: Attachment[] | undefined,
    thinkingMode: ThinkingLevel,
    signal: AbortSignal,
  ): Promise<string> => {
    const editPrompt = buildEditPrompt(currentCode, userInput)
    const editContent = buildMultimodalContent(editPrompt, attachments)

    const messages: PayloadMessage[] = [
      { role: 'user', content: editContent },
    ]

    setMessages(messages)

    if (USE_STREAMING) {
      const originalPhaseLabel = '正在修改图表'
      const response = await aiService.streamChat(
        messages,
        engineType,
        (_chunk, accumulated) => {
          handleStreamAccumulated(projectId, assistantMsgId, engineType, accumulated)
        },
        thinkingMode,
        undefined,
        (isThinking: boolean) => {
          updateMessage(projectId, assistantMsgId, {
            phaseLabel: isThinking ? '思考中...' : originalPhaseLabel,
          })
        },
        (_chunk: string, reasoningAccumulated: string) => {
          handleReasoningChunk(projectId, assistantMsgId, reasoningAccumulated)
        },
        signal,
      )
      return extractCode(response, engineType)
    } else {
      const response = await aiService.chat(messages, engineType)
      return extractCode(response, engineType)
    }
  }

  /**
   * Attempt to auto-fix Mermaid code errors by asking AI to fix them
   */
  const attemptMermaidAutoFix = async (
    projectId: string,
    failedCode: string,
    errorMessage: string,
    assistantMsgId: string,
    thinkingMode: ThinkingLevel,
    signal: AbortSignal,
  ): Promise<string> => {
    let currentCode = failedCode
    let currentError = errorMessage
    let attempts = 0

    while (attempts < MAX_MERMAID_FIX_ATTEMPTS) {
      attempts++

      updateMessage(projectId, assistantMsgId, {
        content: '',
        status: 'streaming',
        phaseLabel: `修复报错 (尝试 ${attempts}/${MAX_MERMAID_FIX_ATTEMPTS})`,
        stepInfo: { current: attempts, total: MAX_MERMAID_FIX_ATTEMPTS },
      })

      const fixPrompt = `请修复下面 Mermaid 代码中的错误，只返回修复后的代码。
      报错："""${currentError}"""
      当前代码："""${currentCode}"""`

      const messages: PayloadMessage[] = [
        { role: 'user', content: fixPrompt },
      ]

      setMessages(messages)

      let fixedCode: string
      if (USE_STREAMING) {
        const response = await aiService.streamChat(
          messages,
          'mermaid',
          (_chunk, accumulated) => {
            updateMessage(projectId, assistantMsgId, {
              content: accumulated,
            })
          },
          thinkingMode,
          undefined,
          undefined,
          undefined,
          signal,
        )
        fixedCode = extractCode(response, 'mermaid')
      } else {
        const response = await aiService.chat(messages, 'mermaid')
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

    return currentCode
  }

  /**
   * image2 生成链路：设计师 LLM（流式） → gpt-image-2
   *
   *   1) /api/chat?engine=image2 — 服务端注入 SYSTEM_PROMPTS.image2（drawing-prompt designer）
   *      流式返回：thinking 走 reasoningContent、最终 prompt 走 content。
   *      用户在 ChatPanel 看到"思考中"折叠框 + 设计的 prompt 字符级展开。
   *      第二轮起把"当前画布上的图"也作为 image_url 喂给 Gemini，让设计师看到上一版，
   *      按"再亮一点"这种编辑指令输出合理新 prompt。**仍然走 generations 端点重新出图**。
   *   2) /api/generate-image — 用流式累积的 prompt POST 出去，gpt-image-2 返回 base64 data URL
   *   3) content 保留设计的 prompt（流式累积结果），dataUrl 走 attachments 让 ChatPanel 渲染
   */
  const generateImage2 = async (
    projectId: string,
    userInput: string,
    assistantMsgId: string,
    attachments: Attachment[] | undefined,
    image2Params: Image2Params | null,
    currentContent: string,
    signal: AbortSignal,
  ) => {
    const myProjectId = projectId

    if (signal.aborted) return

    // Step 1: 设计师 LLM（流式） —— 把用户需求翻译成图像模型用的 prompt
    // 参考图作为 image_url parts 一起发，遵循 system prompt 里
    // "when images are attached, name the traits to carry over" 这条。
    //
    // 第二轮起：currentContent（当前画布上的图）也作为 image_url 喂给设计师，
    // 让 Gemini 看到上一版长什么样，按"再亮一点"这种编辑指令输出合理的新 prompt。
    const referenceImages = (attachments ?? []).filter(
      (a): a is ImageAttachment => a.type === 'image',
    )
    const previousImage: ContentPart[] = currentContent.startsWith('data:image/')
      ? [{ type: 'image_url', image_url: { url: currentContent } }]
      : []
    const designerContent: ContentPart[] = [
      { type: 'text', text: buildInitialPrompt(userInput, false, undefined, undefined, 'image2') },
      ...previousImage,
      ...referenceImages.map<ContentPart>((img) => ({
        type: 'image_url',
        image_url: { url: img.dataUrl },
      })),
    ]
    const designerMessages: PayloadMessage[] = [
      { role: 'user', content: designerContent },
    ]

    // 复用文本引擎的 rAF 平滑显示 —— handleContentChunk / handleReasoningChunk
    // 内部走 store update + requestAnimationFrame 节流，体验跟 mermaid/drawio 一致
    const designerThinkingText = '正在设计图像 prompt'

    // 流式调用设计师 LLM；累积的 final content 就是 prompt 全文
    const rawPrompt = await aiService.streamChat(
      designerMessages,
      'image2',
      (_chunk, accumulated) => {
        handleContentChunk(myProjectId, assistantMsgId, accumulated)
      },
      'medium', // thinking 默认档位（gemini 不支持 low/high 之外的精细控制；image2 不需要思考过程）
      undefined,
      (isThinking) => {
        // 思考 → 设计 prompt → 生成图片：phaseLabel 跟着切换
        updateMessage(myProjectId, assistantMsgId, {
          phaseLabel: isThinking ? '思考中...' : designerThinkingText,
        })
      },
      (_chunk, accumulated) => {
        handleReasoningChunk(myProjectId, assistantMsgId, accumulated)
      },
      signal,
    )
    if (signal.aborted) return

    // 兜底：剥离 LLM 偶发的 markdown 代码块包裹
    const designedPrompt = rawPrompt
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/\n?```$/, '')
      .trim()

    if (!designedPrompt) {
      throw new Error('设计师 LLM 未返回有效 prompt')
    }

    // Step 2: gpt-image-2 —— POST 给后端 /api/generate-image
    updateMessage(myProjectId, assistantMsgId, {
      phaseLabel: '正在生成图像',
    })
    const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api'
    const response = await fetch(`${API_BASE_URL}/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: designedPrompt,
        referenceImages: attachments
          ?.filter((a): a is ImageAttachment => a.type === 'image')
          .map((a) => ({ mimeType: a.mimeType, dataUrl: a.dataUrl })),
        params: {
          aspectRatio: image2Params?.aspectRatio ?? '1:1',
          resolution: image2Params?.resolution ?? '1k',
          quality: image2Params?.quality ?? 'medium',
        },
      }),
      signal,
    })

    if (signal.aborted) return

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`图片生成失败（${response.status}）：${errText || response.statusText}`)
    }

    const { dataUrl } = (await response.json()) as { dataUrl: string }
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      throw new Error('后端返回的 dataUrl 格式无效')
    }

    // Step 3: 与其它引擎同路径 —— 写 content / version / thumbnail / 时间戳
    setContentFromVersion(myProjectId, dataUrl)

    // 助手消息：content 保留设计的 prompt（流式累积结果），
    // dataUrl 放进 attachments 让 ChatPanel 走现有图片附件渲染。
    const generatedAt = new Date()
    const ratio = image2Params?.aspectRatio ?? '1:1'
    const res = image2Params?.resolution ?? '1k'
    const fileName = `image2-${ratio.replace(':', 'x')}-${res}-${generatedAt.toISOString().replace(/[:.]/g, '-')}.png`
    updateMessage(myProjectId, assistantMsgId, {
      attachments: [
        {
          type: 'image',
          dataUrl,
          fileName,
          mimeType: 'image/png',
        },
      ],
      status: 'complete',
      phaseLabel: '绘制完成',
    })

    await VersionRepository.create({
      projectId: myProjectId,
      content: dataUrl,
      changeSummary: '初始生成',
    })

    try {
      const getter = useEditorStore.getState().thumbnailGetterByProject[myProjectId]
      const thumbnail = getter ? await getter() : dataUrl
      if (thumbnail) {
        await ProjectRepository.update(myProjectId, { thumbnail })
        const previous = useEditorStore.getState().projectById[myProjectId]
        if (previous) {
          setProject(myProjectId, { ...previous, thumbnail })
        }
      }
    } catch (err) {
      console.error('[image2] Failed to save thumbnail:', err)
    }

    await ProjectRepository.update(myProjectId, {})
    success('图片已生成')
  }

  return { generate }
}