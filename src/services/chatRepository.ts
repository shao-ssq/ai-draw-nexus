import { db } from '@/lib/db'
import type { ChatMessage } from '@/types'

/**
 * Chat History Repository
 * 按项目持久化聊天对话记录，使历史项目重新打开时能恢复对话内容。
 */
export const ChatRepository = {
  /**
   * 获取某个项目的全部聊天记录（按时间正序）
   */
  async getByProjectId(projectId: string): Promise<ChatMessage[]> {
    const record = await db.chatHistories.get(projectId)
    return record?.messages ?? []
  },

  /**
   * 保存（覆盖）某个项目的聊天记录
   */
  async save(projectId: string, messages: ChatMessage[]): Promise<void> {
    // 过滤掉仅用于流式占位、无内容的空消息，避免持久化中间态
    const persistable = messages.filter(
      (m) => m.content.trim() || m.role === 'user'
    )
    await db.chatHistories.put({
      projectId,
      messages: persistable,
      updatedAt: new Date(),
    })
  },

  /**
   * 删除某个项目的聊天记录
   */
  async deleteByProjectId(projectId: string): Promise<void> {
    await db.chatHistories.delete(projectId)
  },
}
