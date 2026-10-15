import { Brain } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from '@/components/ui/Dropdown'
import { cn } from '@/lib/utils'
import type { ThinkingLevel } from '@/types'

export type { ThinkingLevel }

const LEVEL_LABEL: Record<ThinkingLevel, string> = {
  low: '非思考',
  medium: '思考',
  high: '深度思考',
}

const LEVEL_DESCRIPTION: Record<ThinkingLevel, string> = {
  low: '轻量推理，速度快',
  medium: '中等推理',
  high: '规划更细，速度慢',
}

interface ThinkingLevelSelectorProps {
  value: ThinkingLevel
  onChange: (next: ThinkingLevel) => void
  /** 紧凑样式：用于 ChatPanel 输入栏；否则用 HomePage 的胶囊样式 */
  variant?: 'compact' | 'pill'
  disabled?: boolean
}

const ORDER: ThinkingLevel[] = ['low', 'medium', 'high']

/**
 * Gemini 思考档位选择器（非思考 / 思考 / 深度思考）。
 * - compact: 图标 + 当前档位短标签（如"中"）
 * - pill:    完整胶囊按钮（用于 HomePage）
 */
export function ThinkingLevelSelector({
  value,
  onChange,
  variant = 'compact',
  disabled = false,
}: ThinkingLevelSelectorProps) {
  const shortLabel = LEVEL_LABEL[value]
  const isActive = value !== 'medium' // 高亮中等（默认）档位

  const content = (
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuLabel>思考档位</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value}
        onValueChange={(v) => onChange(v as ThinkingLevel)}
      >
        {ORDER.map((lv) => (
          <DropdownMenuRadioItem key={lv} value={lv}>
            <div className="flex flex-col">
              <span className="whitespace-nowrap">{LEVEL_LABEL[lv]} — {LEVEL_DESCRIPTION[lv]}</span>
            </div>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled className="text-[11px] text-muted">
        <span className="whitespace-nowrap">当前：{LEVEL_LABEL[value]} — {LEVEL_DESCRIPTION[value]}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  )

  if (variant === 'pill') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            title={`当前：${LEVEL_LABEL[value]} — ${LEVEL_DESCRIPTION[value]}`}
            className={cn(
              'inline-flex min-w-24 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-4 py-1 text-[13px] font-medium transition-colors',
              isActive
                ? 'border-[#a78bfa] bg-[#ede9fe] text-[#6d28d9]'
                : 'border-border bg-[#f3f4f6] text-[#374151] hover:bg-[#e5e7eb]'
            )}
          >
            <Brain className="h-3.5 w-3.5" />
            <span>{shortLabel}</span>
          </button>
        </DropdownMenuTrigger>
        {content}
      </DropdownMenu>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={`思考档位：${LEVEL_LABEL[value]}（点击切换）`}
          className={cn(
            'inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-xs transition-colors',
            isActive
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted hover:text-primary'
          )}
        >
          <Brain className="h-4 w-4" />
          <span className="font-medium">{shortLabel}</span>
        </button>
      </DropdownMenuTrigger>
      {content}
    </DropdownMenu>
  )
}
