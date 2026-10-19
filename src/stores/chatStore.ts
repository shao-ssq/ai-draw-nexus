import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { ChatMessage, Attachment, ThinkingLevel, Image2Params } from '@/types'
import { ChatRepository } from '@/services/chatRepository'

interface ChatState {
  // 当前活跃项目 ID（唯一全局字段，切换视图用）
  currentProjectId: string | null
  // 各项目独立的消息槽（key: projectId）—— 后台项目继续在跑时也能各自累积
  messagesByProject: Record<string, ChatMessage[]>
  // 各项目独立的 isStreaming 槽 —— 切换项目不影响其他项目的流式状态
  streamingByProject: Record<string, boolean>
  // 各项目的 AbortController —— 用于主动停止某个项目的流式请求
  abortControllersByProject: Record<string, AbortController>
  // Quick Start 一次性信号（HomePage → ChatPanel）
  initialPrompt: string | null
  initialAttachments: Attachment[] | null
  initialThinkingMode: ThinkingLevel
  /** HomePage → ChatPanel 一次性信号：image2 引擎的生成参数 */
  initialImage2Params: Image2Params | null

  // Actions
  loadForProject: (projectId: string) => Promise<void>
  // 注意：所有消息类 action 都要求传入 projectId —— 防止后台项目的回调写到当前活跃项目的槽
  addMessage: (projectId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => string
  updateMessage: (projectId: string, id: string, data: Partial<ChatMessage>) => void
  setMessages: (projectId: string, messages: ChatMessage[]) => void
  clearMessages: (projectId: string) => void
  setStreaming: (projectId: string, streaming: boolean) => void
  abortStream: (projectId: string) => void
  abortAllStreams: () => void
  setInitialPrompt: (
    prompt: string | null,
    attachments?: Attachment[] | null,
    thinkingMode?: ThinkingLevel,
    image2Params?: Image2Params | null,
  ) => void
  clearInitialPrompt: () => void
}

// 防抖持久化：流式更新会高频触发，合并写入避免 IndexedDB 压力
// Key 按 projectId 拆开 —— 后台项目的持久化不会阻塞当前项目的
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const PERSIST_DEBOUNCE_MS = 400

function schedulePersist(projectId: string | null, messages: ChatMessage[]) {
  if (!projectId) return
  const existing = persistTimers.get(projectId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    persistTimers.delete(projectId)
    void ChatRepository.save(projectId, messages)
  }, PERSIST_DEBOUNCE_MS)
  persistTimers.set(projectId, timer)
}

function flushPersist(projectId: string, messages: ChatMessage[]) {
  const existing = persistTimers.get(projectId)
  if (existing) {
    clearTimeout(existing)
    persistTimers.delete(projectId)
  }
  void ChatRepository.save(projectId, messages)
}

export const useChatStore = create<ChatState>((set, get) => ({
  currentProjectId: null,
  messagesByProject: {},
  streamingByProject: {},
  abortControllersByProject: {},
  initialPrompt: null,
  initialAttachments: null,
  initialThinkingMode: 'medium',
  initialImage2Params: null,

  loadForProject: async (projectId) => {
    // 切视图：更新当前活跃项目
    // 关键：不主动清空 messagesByProject[projectId] —— 字典槽隔离，
    // 切到该槽时 selectActiveMessages 自动读到该项目自己的消息。
    // 如果该项目正在后台 AI 生成，槽里有累积中的 userMsg / assistantMsg，
    // 切回时必须保留它们，否则 updateMessage 找不到目标 id 会静默丢失。
    set({ currentProjectId: projectId })
    // 清掉该项目之前的持久化 timer，避免 stale 写盘
    const existing = persistTimers.get(projectId)
    if (existing) {
      clearTimeout(existing)
      persistTimers.delete(projectId)
    }
    // 如果该项目槽里已有消息（后台累积 / 之前访问过的缓存），不要从 IndexedDB 覆盖
    // ——否则会丢掉正在流式更新的消息
    const alreadyHasMessages = (get().messagesByProject[projectId]?.length ?? 0) > 0
    if (alreadyHasMessages) return

    try {
      const history = await ChatRepository.getByProjectId(projectId)
      // stale guard：异步加载期间用户可能又切了别的，仍是当前活跃项目才落槽
      if (get().currentProjectId !== projectId) return
      // 二次校验：异步期间后台可能 addMessage 创建了新消息，不能覆盖
      const stillEmpty = (get().messagesByProject[projectId]?.length ?? 0) === 0
      if (stillEmpty) {
        set((state) => ({
          messagesByProject: { ...state.messagesByProject, [projectId]: history },
        }))
      }
    } catch (err) {
      console.error('Failed to load chat history:', err)
    }
  },

  addMessage: (projectId, message) => {
    const id = uuidv4()
    const newMessage: ChatMessage = {
      ...message,
      id,
      timestamp: new Date(),
    }
    const current = get().messagesByProject[projectId] ?? []
    const messages = [...current, newMessage]
    set((state) => ({
      messagesByProject: { ...state.messagesByProject, [projectId]: messages },
    }))
    schedulePersist(projectId, messages)
    return id
  },

  updateMessage: (projectId, id, data) => {
    const current = get().messagesByProject[projectId] ?? []
    const messages = current.map((msg) =>
      msg.id === id ? { ...msg, ...data } : msg
    )
    set((state) => ({
      messagesByProject: { ...state.messagesByProject, [projectId]: messages },
    }))
    schedulePersist(projectId, messages)
  },

  setMessages: (projectId, messages) => {
    set((state) => ({
      messagesByProject: { ...state.messagesByProject, [projectId]: messages },
    }))
  },

  clearMessages: (projectId) => {
    set((state) => ({
      messagesByProject: { ...state.messagesByProject, [projectId]: [] },
    }))
    const existing = persistTimers.get(projectId)
    if (existing) {
      clearTimeout(existing)
      persistTimers.delete(projectId)
    }
    void ChatRepository.deleteByProjectId(projectId)
  },

  setStreaming: (projectId, streaming) => {
    set((state) => {
      // 已是目标状态就 no-op，避免无意义渲染
      if (state.streamingByProject[projectId] === streaming) return state
      return {
        streamingByProject: {
          ...state.streamingByProject,
          [projectId]: streaming,
        },
      }
    })
    // 流式结束时立即落盘一次，保证最后状态持久化
    if (!streaming) {
      const messages = get().messagesByProject[projectId] ?? []
      flushPersist(projectId, messages)
    }
  },

  abortStream: (projectId) => {
    const controller = get().abortControllersByProject[projectId]
    if (controller) {
      controller.abort()
    }
  },

  abortAllStreams: () => {
    const all = get().abortControllersByProject
    Object.values(all).forEach((c) => {
      try { c.abort() } catch { /* noop */ }
    })
    // 清空 controller map，防止持有已 abort 的引用
    set({ abortControllersByProject: {} })
  },

  setInitialPrompt: (prompt, attachments, thinkingMode, image2Params) =>
    set({
      initialPrompt: prompt,
      initialAttachments: attachments ?? null,
      initialThinkingMode: thinkingMode ?? 'medium',
      initialImage2Params: image2Params ?? null,
    }),

  clearInitialPrompt: () =>
    set({
      initialPrompt: null,
      initialAttachments: null,
      initialThinkingMode: 'medium',
      initialImage2Params: null,
    }),
}))

// 供测试或其他地方调用的 controller 注册 helper
export function registerAbortController(projectId: string, controller: AbortController) {
  // 如果已有同项目的 controller，先 abort（防止泄漏）
  useChatStore.setState((state) => {
    const existing = state.abortControllersByProject[projectId]
    if (existing) {
      try { existing.abort() } catch { /* noop */ }
    }
    return {
      abortControllersByProject: {
        ...state.abortControllersByProject,
        [projectId]: controller,
      },
    }
  })
}

export function unregisterAbortController(projectId: string) {
  useChatStore.setState((state) => {
    const next = { ...state.abortControllersByProject }
    delete next[projectId]
    return { abortControllersByProject: next }
  })
}

// Selector helpers —— 当前活跃项目的派生数据
export const selectActiveProjectId = (s: ChatState): string | null => s.currentProjectId
export const selectActiveMessages = (s: ChatState): ChatMessage[] =>
  (s.currentProjectId ? s.messagesByProject[s.currentProjectId] : undefined) ?? []
export const selectActiveIsStreaming = (s: ChatState): boolean =>
  s.currentProjectId ? (s.streamingByProject[s.currentProjectId] ?? false) : false