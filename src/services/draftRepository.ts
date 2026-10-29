import { db } from '@/lib/db'
import type { ProjectDraft } from '@/types'

const EMERGENCY_DRAFT_PREFIX = 'wedraw:draft:'

interface EmergencyDraftRecord {
  projectId: string
  content: string
  updatedAt: string
}

function getEmergencyDraft(projectId: string): ProjectDraft | undefined {
  try {
    const raw = localStorage.getItem(EMERGENCY_DRAFT_PREFIX + projectId)
    if (!raw) return undefined
    const record = JSON.parse(raw) as EmergencyDraftRecord
    const updatedAt = new Date(record.updatedAt)
    if (
      record.projectId !== projectId ||
      typeof record.content !== 'string' ||
      Number.isNaN(updatedAt.getTime())
    ) {
      return undefined
    }
    return { projectId, content: record.content, updatedAt }
  } catch {
    return undefined
  }
}

/**
 * 每个项目只保留一份最新草稿，用于刷新或异常关闭后的内容恢复。
 * 历史版本仍由用户手动保存或 AI 生成完成时创建。
 */
export const DraftRepository = {
  async getByProjectId(projectId: string): Promise<ProjectDraft | undefined> {
    const draft = await db.drafts.get(projectId)
    const emergencyDraft = getEmergencyDraft(projectId)
    if (
      emergencyDraft &&
      (!draft || emergencyDraft.updatedAt.getTime() > draft.updatedAt.getTime())
    ) {
      return emergencyDraft
    }
    return draft
  },

  async save(projectId: string, content: string): Promise<ProjectDraft> {
    const draft: ProjectDraft = {
      projectId,
      content,
      updatedAt: new Date(),
    }
    await db.drafts.put(draft)
    return draft
  },

  // pagehide 中异步 IndexedDB 写入不保证完成，同步备份用于保住最后一笔修改。
  saveSync(projectId: string, content: string): void {
    try {
      const record: EmergencyDraftRecord = {
        projectId,
        content,
        updatedAt: new Date().toISOString(),
      }
      localStorage.setItem(EMERGENCY_DRAFT_PREFIX + projectId, JSON.stringify(record))
    } catch (error) {
      // 超大内容可能超出 localStorage 配额，此时仍保留 IndexedDB 自动草稿。
      console.error('Failed to save emergency draft:', error)
    }
  },

  removeEmergency(projectId: string): void {
    try {
      localStorage.removeItem(EMERGENCY_DRAFT_PREFIX + projectId)
    } catch {
      // 存储不可用时无需阻止项目删除。
    }
  },
}
