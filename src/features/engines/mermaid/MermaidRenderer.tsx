import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'
import tidyTreeLayouts from '@mermaid-js/layout-tidy-tree'
import Editor from '@monaco-editor/react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { useEditorStore } from '@/stores/editorStore'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/Tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/Dropdown'
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  Image,
  ArrowRight,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  LayoutGrid,
  GitBranch,
  Network,
  Code,
  X,
  Copy,
  Check,
  Play,
  Undo2,
  SlidersHorizontal,
  Palette,
  Cloud,
  Square,
  PenTool,
  Layers,
  Brush,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface MermaidRendererProps {
  code: string
  className?: string
}

export interface MermaidRendererRef {
  exportAsSvg: () => void
  exportAsPng: () => void
  exportAsSource: () => void
  showSourceCode: () => void
  hideSourceCode: () => void
  toggleSourceCode: () => void
}

type LayoutEngine = 'dagre' | 'elk' | 'tidy-tree'
type Direction = 'TB' | 'BT' | 'LR' | 'RL'

const DIRECTION_LABELS: Record<Direction, string> = {
  TB: '从上到下',
  BT: '从下到上',
  LR: '从左到右',
  RL: '从右到左',
}

const DIRECTION_ICONS: Record<Direction, typeof ArrowDown> = {
  TB: ArrowDown,
  BT: ArrowUp,
  LR: ArrowRight,
  RL: ArrowLeft,
}

// 系统字体栈（与 body 一致）：classic 主题用它测量与渲染，避免文字溢出边框
const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif'

type ThemePresetId = 'morandi' | 'notion' | 'minimal' | 'handdrawn' | 'material' | 'playful'

interface ThemePreset {
  label: string
  desc: string
  icon: LucideIcon
  look: 'classic' | 'handDrawn'
  theme: 'base' | 'default' | 'forest' | 'neutral' | 'dark'
  // 顶层 fontFamily：影响 mermaid 测量文字宽度（决定节点尺寸）。
  // 必须与实际渲染字体一致，否则测量偏小、文字溢出边框。
  // classic 主题用系统字体栈（与 body 一致）；手绘主题用手写字体。
  fontFamily: string
  themeVariables: Record<string, string>
}

// 主题模板：look + themeVariables 组合
const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  // 莫兰迪（默认）—— 低饱和度柔和色系
  morandi: {
    label: '莫兰迪柔色',
    desc: '低饱和粉蓝绿，柔和护眼',
    icon: Cloud,
    look: 'classic',
    theme: 'base',
    fontFamily: SYSTEM_FONT_STACK,
    themeVariables: {
      fontFamily: SYSTEM_FONT_STACK,
      primaryColor: '#e3f2fd',
      primaryTextColor: '#0d47a1',
      primaryBorderColor: '#2196f3',
      lineColor: '#546e7a',
      cScale0: '#e3f2fd', cScale1: '#fff3e0', cScale2: '#e8f5e9', cScale3: '#f3e5f5',
      cScale4: '#fce4ec', cScale5: '#e0f7fa', cScale6: '#fff8e1', cScale7: '#efebe9',
      cScale8: '#e8eaf6', cScale9: '#f1f8e9', cScale10: '#fbe9e7', cScale11: '#e1f5fe',
      cScaleLabel0: '#0d47a1', cScaleLabel1: '#e65100', cScaleLabel2: '#1b5e20',
      cScaleLabel3: '#4a148c', cScaleLabel4: '#880e4f', cScaleLabel5: '#006064',
      cScaleLabel6: '#ff6f00', cScaleLabel7: '#3e2723', cScaleLabel8: '#1a237e',
      cScaleLabel9: '#33691e', cScaleLabel10: '#bf360c', cScaleLabel11: '#01579b',
    },
  },
  // Notion 风格 —— 中性灰、近黑文字、柔和边框
  notion: {
    label: 'Notion 灰白',
    desc: '中性灰底，近黑文字，素净',
    icon: Square,
    look: 'classic',
    theme: 'base',
    fontFamily: SYSTEM_FONT_STACK,
    themeVariables: {
      fontFamily: SYSTEM_FONT_STACK,
      primaryColor: '#F7F7F5',
      primaryTextColor: '#37352F',
      primaryBorderColor: '#E9E9E7',
      secondaryColor: '#E9E9E7',
      secondaryTextColor: '#37352F',
      secondaryBorderColor: '#D3D3D0',
      tertiaryColor: '#F0F0EE',
      tertiaryTextColor: '#37352F',
      tertiaryBorderColor: '#E9E9E7',
      lineColor: '#9B9A97',
      textColor: '#37352F',
      cScale0: '#F7F7F5', cScale1: '#E9E9E7', cScale2: '#DBDBD8', cScale3: '#F0F0EE',
      cScale4: '#E4E4E0', cScale5: '#F2F1ED', cScale6: '#DADAD6', cScale7: '#ECECE8',
      cScale8: '#E0E0DC', cScale9: '#F5F4F0', cScale10: '#DEDEDA', cScale11: '#E8E8E4',
      cScaleLabel0: '#37352F', cScaleLabel1: '#37352F', cScaleLabel2: '#37352F',
      cScaleLabel3: '#37352F', cScaleLabel4: '#37352F', cScaleLabel5: '#37352F',
      cScaleLabel6: '#37352F', cScaleLabel7: '#37352F', cScaleLabel8: '#37352F',
      cScaleLabel9: '#37352F', cScaleLabel10: '#37352F', cScaleLabel11: '#37352F',
    },
  },
  // 极简 —— 黑白、白底黑框
  minimal: {
    label: '黑白极简',
    desc: '纯白底黑框线，高对比',
    icon: Layers,
    look: 'classic',
    theme: 'base',
    fontFamily: SYSTEM_FONT_STACK,
    themeVariables: {
      fontFamily: SYSTEM_FONT_STACK,
      primaryColor: '#FFFFFF',
      primaryTextColor: '#1A1A1A',
      primaryBorderColor: '#1A1A1A',
      secondaryColor: '#FFFFFF',
      secondaryTextColor: '#1A1A1A',
      secondaryBorderColor: '#4A4A4A',
      tertiaryColor: '#FFFFFF',
      tertiaryTextColor: '#1A1A1A',
      tertiaryBorderColor: '#1A1A1A',
      lineColor: '#1A1A1A',
      textColor: '#1A1A1A',
      cScale0: '#FFFFFF', cScale1: '#FFFFFF', cScale2: '#FFFFFF', cScale3: '#FFFFFF',
      cScale4: '#FFFFFF', cScale5: '#FFFFFF', cScale6: '#FFFFFF', cScale7: '#FFFFFF',
      cScale8: '#FFFFFF', cScale9: '#FFFFFF', cScale10: '#FFFFFF', cScale11: '#FFFFFF',
      cScaleLabel0: '#1A1A1A', cScaleLabel1: '#1A1A1A', cScaleLabel2: '#1A1A1A',
      cScaleLabel3: '#1A1A1A', cScaleLabel4: '#1A1A1A', cScaleLabel5: '#1A1A1A',
      cScaleLabel6: '#1A1A1A', cScaleLabel7: '#1A1A1A', cScaleLabel8: '#1A1A1A',
      cScaleLabel9: '#1A1A1A', cScaleLabel10: '#1A1A1A', cScaleLabel11: '#1A1A1A',
    },
  },
  // 手绘 —— handDrawn look + 暖色羊皮纸
  handdrawn: {
    label: '手绘羊皮纸',
    desc: '手写体 + 草图描边，暖黄底',
    icon: PenTool,
    look: 'handDrawn',
    theme: 'base',
    fontFamily: '"Muyao-Softbrush", "Comic Sans MS", cursive',
    themeVariables: {
      fontFamily: '"Muyao-Softbrush", "Comic Sans MS", cursive',
      primaryColor: '#FFF8E7',
      primaryTextColor: '#3D2B1F',
      primaryBorderColor: '#5C4033',
      secondaryColor: '#FBE9C8',
      secondaryTextColor: '#3D2B1F',
      secondaryBorderColor: '#8B6F47',
      tertiaryColor: '#F5E6C8',
      tertiaryTextColor: '#3D2B1F',
      tertiaryBorderColor: '#8B6F47',
      lineColor: '#5C4033',
      textColor: '#3D2B1F',
      cScale0: '#FFF8E7', cScale1: '#FBE9C8', cScale2: '#F5E6C8', cScale3: '#EFD9A8',
      cScale4: '#E8CB8E', cScale5: '#FFFBF0', cScale6: '#F3DEB0', cScale7: '#EFDDB8',
      cScale8: '#F8E8C8', cScale9: '#F2DFB0', cScale10: '#EAD8A8', cScale11: '#F5EAC8',
      cScaleLabel0: '#3D2B1F', cScaleLabel1: '#5C4033', cScaleLabel2: '#6B4F2E',
      cScaleLabel3: '#3D2B1F', cScaleLabel4: '#5C4033', cScaleLabel5: '#6B4F2E',
      cScaleLabel6: '#3D2B1F', cScaleLabel7: '#5C4033', cScaleLabel8: '#6B4F2E',
      cScaleLabel9: '#3D2B1F', cScaleLabel10: '#5C4033', cScaleLabel11: '#6B4F2E',
    },
  },
  // Material —— Material Design 配色（靛蓝主色）
  material: {
    label: 'Material 彩',
    desc: '靛蓝主色，多彩明亮',
    icon: Brush,
    look: 'classic',
    theme: 'base',
    fontFamily: SYSTEM_FONT_STACK,
    themeVariables: {
      fontFamily: SYSTEM_FONT_STACK,
      primaryColor: '#E8EAF6',
      primaryTextColor: '#1A237E',
      primaryBorderColor: '#3F51B5',
      secondaryColor: '#E1F5FE',
      secondaryTextColor: '#01579B',
      secondaryBorderColor: '#039BE5',
      tertiaryColor: '#E0F2F1',
      tertiaryTextColor: '#004D40',
      tertiaryBorderColor: '#00897B',
      lineColor: '#5C6BC0',
      textColor: '#1A237E',
      cScale0: '#E8EAF6', cScale1: '#E1F5FE', cScale2: '#E0F2F1', cScale3: '#F3E5F5',
      cScale4: '#FCE4EC', cScale5: '#FFF3E0', cScale6: '#F1F8E9', cScale7: '#EDE7F6',
      cScale8: '#E1F5FE', cScale9: '#FBE9E7', cScale10: '#F9FBE7', cScale11: '#ECEFF1',
      cScaleLabel0: '#1A237E', cScaleLabel1: '#01579B', cScaleLabel2: '#004D40',
      cScaleLabel3: '#4A148C', cScaleLabel4: '#880E4F', cScaleLabel5: '#E65100',
      cScaleLabel6: '#33691E', cScaleLabel7: '#311B92', cScaleLabel8: '#01579B',
      cScaleLabel9: '#BF360C', cScaleLabel10: '#827717', cScaleLabel11: '#37474F',
    },
  },
  // Playful Doodle —— handDrawn look + 鲜亮俏皮配色
  playful: {
    label: '童趣涂鸦',
    desc: '手写体 + 草图描边，鲜亮糖果色',
    icon: Palette,
    look: 'handDrawn',
    theme: 'base',
    fontFamily: '"Muyao-Softbrush", "Comic Sans MS", cursive',
    themeVariables: {
      fontFamily: '"Muyao-Softbrush", "Comic Sans MS", cursive',
      primaryColor: '#FFF3B0',
      primaryTextColor: '#6A4C93',
      primaryBorderColor: '#1982C4',
      secondaryColor: '#FFD6E0',
      secondaryTextColor: '#6A4C93',
      secondaryBorderColor: '#F72585',
      tertiaryColor: '#B5EAD7',
      tertiaryTextColor: '#6A4C93',
      tertiaryBorderColor: '#06A77D',
      lineColor: '#F72585',
      textColor: '#6A4C93',
      cScale0: '#FFF3B0', cScale1: '#FFD6E0', cScale2: '#B5EAD7', cScale3: '#A8DADC',
      cScale4: '#FFB5A7', cScale5: '#CDB4DB', cScale6: '#FFEC99', cScale7: '#BDE0FE',
      cScale8: '#FCD5CE', cScale9: '#D8E2DC', cScale10: '#FFE5D9', cScale11: '#E2C2FF',
      cScaleLabel0: '#6A4C93', cScaleLabel1: '#C9184A', cScaleLabel2: '#1B9AAA',
      cScaleLabel3: '#264653', cScaleLabel4: '#E76F51', cScaleLabel5: '#5C2D91',
      cScaleLabel6: '#9D4EDD', cScaleLabel7: '#0077B6', cScaleLabel8: '#BC4749',
      cScaleLabel9: '#386641', cScaleLabel10: '#6A994E', cScaleLabel11: '#7B2CBF',
    },
  },
}

const MIN_SCALE = 0.1
const MAX_SCALE = 5
const SCALE_STEP = 0.1

// Register layout loaders once
let elkRegistered = false
let tidyTreeRegistered = false

async function registerElkLayouts() {
  if (!elkRegistered) {
    mermaid.registerLayoutLoaders(elkLayouts)
    elkRegistered = true
  }
}

async function registerTidyTreeLayouts() {
  if (!tidyTreeRegistered) {
    mermaid.registerLayoutLoaders(tidyTreeLayouts)
    tidyTreeRegistered = true
  }
}

export const MermaidRenderer = forwardRef<MermaidRendererRef, MermaidRendererProps>(function MermaidRenderer({ code, className }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgContainerRef = useRef<HTMLDivElement>(null)
  const diagramContainerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState<string>('')
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [layout, setLayout] = useState<LayoutEngine>('dagre')
  const [direction, setDirection] = useState<Direction>('TB')
  const [themePreset, setThemePreset] = useState<ThemePresetId>('morandi')
  const [showCodePanel, setShowCodePanel] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editedCode, setEditedCode] = useState(code)
  const [hasChanges, setHasChanges] = useState(false)

  const { setContent } = useEditorStore()

  // Sync editedCode when code prop changes
  useEffect(() => {
    setEditedCode(code)
    setHasChanges(false)
  }, [code])

  // Extract balanced braces content from a string starting at given position
  const extractBalancedBraces = useCallback((str: string, startPos: number): string | null => {
    if (str[startPos] !== '{') return null

    let depth = 0
    let i = startPos

    while (i < str.length) {
      if (str[i] === '{') depth++
      else if (str[i] === '}') {
        depth--
        if (depth === 0) {
          return str.slice(startPos, i + 1)
        }
      }
      i++
    }
    return null
  }, [])

  // Parse existing %%{init: {...}}%% directive and extract config
  const parseInitDirective = useCallback((mermaidCode: string): { config: Record<string, unknown>, remainingCode: string } => {
    const lines = mermaidCode.trim().split('\n')
    let config: Record<string, unknown> = {}
    let startIndex = 0

    // Skip frontmatter if present
    if (lines[0]?.trim() === '---') {
      const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---')
      if (endIndex > 0) {
        startIndex = endIndex + 1
      }
    }

    // Check for %%{init: {...}}%% directive
    const remainingText = lines.slice(startIndex).join('\n')
    const initStartMatch = remainingText.match(/^%%\{init:\s*/)

    if (initStartMatch) {
      const configStartPos = initStartMatch[0].length
      const configContent = extractBalancedBraces(remainingText, configStartPos)

      if (configContent) {
        try {
          // Parse the JSON-like config (convert single quotes to double quotes for JSON.parse)
          const configStr = configContent.replace(/'/g, '"')
          config = JSON.parse(configStr)
        } catch {
          // Keep empty config if parsing fails
          config = {}
        }

        // Find where the init directive ends (after }}%%)
        const directiveEndPos = configStartPos + configContent.length
        const afterDirective = remainingText.slice(directiveEndPos)
        // Remove the closing }%% and any whitespace
        const afterInit = afterDirective.replace(/^\s*\}%%\s*/, '').trim()
        return { config, remainingCode: afterInit }
      }
    }

    return { config: {}, remainingCode: remainingText }
  }, [extractBalancedBraces])

  // Inject layout and direction config into mermaid code, preserving user's theme config
  const injectConfig = useCallback((mermaidCode: string, layoutEngine: LayoutEngine, dir: Direction): string => {
    const { config: existingConfig, remainingCode } = parseInitDirective(mermaidCode)

    if (!remainingCode.trim()) return mermaidCode

    const diagramLines = remainingCode.split('\n')
    const firstDiagramLine = diagramLines[0]?.trim().toLowerCase() || ''

    // Merge configs: preserve user's theme settings, add layout if needed
    const mergedConfig: Record<string, unknown> = { ...existingConfig }
    mergedConfig.layout = layoutEngine

    // if (layoutEngine === 'elk') {
    //   mergedConfig.layout = 'elk'
    // }

    // Handle direction for flowchart/graph
    if (firstDiagramLine.startsWith('graph') || firstDiagramLine.startsWith('flowchart')) {
      // Replace or add direction in the diagram declaration
      const directionPattern = /^(graph|flowchart)\s*(TB|BT|LR|RL|TD)?/i
      if (directionPattern.test(diagramLines[0])) {
        diagramLines[0] = diagramLines[0].replace(directionPattern, `$1 ${dir}`)
      }
    }

    // Build the init directive string if we have config
    let initDirective = ''
    if (Object.keys(mergedConfig).length > 0) {
      // Convert config to mermaid init format with single quotes
      const configStr = JSON.stringify(mergedConfig)
        .replace(/"/g, "'")
      initDirective = `%%{init: ${configStr}}%%\n`
    }

    return initDirective + diagramLines.join('\n')
  }, [parseInitDirective])

  const renderDiagram = useCallback(async (mermaidCode: string) => {
    try {
      // Register layout loaders as needed
      if (layout === 'elk') {
        await registerElkLayouts()
      } else if (layout === 'tidy-tree') {
        await registerTidyTreeLayouts()
      }

      // Initialize mermaid with selected theme preset
      const preset = THEME_PRESETS[themePreset]
      mermaid.initialize({
        startOnLoad: false,
        theme: preset.theme,
        look: preset.look,
        securityLevel: 'loose',
        fontFamily: preset.fontFamily,
        themeVariables: preset.themeVariables,
      })

      const codeWithConfig = injectConfig(mermaidCode, layout, direction)

      // Validate syntax first
      await mermaid.parse(codeWithConfig)

      // Render the diagram
      const id = `mermaid-${Date.now()}`
      const { svg: renderedSvg } = await mermaid.render(id, codeWithConfig)

      // 手绘主题兜底注入字体：mermaid 的 themeVariables.fontFamily 对 flowchart 等
      // 基础图不一定生效，这里用内联 <style> 强制覆盖所有 text 的 font-family。
      // classic 主题用系统字体栈，mermaid 测量与渲染一致，无需注入。
      let finalSvg = renderedSvg
      if (preset.look === 'handDrawn') {
        const fontVar = preset.themeVariables.fontFamily
        const styleTag = `<style>text, tspan, .nodeLabel, .edgeLabel, .label, foreignObject span, foreignObject div { font-family: ${fontVar} !important; }</style>`
        finalSvg = renderedSvg.replace(/(<svg[^>]*>)/, `$1${styleTag}`)
      }
      setSvg(finalSvg)
      setError(null)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Invalid Mermaid syntax'
      setError(errorMessage)
      setSvg('')
    }
  }, [injectConfig, layout, direction, themePreset])

  useEffect(() => {
    if (!code.trim()) {
      setSvg('')
      setError(null)
      return
    }

    renderDiagram(code)
  }, [code, renderDiagram])

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + SCALE_STEP, MAX_SCALE))
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - SCALE_STEP, MIN_SCALE))
  }, [])

  const handleResetView = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  // Native wheel event handler for proper preventDefault
  useEffect(() => {
    const container = diagramContainerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+滚轮：缩放
        e.preventDefault()
        const delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP
        setScale(prev => Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev + delta)))
      } else {
        // 普通滚轮：上下滚动（平移）
        e.preventDefault()
        setPosition(prev => ({
          x: prev.x,
          y: prev.y - e.deltaY,
        }))
      }
    }

    // Use passive: false to allow preventDefault
    container.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      container.removeEventListener('wheel', handleWheel)
    }
  }, [svg])

  // Keyboard zoom
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        handleZoomIn()
      } else if (e.key === '-') {
        e.preventDefault()
        handleZoomOut()
      } else if (e.key === '0') {
        e.preventDefault()
        handleResetView()
      }
    }
  }, [handleZoomIn, handleZoomOut, handleResetView])

  // Pan controls
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true)
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
    }
  }, [position])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      })
    }
  }, [isDragging, dragStart])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Export functions
  const exportAsSvg = useCallback(() => {
    if (!svg) return

    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `diagram-${Date.now()}.svg`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [svg])

  const exportAsPng = useCallback(async () => {
    if (!svg || !svgContainerRef.current) return

    const svgElement = svgContainerRef.current.querySelector('svg')
    if (!svgElement) return

    // Get SVG dimensions
    const bbox = svgElement.getBBox()
    const width = bbox.width || svgElement.clientWidth || 800
    const height = bbox.height || svgElement.clientHeight || 600

    // Create canvas
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size with higher resolution for better quality
    const exportScale = 2
    canvas.width = width * exportScale
    canvas.height = height * exportScale
    ctx.scale(exportScale, exportScale)

    // Fill white background
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, width, height)

    // Convert SVG to base64 data URL to avoid tainted canvas issue
    const svgData = new XMLSerializer().serializeToString(svgElement)
    const svgBase64 = btoa(unescape(encodeURIComponent(svgData)))
    const dataUrl = `data:image/svg+xml;base64,${svgBase64}`

    const img = new window.Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height)

      // Download
      const link = document.createElement('a')
      link.download = `diagram-${Date.now()}.png`
      link.href = canvas.toDataURL('image/png')
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
    img.onerror = (err) => {
      console.error('Failed to load SVG for PNG export:', err)
    }
    img.src = dataUrl
  }, [svg])

  // Export as source (.mmd file)
  const exportAsSource = useCallback(() => {
    if (!code) return

    const blob = new Blob([code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `diagram-${Date.now()}.mmd`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [code])

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    exportAsSvg,
    exportAsPng,
    exportAsSource,
    showSourceCode: () => setShowCodePanel(true),
    hideSourceCode: () => setShowCodePanel(false),
    toggleSourceCode: () => setShowCodePanel(prev => !prev),
  }), [exportAsSvg, exportAsPng, exportAsSource])

  // Layout change handler
  const handleLayoutChange = useCallback((value: string) => {
    setLayout(value as LayoutEngine)
  }, [])

  // Direction change handler
  const handleDirectionChange = useCallback((value: string) => {
    setDirection(value as Direction)
  }, [])

  // Theme preset change handler
  const handleThemeChange = useCallback((value: string) => {
    setThemePreset(value as ThemePresetId)
  }, [])

  // Copy code handler
  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(editedCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }, [editedCode])

  // Handle code edit (for Monaco Editor)
  const handleCodeChange = useCallback((value: string | undefined) => {
    const newCode = value || ''
    setEditedCode(newCode)
    setHasChanges(newCode !== code)
  }, [code])

  // Apply code changes
  const handleApplyCode = useCallback(() => {
    if (editedCode.trim() && editedCode !== code) {
      setContent(editedCode)
      setHasChanges(false)
    }
  }, [editedCode, code, setContent])

  // Reset code to original
  const handleResetCode = useCallback(() => {
    setEditedCode(code)
    setHasChanges(false)
  }, [code])

  if (!code.trim()) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center text-muted',
          className
        )}
      >
        <div className="text-center">
          <p className="text-sm">暂无图表</p>
          <p className="mt-1 text-xs">使用 WeDraw 生成一个吧</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center p-4',
          className
        )}
      >
        <div className="max-w-md border border-red-300 bg-red-50 p-4">
          <p className="font-medium text-red-800">Syntax Error</p>
          <p className="mt-1 text-sm text-red-600">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div
        ref={containerRef}
        className={cn('relative flex h-full flex-col', className)}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {/* Diagram container */}
        <div
          ref={diagramContainerRef}
          className="relative flex-1 select-none overflow-hidden"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
          <div
            ref={svgContainerRef}
            className="flex h-full w-full items-center justify-center p-8"
            style={{
              transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.1s ease-out',
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />

          {/* 浮动调整菜单 - 左上角：布局引擎 + 图表方向 */}
          <div className="absolute left-3 top-3 z-10">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 rounded-lg border border-[#e5e7eb] bg-surface/80 p-0 shadow-sm backdrop-blur-sm hover:bg-surface"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>图表设置</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="text-xs text-muted">主题模板</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={themePreset} onValueChange={handleThemeChange}>
                  {(Object.keys(THEME_PRESETS) as ThemePresetId[]).map((id) => {
                    const preset = THEME_PRESETS[id]
                    const Icon = preset.icon
                    return (
                      <DropdownMenuRadioItem key={id} value={id} className="py-1.5 pr-3">
                        <Icon className="mr-2 h-4 w-4 flex-shrink-0" />
                        <div className="flex min-w-0 flex-col">
                          <span className="text-sm">{preset.label}</span>
                          <span className="whitespace-nowrap text-[11px] text-muted">{preset.desc}</span>
                        </div>
                      </DropdownMenuRadioItem>
                    )
                  })}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted">布局引擎</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={layout} onValueChange={handleLayoutChange}>
                  <DropdownMenuRadioItem value="dagre" className="py-1.5 pr-3">
                    <GitBranch className="mr-2 h-4 w-4 flex-shrink-0" />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm">Dagre (默认)</span>
                      <span className="whitespace-nowrap text-[11px] text-muted">分层布局，连线简洁</span>
                    </div>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="elk" className="py-1.5 pr-3">
                    <LayoutGrid className="mr-2 h-4 w-4 flex-shrink-0" />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm">ELK (层次化)</span>
                      <span className="whitespace-nowrap text-[11px] text-muted">紧凑对齐，适合宽图</span>
                    </div>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted">图表方向</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={direction} onValueChange={handleDirectionChange}>
                  <DropdownMenuRadioItem value="TB">
                    <ArrowDown className="mr-2 h-4 w-4" />
                    从上到下
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="BT">
                    <ArrowUp className="mr-2 h-4 w-4" />
                    从下到上
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="LR">
                    <ArrowRight className="mr-2 h-4 w-4" />
                    从左到右
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="RL">
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    从右到左
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* 缩放/重置控制 - 右上角 */}
          <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-md border border-[#e5e7eb] bg-surface/80 px-0.5 py-0.5 shadow-sm backdrop-blur-sm">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={handleZoomOut} className="h-6 w-6 p-0">
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>缩小</TooltipContent>
            </Tooltip>

            <span className="min-w-[2.5rem] text-center text-[11px] text-muted">
              {Math.round(scale * 100)}%
            </span>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={handleZoomIn} className="h-6 w-6 p-0">
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>放大</TooltipContent>
            </Tooltip>

            <div className="mx-0.5 h-3.5 w-px bg-border" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={handleResetView} className="h-6 w-6 p-0">
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>重置视图</TooltipContent>
            </Tooltip>
          </div>

          {/* 操作提示 - 右下角 */}
          <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-surface/70 px-2 py-0.5 text-[10px] text-muted opacity-70 backdrop-blur-sm">
            滚轮滚动 | Ctrl+滚轮缩放 | 拖拽平移
          </div>
        </div>

        {/* Code Panel */}
        {showCodePanel && (
          <div className="absolute bottom-4 right-4 w-96 max-h-[70%] flex flex-col overflow-hidden rounded-xl border border-[#e5e7eb] bg-surface shadow-lg select-text">
            {/* Panel Header */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Mermaid 源码</span>
                {hasChanges && (
                  <span className="text-xs text-amber-500">• 未保存</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyCode}
                      className="h-7 w-7 rounded-lg border border-[#e5e7eb] p-0"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copied ? '已复制' : '复制代码'}</TooltipContent>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCodePanel(false)}
                  className="h-7 w-7 rounded-lg border border-[#e5e7eb] p-0"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {/* Code Editor */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Editor
                height="300px"
                defaultLanguage="mermaid"
                value={editedCode}
                onChange={handleCodeChange}
                theme="vs"
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'off',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  automaticLayout: true,
                  tabSize: 2,
                  padding: { top: 8, bottom: 8 },
                  scrollbar: {
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                  },
                }}
              />
            </div>
            {/* Panel Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleResetCode}
                    disabled={!hasChanges}
                    className="gap-1.5 rounded-lg border border-[#e5e7eb]"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    <span className="text-xs">重置</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>重置为原始代码</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleApplyCode}
                    disabled={!hasChanges || !editedCode.trim()}
                    className="gap-1.5 rounded-lg border border-surface/30"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span className="text-xs">应用</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>应用代码更改</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
})
