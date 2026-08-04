import Dexie, { type EntityTable } from 'dexie'
import type { Project, VersionHistory, ChatMessage } from '@/types'

/**
 * WeDraw Database
 * Using Dexie.js for IndexedDB management
 */
interface ChatHistoryRecord {
  /** projectId 作为主键，一个项目对应一条对话记录 */
  projectId: string
  messages: ChatMessage[]
  updatedAt: Date
}

class WeDrawDB extends Dexie {
  projects!: EntityTable<Project, 'id'>
  versionHistory!: EntityTable<VersionHistory, 'id'>
  chatHistories!: EntityTable<ChatHistoryRecord, 'projectId'>

  constructor() {
    super('WeDrawDB')

    this.version(1).stores({
      // Primary key: id, indexed fields: title, engineType, createdAt, updatedAt
      projects: 'id, title, engineType, createdAt, updatedAt',
      // Primary key: id, indexed fields: projectId, timestamp
      versionHistory: 'id, projectId, timestamp',
    })

    // v2: 新增对话历史表（projectId 作为主键，按项目持久化聊天记录）
    this.version(2).stores({
      projects: 'id, title, engineType, createdAt, updatedAt',
      versionHistory: 'id, projectId, timestamp',
      chatHistories: 'projectId',
    })
  }
}

// Singleton database instance
export const db = new WeDrawDB()
