import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui'
import { ENGINES } from '@/constants'
import { ProjectRepository } from '@/services/projectRepository'
import type { EngineType } from '@/types'

const ENGINE_TIPS: Record<EngineType, { title: string; features: string[]; types: string[] }> = {
  mermaid: {
    title: 'Mermaid',
    features: ['语法简洁', 'Markdown 友好', '结构化图表'],
    types: ['流程图', '时序图', '甘特图', 'ER 图', '类图', '状态图'],
  },
  excalidraw: {
    title: 'Excalidraw',
    features: ['手绘风格', '自由编辑'],
    types: ['架构草图', '产品原型', '思维导图', '流程草图', '示意图'],
  },
  drawio: {
    title: 'Draw.io',
    features: ['专业图表', '精细编辑'],
    types: ['UML', '流程图', '架构图'],
  },
}

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateProjectDialog({ open, onOpenChange }: CreateProjectDialogProps) {
  const navigate = useNavigate()
  const [engine, setEngine] = useState<EngineType>('mermaid')
  const [isCreating, setIsCreating] = useState(false)

  const handleCreate = async () => {
    setIsCreating(true)
    try {
      const project = await ProjectRepository.create({
        title: '未命名',
        engineType: engine,
      })
      onOpenChange(false)
      navigate(`/editor/${project.id}`)
    } catch (error) {
      console.error('Failed to create project:', error)
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setEngine('mermaid')
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="rounded-2xl">
        <DialogHeader>
          <DialogTitle>绘图引擎</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <div className="flex gap-2">
              {ENGINES.map((e) => (
                <button
                  key={e.value}
                  onClick={() => setEngine(e.value)}
                  className={`flex-1 rounded-xl border p-3 text-sm transition-colors ${
                    engine === e.value
                      ? 'border-primary bg-[#f3f4f6] font-medium text-primary'
                      : 'border-border bg-surface text-primary hover:border-primary'
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          {/* Tips 区域 */}
          <div className="space-y-3 rounded-xl border border-border bg-background p-4">
            {/* 第一层：特点 */}
            <div className="flex flex-wrap gap-2">
              {ENGINE_TIPS[engine].features.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-primary px-3 py-1 text-sm font-medium text-surface"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="border-t border-border" />
            {/* 第二层：支持的图类型 */}
            <div className="flex flex-wrap gap-2">
              {ENGINE_TIPS[engine].types.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="rounded-full"
          >
            取消
          </Button>
          <Button
            onClick={handleCreate}
            disabled={isCreating}
            className="rounded-full bg-primary text-surface hover:bg-primary/90"
          >
            {isCreating ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
