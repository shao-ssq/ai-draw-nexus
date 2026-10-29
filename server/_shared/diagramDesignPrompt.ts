import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Message } from './types.js'

const RESOURCE_ROOT = path.resolve(process.cwd(), 'server/resources/diagram-design')
const resourceCache = new Map<string, string>()
const promptCache = new Map<string, string>()

/**
 * 只加载当前图类型需要的规范，保留原 Skill 的 progressive disclosure 思路。
 * 规则仅负责选择参考文档；模型仍以用户语义和 SKILL.md 的类型指南为准。
 */
const TYPE_RULES: Array<[RegExp, string]> = [
  [/架构(?:变化|演进|差异|前后)|architecture\s+delta|before\s*\/?\s*after/i, 'architecture-delta'],
  [/现状架构|it\s*现状|遗留系统|current[-\s]state|legacy\s+it/i, 'it-state'],
  [/服务蓝图|service\s+blueprint/i, 'service-blueprint'],
  [/用户旅程|旅程图|user\s+journey|customer\s+journey/i, 'journey'],
  [/故事地图|story\s+map/i, 'story-map'],
  [/泳道|跨职能流程|swimlane|cross[-\s]functional/i, 'swimlane'],
  [/时序图|序列图|顺序图|消息时序|sequence\s+diagram/i, 'sequence'],
  [/状态机|状态转换|生命周期|state\s+machine|lifecycle/i, 'state'],
  [/数据库表|表结构|字段类型|database\s+schema|sql\s+schema/i, 'db-schema'],
  [/\ber\s*图|实体关系|数据模型|er\s+diagram|entity\s+relationship/i, 'er'],
  [/甘特图|gantt/i, 'gantt'],
  [/时间线|里程碑|timeline/i, 'timeline'],
  [/象限|swot|优先级矩阵|quadrant/i, 'quadrant'],
  [/雷达图|蛛网图|radar|spider\s+chart/i, 'radar'],
  [/极坐标|径向图|polar\s+chart/i, 'polar'],
  [/飞轮|增长闭环|循环图|flywheel|loop\s+diagram/i, 'loop'],
  [/嵌套图|包含关系|nested\s+diagram/i, 'nested'],
  [/组织架构|汇报关系|org\s+chart|organization\s+chart/i, 'org-chart'],
  [/树状图|树形图|分解树|block\s+decomposition|tree\s+diagram/i, 'tree'],
  [/分层架构|层级栈|层次栈|layer\s+stack/i, 'layers'],
  [/爆炸图|拆解图|轴测分解|exploded|axonometric(?!\s+plan)/i, 'exploded'],
  [/轴测平面|场地平面|axonometric\s+plan/i, 'axonometric-plan'],
  [/韦恩图|文氏图|集合关系|venn/i, 'venn'],
  [/金字塔|漏斗图|pyramid|funnel/i, 'pyramid'],
  [/矩形树图|马赛克图|treemap|marimekko/i, 'treemap'],
  [/热力图|heatmap/i, 'heatmap'],
  [/瀑布图|waterfall/i, 'waterfall'],
  [/折线图|趋势图|坡度图|山脊图|line\s+chart|slopegraph|ridgeline|streamgraph|bump\s+chart/i, 'line'],
  [/散点图|气泡图|蜂群图|箱线图|scatter|bubble\s+chart|beeswarm|box\s+plot/i, 'scatter'],
  [/柱状图|条形图|哑铃图|bar\s+chart|dumbbell/i, 'bar'],
  [/桑基图|sankey/i, 'sankey'],
  [/鱼骨图|因果图|fishbone|ishikawa/i, 'fishbone'],
  [/wardley|价值链演进/i, 'wardley'],
  [/看板|kanban/i, 'kanban'],
  [/部署图|deployment\s+diagram/i, 'deployment'],
  [/依赖图|依赖关系图|dependency\s+graph/i, 'dependency'],
  [/uml\s*类图|类图|class\s+diagram/i, 'uml-class'],
  [/权限矩阵|安全矩阵|security\s+matrix/i, 'dp-security-matrix'],
  [/数据平台集成|集成拓扑|dp\s+integration/i, 'dp-integration'],
  [/ medallion|青铜层|白银层|黄金层|数据分层/i, 'medallion'],
  [/数据流|data\s+flow/i, 'data-flow'],
  [/高端数据栈|数据平台架构|数据栈|high[-\s]level/i, 'high-level'],
  [/流程图|决策流程|审批流程|flowchart/i, 'flowchart'],
  [/流程|过程图|process\s+diagram/i, 'process'],
  [/架构|拓扑|系统组成|architecture|topology/i, 'architecture'],
]

function readResource(relativePath: string): string {
  const cached = resourceCache.get(relativePath)
  if (cached !== undefined) return cached
  const content = readFileSync(path.join(RESOURCE_ROOT, relativePath), 'utf8')
  resourceCache.set(relativePath, content)
  return content
}

function messageText(message: Message | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

function selectDiagramType(messages: Message[]): string {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')
  let text = messageText(latestUser)
  // 编辑提示包含整张旧 HTML，只使用末尾的真实修改请求做路由，避免旧标签干扰。
  const editMarker = '用户修改请求'
  const editIndex = text.lastIndexOf(editMarker)
  if (editIndex >= 0) text = text.slice(editIndex + editMarker.length)
  text = text.slice(-8000)

  for (const [pattern, type] of TYPE_RULES) {
    if (pattern.test(text)) return type
  }
  return 'architecture'
}

/** 构建 Diagram+ 服务端系统提示词，按图类型缓存完整文档组合。 */
export function getDiagramDesignSystemPrompt(messages: Message[]): string {
  const type = selectDiagramType(messages)
  const cached = promptCache.get(type)
  if (cached !== undefined) return cached

  const runtimeInstructions = `You are Diagram+, WeDraw's editorial diagram generation engine.
Generate one complete, self-contained HTML document with inline SVG.

## WeDraw runtime rules (these override interactive Skill procedures)
- Do not ask onboarding, style-profile, plan-confirmation, output-dial, or follow-up questions. The application has already chosen the defaults.
- Use the shipped light style guide, minimal-light presentation, format=html, size=doc-inline, detail=balanced, audience=mixed.
- Use the selected type reference as layout guidance. If the user's explicit request names another type, follow the user's request and apply the closest relevant grammar from the supplied documents.
- All visible diagram text must be Simplified Chinese unless the user explicitly requests another language. Preserve proper nouns and technical identifiers.
- Default to static output. Do not emit JavaScript, animation controllers, iframes, external images, forms, or event-handler attributes.
- The only allowed external resource is the approved Google Fonts stylesheet already present in the template. Use the documented Simplified Chinese font fallbacks.
- When editing an existing HTML document, preserve its overall structure, visual type, dimensions, stable IDs, and unaffected elements; apply only the requested changes.
- Return ONLY the complete HTML document, from <!DOCTYPE html> through </html>. No Markdown fence, commentary, plan, fidelity ledger, or explanation.
- Fill every template placeholder. Include exactly one primary accessible SVG with a viewBox, role="img", aria-labelledby, a first-child <title>, and a non-empty <desc>.
- Follow the connector, complexity, typography, CJK, accessibility, and safety rules in the supplied references.`

  const sections = [
    runtimeInstructions,
    '# Diagram Design Skill\n\n' + readResource('SKILL.md'),
    '# Active Style Guide\n\n' + readResource('references/style-guide.md'),
    '# Semantic Patterns\n\n' + readResource('references/semantic-patterns.md'),
    '# Core SVG Primitives\n\n' + readResource('references/primitives-core.md'),
    '# Layout Budget\n\n' + readResource('references/layout-budget.md'),
    '# Output Specification\n\n' + readResource('references/output-spec.md'),
    `# Selected Visual Type: ${type}\n\n` + readResource(`references/type-${type}.md`),
    '# Minimal Light HTML Template\n\n' + readResource('assets/template.html'),
  ]

  const prompt = sections.join('\n\n---\n\n')
  promptCache.set(type, prompt)
  return prompt
}
