import { useState, useEffect } from 'react'
import { Sliders } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui'
import type {
  Image2Params,
  Image2AspectRatio,
  Image2Resolution,
  Image2Quality,
} from '@/types'
import { IMAGE2_SIZE_MAP } from '@/types'

interface Image2ParamsBarProps {
  value: Image2Params
  onChange: (next: Image2Params) => void
}

const ASPECT_RATIOS: Image2AspectRatio[] = ['1:1', '4:3', '3:4', '16:9', '9:16']
const RESOLUTIONS: Image2Resolution[] = ['1k', '2k']
const QUALITIES: { value: Image2Quality; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

/** 比例的小图标尺寸（参考参考图：rounded-sm + border） */
const RATIO_PREVIEWS: Record<Image2AspectRatio, string> = {
  '1:1':  'h-7 w-7',
  '4:3':  'h-6 w-8',
  '3:4':  'h-8 w-6',
  '16:9': 'h-5 w-9',
  '9:16': 'h-9 w-5',
}

const QUALITY_LABEL: Record<Image2Quality, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
}

/** 当前选中的摘要文字：1:1 · 1K · high · 1024x1024 */
function formatSummary(p: Image2Params): string {
  const size = IMAGE2_SIZE_MAP[`${p.aspectRatio}__${p.resolution}`]
  const pixels = size ? `${size.width}x${size.height}` : ''
  return [
    p.aspectRatio,
    p.resolution.toUpperCase(),
    QUALITY_LABEL[p.quality],
    pixels,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Image2 引擎的生成参数入口。
 *
 * 默认渲染一个 trigger 按钮（摘要文字 + 调参图标）；点击弹出 Dialog
 * 提供画面比例（5 选 1，带 mini-shape 预览）、清晰度（1k / 2k）、质量（低 / 中 / 高）三组选择。
 *
 * Dialog 内部维护草稿，Save 才 commit 到 onChange；Cancel 丢弃草稿。
 */
export function Image2ParamsBar({ value, onChange }: Image2ParamsBarProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Image2Params>(value)

  // 打开时把当前值同步进草稿
  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  const updateDraft = <K extends keyof Image2Params>(key: K, v: Image2Params[K]) => {
    setDraft((prev) => ({ ...prev, [key]: v }))
  }

  const handleSave = () => {
    onChange(draft)
    setOpen(false)
  }

  const handleCancel = () => setOpen(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Trigger：摘要按钮 —— DialogTrigger asChild 让 Radix 接管按钮行为 */}
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[12px] font-medium text-primary transition-colors hover:bg-border"
          title="调整生成参数"
        >
          <Sliders className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="tabular-nums">{formatSummary(value)}</span>
        </button>
      </DialogTrigger>

      <DialogContent className="max-w-[24rem] gap-0 overflow-hidden rounded-xl border border-border bg-surface p-0 shadow-xl sm:max-w-md flex max-h-[85vh] flex-col">
        {/* Header */}
        <DialogHeader className="gap-1.5 border-b border-border bg-background/60 px-5 pb-4 pt-5 pr-14 text-left">
          <DialogTitle className="text-base font-semibold tracking-tight text-primary">
            生成参数
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-5 tabular-nums text-muted-foreground">
            {formatSummary(draft)}
          </DialogDescription>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {/* 画面比例 */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              画面比例
            </p>
            <div className="grid grid-cols-3 gap-2">
              {ASPECT_RATIOS.map((ratio) => {
                const active = draft.aspectRatio === ratio
                return (
                  <button
                    key={ratio}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateDraft('aspectRatio', ratio)}
                    className={`flex h-[4.75rem] flex-col items-center justify-center rounded-md border px-1.5 text-[12px] font-semibold tabular-nums transition-all ${
                      active
                        ? 'border-foreground bg-foreground/10 text-foreground shadow-sm'
                        : 'border-border bg-background text-primary hover:border-foreground/40 hover:bg-background'
                    }`}
                  >
                    {/* mini-shape：按比例预览 */}
                    <span
                      className={`mb-1.5 rounded-sm border ${
                        active
                          ? 'border-foreground/70 bg-foreground/60'
                          : 'border-foreground/30 bg-foreground/15'
                      } ${RATIO_PREVIEWS[ratio]}`}
                    />
                    <span className="leading-none">{ratio}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 清晰度 */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              清晰度
            </p>
            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-border bg-background p-1">
              {RESOLUTIONS.map((res) => {
                const active = draft.resolution === res
                return (
                  <button
                    key={res}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateDraft('resolution', res)}
                    className={`h-9 rounded-lg text-[12px] font-semibold tabular-nums transition-all ${
                      active
                        ? 'bg-surface text-foreground shadow-sm ring-1 ring-foreground/20'
                        : 'text-muted-foreground hover:text-primary'
                    }`}
                  >
                    {res.toUpperCase()}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 质量 */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              质量
            </p>
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border bg-background p-1">
              {QUALITIES.map((q) => {
                const active = draft.quality === q.value
                return (
                  <button
                    key={q.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateDraft('quality', q.value)}
                    className={`h-9 rounded-lg text-[12px] font-semibold transition-all ${
                      active
                        ? 'bg-surface text-foreground shadow-sm ring-1 ring-foreground/20'
                        : 'text-muted-foreground hover:text-primary'
                    }`}
                  >
                    {q.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="flex shrink-0 flex-col-reverse gap-2.5 border-t border-border bg-background/60 px-5 py-4 sm:flex-row sm:justify-end">
          <div className="flex w-full gap-2.5 sm:w-auto sm:justify-end">
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-surface px-5 text-[13px] font-medium text-primary transition-colors hover:bg-background sm:flex-none"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex h-11 flex-1 items-center justify-center rounded-md bg-foreground/90 px-5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-foreground sm:flex-none"
            >
              确定
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
