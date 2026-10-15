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
import { ensureMxfileWrapped } from '@/lib/drawioXml'
import { useToast } from '@/hooks/useToast'
import type { PayloadMessage, EngineType, Attachment, ContentPart, ThinkingLevel } from '@/types'

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
   * 流式累积回调：聊天面板走 typewriter（rAF 渐进），excalidraw 画布仍用真实 partial 增量。
   * projectId 锁定：所有 store 写入都用这个 id，不受 currentProjectId 影响。
   */
  const handleStreamAccumulated = useCallback((
    projectId: string,
    assistantMsgId: string,
    engineType: EngineType,
    accumulated: string,
  ) => {
    handleContentChunk(projectId, assistantMsgId, accumulated)
    // excalidraw 画布用真实 partial（extractPartialExcalidrawArray 提取完整元素）
    if (engineType !== 'excalidraw') return
    const now = Date.now()
    if (now - lastStreamRenderRef.current < 250) return
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

  return { generate }
}