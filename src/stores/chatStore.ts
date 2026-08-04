import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { ChatMessage, Attachment } from '@/types'
import { ChatRepository } from '@/services/chatRepository'

interface ChatState {
  // 当前关联的项目 ID（用于持久化）
  projectId: string | null
  // UI messages for display
  messages: ChatMessage[]
  // Initial prompt from Quick Start (Path A)
  initialPrompt: string | null
  // Initial attachments from Quick Start (Path A)
  initialAttachments: Attachment[] | null
  // Streaming state
  isStreaming: boolean

  // Actions
  loadForProject: (projectId: string) => Promise<void>
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => string
  updateMessage: (id: string, data: Partial<ChatMessage>) => void
  clearMessages: () => void
  setInitialPrompt: (prompt: string | null, attachments?: Attachment[] | null) => void
  clearInitialPrompt: () => void
  setStreaming: (streaming: boolean) => void
}

// 防抖持久化：流式更新会高频触发，合并写入避免 IndexedDB 压力
let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 400

function schedulePersist(projectId: string | null, messages: ChatMessage[]) {
  if (!projectId) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void ChatRepository.save(projectId, messages)
  }, PERSIST_DEBOUNCE_MS)
}

export const useChatStore = create<ChatState>((set, get) => ({
  projectId: null,
  messages: [],
  initialPrompt: null,
  initialAttachments: null,
  isStreaming: false,

  loadForProject: async (projectId) => {
    // 切换项目：先清空再加载该项目的持久化历史
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    set({ projectId, messages: [], initialPrompt: null, initialAttachments: null })
    try {
      const history = await ChatRepository.getByProjectId(projectId)
      // 仅在仍是同一项目时应用（避免快速切换竞态）
      if (get().projectId === projectId) {
        set({ messages: history })
      }
    } catch (err) {
      console.error('Failed to load chat history:', err)
    }
  },

  addMessage: (message) => {
    const id = uuidv4()
    const newMessage: ChatMessage = {
      ...message,
      id,
      timestamp: new Date(),
    }
    const messages = [...get().messages, newMessage]
    set({ messages })
    schedulePersist(get().projectId, messages)
    return id
  },

  updateMessage: (id, data) => {
    const messages = get().messages.map((msg) =>
      msg.id === id ? { ...msg, ...data } : msg
    )
    set({ messages })
    schedulePersist(get().projectId, messages)
  },

  clearMessages: () => {
    const { projectId } = get()
    set({ messages: [] })
    if (projectId) {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      void ChatRepository.deleteByProjectId(projectId)
    }
  },

  setInitialPrompt: (prompt, attachments) => set({ initialPrompt: prompt, initialAttachments: attachments ?? null }),

  clearInitialPrompt: () => set({ initialPrompt: null, initialAttachments: null }),

  setStreaming: (streaming) => {
    set({ isStreaming: streaming })
    // 流式结束时立即落盘一次，保证最后状态持久化
    if (!streaming) {
      const { projectId, messages } = get()
      if (projectId) {
        if (persistTimer) {
          clearTimeout(persistTimer)
          persistTimer = null
        }
        void ChatRepository.save(projectId, messages)
      }
    }
  },
}))
