import { create } from 'zustand'
import { isEmptyDrawioXml } from '@/lib/drawioXml'
import type { Project, EngineType } from '@/types'

// 缩略图获取器类型
type ThumbnailGetter = () => Promise<string>

interface EditorState {
  // 唯一全局字段
  currentProjectId: string | null
  error: string | null
  // Counter to trigger version list refresh (any project's markAsSaved bumps it)
  versionSaveCount: number

  // 各项目独立槽 —— 后台项目的 AI 生成继续累积时，画布/缩略图/getter 互不串扰
  projectById: Record<string, Project>
  contentByProject: Record<string, string>            // 当前内容（含未保存的）
  lastSavedContentByProject: Record<string, string>   // 上次保存的（用于算 hasUnsavedChanges）
  hasUnsavedChangesByProject: Record<string, boolean>
  thumbnailGetterByProject: Record<string, ThumbnailGetter>

  // Actions —— 所有项目级写入都要求传入 projectId，
  // 保证后台项目回调不会写到当前活跃项目的槽。
  setCurrentProjectId: (id: string | null) => void
  setProject: (projectId: string, project: Project) => void
  setContent: (projectId: string, content: string) => void
  setContentFromVersion: (projectId: string, content: string) => void
  markAsSaved: (projectId: string) => void
  setError: (error: string | null) => void
  setThumbnailGetter: (projectId: string, getter: ThumbnailGetter | null) => void
  // 清空所有项目槽（页面关闭 / 整体重置时用）
  reset: () => void
}

const initialState = {
  currentProjectId: null,
  error: null,
  versionSaveCount: 0,
  projectById: {},
  contentByProject: {},
  lastSavedContentByProject: {},
  hasUnsavedChangesByProject: {},
  thumbnailGetterByProject: {},
}

export const useEditorStore = create<EditorState>((set) => ({
  ...initialState,

  setCurrentProjectId: (id) => set({ currentProjectId: id }),

  setProject: (projectId, project) =>
    set((state) => ({
      projectById: { ...state.projectById, [projectId]: project },
    })),

  setContent: (projectId, content) =>
    set((state) => {
      const lastSaved = state.lastSavedContentByProject[projectId] ?? ''
      return {
        contentByProject: { ...state.contentByProject, [projectId]: content },
        hasUnsavedChangesByProject: {
          ...state.hasUnsavedChangesByProject,
          [projectId]: content !== lastSaved,
        },
      }
    }),

  setContentFromVersion: (projectId, content) =>
    set((state) => ({
      contentByProject: { ...state.contentByProject, [projectId]: content },
      lastSavedContentByProject: { ...state.lastSavedContentByProject, [projectId]: content },
      hasUnsavedChangesByProject: {
        ...state.hasUnsavedChangesByProject,
        [projectId]: false,
      },
    })),

  markAsSaved: (projectId) =>
    set((state) => {
      const currentContent = state.contentByProject[projectId] ?? ''
      return {
        lastSavedContentByProject: {
          ...state.lastSavedContentByProject,
          [projectId]: currentContent,
        },
        hasUnsavedChangesByProject: {
          ...state.hasUnsavedChangesByProject,
          [projectId]: false,
        },
        versionSaveCount: state.versionSaveCount + 1,
      }
    }),

  setError: (error) => set({ error }),

  setThumbnailGetter: (projectId, getter) =>
    set((state) => {
      const next = { ...state.thumbnailGetterByProject }
      if (getter) {
        next[projectId] = getter
      } else {
        delete next[projectId]
      }
      return { thumbnailGetterByProject: next }
    }),

  reset: () => set(initialState),
}))

// —— Selector helpers（取当前活跃项目的派生数据）——
export const selectActiveProjectId = (s: EditorState): string | null => s.currentProjectId

export const selectActiveProject = (s: EditorState): Project | null =>
  s.currentProjectId ? s.projectById[s.currentProjectId] ?? null : null

export const selectEngineType = (s: EditorState): EngineType | null =>
  selectActiveProject(s)?.engineType ?? null

export const selectActiveContent = (s: EditorState): string =>
  s.currentProjectId ? s.contentByProject[s.currentProjectId] ?? '' : ''

export const selectIsEmpty = (s: EditorState): boolean => {
  const id = s.currentProjectId
  if (!id) return true
  const content = s.contentByProject[id] ?? ''
  if (s.projectById[id]?.engineType === 'drawio') {
    return isEmptyDrawioXml(content)
  }
  return content.trim() === ''
}

export const selectActiveHasUnsavedChanges = (s: EditorState): boolean =>
  s.currentProjectId ? s.hasUnsavedChangesByProject[s.currentProjectId] ?? false : false

export const selectActiveThumbnailGetter = (s: EditorState): ThumbnailGetter | null =>
  s.currentProjectId ? s.thumbnailGetterByProject[s.currentProjectId] ?? null : null

// 兼容旧 selector 名（EditorPage / CanvasArea 用过 currentProject / currentContent）
// 保留为 alias，避免一次破坏太多文件
export const selectEngineTypeLegacy = selectEngineType