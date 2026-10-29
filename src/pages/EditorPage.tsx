import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Menu, History, Pencil, Check, X, Plus, FolderOpen, Home, Save, Download, Image, Code, FileText, PanelLeftOpen } from 'lucide-react'
import { Button, Input, Loading } from '@/components/ui'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { CanvasArea, type CanvasAreaRef } from '@/features/editor/CanvasArea'
import { VersionPanel } from '@/features/editor/VersionPanel'
import {
  useEditorStore,
  selectActiveProject,
  selectActiveContent,
  selectActiveHasUnsavedChanges,
} from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { ProjectRepository } from '@/services/projectRepository'
import { VersionRepository } from '@/services/versionRepository'
import { DraftRepository } from '@/services/draftRepository'
import { useToast } from '@/hooks/useToast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/Dropdown'
import { TooltipProvider } from '@/components/ui/Tooltip'

const DRAFT_SAVE_DELAY_MS = 500

function saveDraft(projectId: string, content: string) {
  DraftRepository.save(projectId, content).catch((error) => {
    console.error('Failed to auto-save draft:', error)
  })
}

export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [isVersionPanelOpen, setIsVersionPanelOpen] = useState(false)
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState('')
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<CanvasAreaRef>(null)
  const { success } = useToast()

  // 字典化 store —— 只取当前活跃项目的派生数据
  const currentProject = useEditorStore(selectActiveProject)
  const currentContent = useEditorStore(selectActiveContent)
  const hasUnsavedChanges = useEditorStore(selectActiveHasUnsavedChanges)
  const setProject = useEditorStore((s) => s.setProject)
  const setContent = useEditorStore((s) => s.setContent)
  const setContentFromVersion = useEditorStore((s) => s.setContentFromVersion)
  const markAsSaved = useEditorStore((s) => s.markAsSaved)
  const setCurrentProjectId = useEditorStore((s) => s.setCurrentProjectId)
  const loadForProject = useChatStore((s) => s.loadForProject)

  // Load project on mount and when projectId changes
  // 后台续跑：loadProject 不 abort 任何项目；切换时旧项目的 fetch 继续在后台跑。
  useEffect(() => {
    if (!projectId) {
      navigate('/projects')
      return
    }
    let cancelled = false
    const isCancelled = () => cancelled
    loadProject(projectId, isCancelled)
    return () => {
      cancelled = true
    }
  }, [projectId])

  const loadProject = async (id: string, isCancelled: () => boolean) => {
    setIsLoading(true)
    // 仅切视图：把 id 设为活跃项目。
    // 不调 resetEditor()、不 abort 任何后台流 —— 它们各自在字典槽里继续累积。
    setCurrentProjectId(id)
    try {
      const project = await ProjectRepository.getById(id)
      if (isCancelled()) return
      if (!project) {
        navigate('/projects')
        return
      }

      setProject(id, project)
      setEditedTitle(project.title)

      // 同时读取最近版本和自动草稿；只有更新的草稿才覆盖版本内容。
      const [latestVersion, draft] = await Promise.all([
        VersionRepository.getLatest(id),
        DraftRepository.getByProjectId(id),
      ])
      if (isCancelled()) return

      setContentFromVersion(id, latestVersion?.content ?? '')
      if (
        draft &&
        (!latestVersion || draft.updatedAt.getTime() > latestVersion.timestamp.getTime())
      ) {
        setContent(id, draft.content)
      }

      // 切换 chatStore 的活跃项目 + 加载该项目的历史对话记录
      await loadForProject(id)
    } catch (error) {
      if (isCancelled()) return
      console.error('Failed to load project:', error)
      navigate('/projects')
    } finally {
      if (!isCancelled()) setIsLoading(false)
    }
  }

  // 画布内容变化后自动保存草稿，避免高频绘制时连续写 IndexedDB。
  useEffect(() => {
    if (isLoading || !currentProject?.id) return
    const id = currentProject.id
    const timer = window.setTimeout(() => {
      saveDraft(id, currentContent)
    }, DRAFT_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [currentProject?.id, currentContent, isLoading])

  // 在防抖等待期间刷新或关闭页面时，同步备份最后一次画布内容。
  useEffect(() => {
    const flushActiveDraft = () => {
      if (isLoading) return
      const state = useEditorStore.getState()
      const id = state.currentProjectId
      if (!id) return
      const content = state.contentByProject[id]
      if (content !== undefined) DraftRepository.saveSync(id, content)
    }
    window.addEventListener('pagehide', flushActiveDraft)
    return () => window.removeEventListener('pagehide', flushActiveDraft)
  }, [isLoading])

  // 切换项目或离开编辑器时，也要保存尚未到防抖时间的最后一笔修改。
  useEffect(() => {
    if (isLoading || !currentProject?.id) return
    const id = currentProject.id
    return () => {
      const content = useEditorStore.getState().contentByProject[id]
      if (content !== undefined) saveDraft(id, content)
    }
  }, [currentProject?.id, isLoading])

  // Focus title input when editing
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [isEditingTitle])

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isMenuOpen])

  const handleNewProject = () => {
    setIsMenuOpen(false)
    navigate('/projects', { state: { openCreateDialog: true } })
  }

  const handleProjectManagement = () => {
    setIsMenuOpen(false)
    navigate('/projects')
  }

  const handleGoHome = () => {
    setIsMenuOpen(false)
    navigate('/')
  }

  const handleStartEditTitle = () => {
    if (currentProject) {
      setEditedTitle(currentProject.title)
      setIsEditingTitle(true)
    }
  }

  const handleSaveTitle = async () => {
    if (!currentProject || !editedTitle.trim()) return

    try {
      await ProjectRepository.update(currentProject.id, { title: editedTitle.trim() })
      setProject(currentProject.id, { ...currentProject, title: editedTitle.trim() })
      setIsEditingTitle(false)
      success('标题已更新')
    } catch (error) {
      console.error('Failed to update title:', error)
    }
  }

  const handleCancelEditTitle = () => {
    if (currentProject) {
      setEditedTitle(currentProject.title)
    }
    setIsEditingTitle(false)
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSaveTitle()
    } else if (e.key === 'Escape') {
      handleCancelEditTitle()
    }
  }

  const handleSaveVersion = async () => {
    if (!currentProject?.id || !currentContent) return

    try {
      await VersionRepository.create({
        projectId: currentProject.id,
        content: currentContent,
        changeSummary: '人工调整',
      })
      markAsSaved(currentProject.id)

      // Update thumbnail for engines that expose a canvas renderer
      if ((currentProject.engineType === 'drawio' || currentProject.engineType === 'diagram-design') && canvasRef.current) {
        try {
          const thumbnail = await canvasRef.current.getThumbnail()
          if (thumbnail) {
            await ProjectRepository.update(currentProject.id, { thumbnail })
          }
        } catch (err) {
          console.error('Failed to generate thumbnail:', err)
        }
      }

      success('版本已保存')
    } catch (error) {
      console.error('Failed to save version:', error)
    }
  }

  if (isLoading || !currentProject) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loading size="lg" />
      </div>
    )
  }

  return (
    <TooltipProvider>
    <div className="flex h-screen flex-col bg-background">
      {/* Toolbar */}
      <header className="relative flex h-11 items-center border-b border-border bg-surface px-4">
        {/* Left: Menu */}
        <div className="flex items-center gap-4">
          <div className="relative" ref={menuRef}>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg border border-[#e5e7eb]" onClick={() => setIsMenuOpen(!isMenuOpen)}>
              <Menu className="h-3.5 w-3.5" />
            </Button>
            {isMenuOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-40 origin-top-left rounded-xl border border-[#e5e7eb] bg-surface p-1 shadow-lg animate-in fade-in-0 zoom-in-95">
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary transition-colors hover:bg-border"
                  onClick={handleNewProject}
                >
                  <Plus className="h-4 w-4" />
                  新建项目
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary transition-colors hover:bg-border"
                  onClick={handleProjectManagement}
                >
                  <FolderOpen className="h-4 w-4" />
                  项目管理
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary transition-colors hover:bg-border"
                  onClick={handleGoHome}
                >
                  <Home className="h-4 w-4" />
                  首页
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Center: Title / Edit / Engine Type */}
        <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center">
          <div className="pointer-events-auto">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  ref={titleInputRef}
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  className="h-7 w-44 text-sm"
                />
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSaveTitle}>
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCancelEditTitle}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-medium text-primary">{currentProject.title}</h1>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    currentProject.engineType === 'excalidraw'
                      ? 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300'
                      : currentProject.engineType === 'drawio'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                        : currentProject.engineType === 'diagram-design'
                          ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200'
                          : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300'
                  }`}>
                  {currentProject.engineType === 'diagram-design' ? 'Diagram+' : currentProject.engineType.toUpperCase()}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleStartEditTitle}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="ml-auto flex items-center gap-2">
          {/* image2 引擎：单按钮直接导 JPG，不进 dropdown */}
          {currentProject.engineType === 'image2' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => canvasRef.current?.exportAsPng()}
              className="h-8 gap-1.5 rounded-lg border border-[#e5e7eb] px-2.5"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="text-[11px]">导出 JPG</span>
            </Button>
          ) : (
            /* 其它引擎：导出 dropdown（SVG / PNG / 原文件） */
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 rounded-lg border border-[#e5e7eb] px-2.5">
                  <Download className="h-3.5 w-3.5" />
                  <span className="text-[11px]">导出</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup>
                  <DropdownMenuRadioItem className='pl-2' value="svg" onClick={() => canvasRef.current?.exportAsSvg()}>
                    <Code className="mr-2 h-4 w-4" />
                    导出为 SVG
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem className='pl-2' value="png" onClick={() => canvasRef.current?.exportAsPng()}>
                    <Image className="mr-2 h-4 w-4" />
                    导出为 PNG
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem className='pl-2' value="source" onClick={() => canvasRef.current?.exportAsSource()}>
                    <FileText className="mr-2 h-4 w-4" />
                    导出原文件
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Source Code button —— image2 没有可编辑源码，仅 mermaid/excalidraw/drawio 显示 */}
          {currentProject.engineType !== 'image2' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => canvasRef.current?.toggleSourceCode()}
                className="h-8 gap-1.5 rounded-lg border border-[#e5e7eb] px-2.5"
              >
                <Code className="h-3.5 w-3.5" />
                <span className="text-[11px]">源码</span>
              </Button>

              <div className="mx-1 h-4 w-px bg-border" />
            </>
          )}

          <Button
            variant={hasUnsavedChanges ? "default" : "ghost"}
            size="sm"
            onClick={handleSaveVersion}
            disabled={!hasUnsavedChanges}
            className={`h-8 rounded-lg border px-2.5 ${hasUnsavedChanges ? 'border-surface/30' : 'border-[#e5e7eb]'}`}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            <span className="text-[11px]">保存</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsVersionPanelOpen(!isVersionPanelOpen)}
            className="h-8 rounded-lg border border-[#e5e7eb] px-2.5"
          >
            <History className="mr-1.5 h-3.5 w-3.5" />
            <span className="text-[11px]">历史版本</span>
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 gap-3 overflow-hidden bg-background p-3">
        {/* Left: Chat Panel (collapsible with width transition) */}
        <div
          className={`flex-shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition-[width] duration-300 ease-in-out ${
            isChatPanelOpen ? 'w-96' : 'w-12'
          }`}
        >
          {isChatPanelOpen ? (
            <ChatPanel onCollapse={() => setIsChatPanelOpen(false)} />
          ) : (
            <button
              onClick={() => setIsChatPanelOpen(true)}
              title="展开 AI 助手"
              className="flex h-full w-full flex-col items-center justify-start gap-2 pt-3 text-muted transition-colors hover:text-primary"
            >
              <PanelLeftOpen className="h-4 w-4" />
              <span className="writing-vertical text-[11px] tracking-widest" style={{ writingMode: 'vertical-rl' }}>
                AI 助手
              </span>
            </button>
          )}
        </div>

        {/* Center: Canvas */}
        <div className="flex-1 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
          <CanvasArea ref={canvasRef} />
        </div>

        {/* Right: Version Panel (collapsible, all engines) */}
        {isVersionPanelOpen && (
          <div className="w-64 flex-shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            <VersionPanel />
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  )
}
