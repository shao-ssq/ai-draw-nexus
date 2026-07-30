import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Menu, History, Pencil, Check, X, Plus, FolderOpen, Home, Save, Download, Image, Code, FileText, PanelLeftOpen } from 'lucide-react'
import { Button, Input, Loading } from '@/components/ui'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { CanvasArea, type CanvasAreaRef } from '@/features/editor/CanvasArea'
import { VersionPanel } from '@/features/editor/VersionPanel'
import { useEditorStore } from '@/stores/editorStore'
import { useChatStore } from '@/stores/chatStore'
import { ProjectRepository } from '@/services/projectRepository'
import { VersionRepository } from '@/services/versionRepository'
import { useToast } from '@/hooks/useToast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/Dropdown'
import { TooltipProvider } from '@/components/ui/Tooltip'

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

  const { currentProject, currentContent, hasUnsavedChanges, setProject, setContentFromVersion, markAsSaved, reset: resetEditor } = useEditorStore()
  const { clearMessages } = useChatStore()

  // Load project on mount
  useEffect(() => {
    if (!projectId) {
      navigate('/projects')
      return
    }

    loadProject(projectId)
  }, [projectId])

  const loadProject = async (id: string) => {
    setIsLoading(true)
    // Clear previous project data before loading new one
    resetEditor()
    clearMessages()
    try {
      const project = await ProjectRepository.getById(id)
      if (!project) {
        navigate('/projects')
        return
      }

      setProject(project)
      setEditedTitle(project.title)

      // Load latest version content
      const latestVersion = await VersionRepository.getLatest(id)
      if (latestVersion) {
        setContentFromVersion(latestVersion.content)
      }
    } catch (error) {
      console.error('Failed to load project:', error)
      navigate('/projects')
    } finally {
      setIsLoading(false)
    }
  }

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
      setProject({ ...currentProject, title: editedTitle.trim() })
      setIsEditingTitle(false)
      success('Title updated')
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
      markAsSaved()

      // Update thumbnail for drawio using native export
      if (currentProject.engineType === 'drawio' && canvasRef.current) {
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
      <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-4">
          <div className="relative" ref={menuRef}>
            <Button variant="ghost" size="icon" className="rounded-lg border border-[#e5e7eb]" onClick={() => setIsMenuOpen(!isMenuOpen)}>
              <Menu className="h-4 w-4" />
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
          <div>
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  ref={titleInputRef}
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  className="h-8 w-48"
                />
                <Button variant="ghost" size="icon" onClick={handleSaveTitle}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={handleCancelEditTitle}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="font-medium text-primary">{currentProject.title}</h1>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-md border border-[#e5e7eb]"
                  onClick={handleStartEditTitle}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    currentProject.engineType === 'excalidraw'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                      : 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300'
                  }`}>
                  {currentProject.engineType.toUpperCase()}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Export dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 rounded-lg border border-[#e5e7eb]">
                <Download className="h-4 w-4" />
                <span className="text-xs">导出</span>
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

          {/* Source Code button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => canvasRef.current?.toggleSourceCode()}
            className="gap-1.5 rounded-lg border border-[#e5e7eb]"
          >
            <Code className="h-4 w-4" />
            <span className="text-xs">源码</span>
          </Button>

          <div className="mx-1 h-4 w-px bg-border" />

          <Button
            variant={hasUnsavedChanges ? "default" : "ghost"}
            size="sm"
            onClick={handleSaveVersion}
            disabled={!hasUnsavedChanges}
            className={`rounded-lg border ${hasUnsavedChanges ? 'border-surface/30' : 'border-[#e5e7eb]'}`}
          >
            <Save className="mr-2 h-4 w-4" />
            保存
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsVersionPanelOpen(!isVersionPanelOpen)}
            className="rounded-lg border border-[#e5e7eb]"
          >
            <History className="mr-2 h-4 w-4" />
            历史版本
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 gap-3 overflow-hidden bg-background p-3">
        {/* Left: Chat Panel (collapsible) */}
        {isChatPanelOpen ? (
          <div className="w-96 flex-shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            <ChatPanel onCollapse={() => setIsChatPanelOpen(false)} />
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            title="展开 AI 助手"
            onClick={() => setIsChatPanelOpen(true)}
            className="flex-shrink-0 rounded-lg border border-[#e5e7eb]"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}

        {/* Center: Canvas */}
        <div className="flex-1 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
          <CanvasArea ref={canvasRef} />
        </div>

        {/* Right: Version Panel (collapsible) */}
        {isVersionPanelOpen && (
          <div className="w-64 flex-shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            <VersionPanel onCollapse={() => setIsVersionPanelOpen(false)} />
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  )
}
