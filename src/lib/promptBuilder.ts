import type { EngineType } from '@/types'
import { mermaidSystemPrompt, drawioSystemPrompt, excalidrawSystemPrompt } from './prompts'

/**
 * System prompts for different engines
 */
export const SYSTEM_PROMPTS: Record<EngineType, string> = {
  mermaid: mermaidSystemPrompt,
  excalidraw: excalidrawSystemPrompt,
  drawio: drawioSystemPrompt,
}

/**
 * Build user prompt for initial generation
 * @param userInput - User's description
 * @param useTwoPhase - Whether to use two-phase generation (for drawio/excalidraw) or single-phase (for mermaid)
 * @param phase - Phase of two-phase generation ('elements' or 'links'), ignored if useTwoPhase is false
 * @param elementsOutput - Output from elements phase, required for 'links' phase
 */
export function buildInitialPrompt(
  userInput: string,
  useTwoPhase: boolean,
  phase?: 'elements' | 'links',
  elementsOutput?: string,
  engineType?: EngineType
): string {
  // Single-phase generation (mermaid / excalidraw / drawio)
  if (!useTwoPhase) {
    // 引擎对应的输出产物描述
    const outputDesc =
      engineType === 'excalidraw'
        ? '完整的 Excalidraw JSON 数组'
        : engineType === 'drawio'
          ? '完整的 draw.io XML'
          : engineType === 'mermaid'
            ? '完整的 Mermaid 代码'
            : '完整的图表代码'
    return `用户需求：
"""
${userInput}
"""

一次性生成${outputDesc}。
在写最终代码前，先在内部推断图表类型、阅读顺序、完整元素清单、分组、关系、箭头、标签、层级、间距、对齐和视觉重点。
用这份内部规划直接产出连贯的手绘白板结果；不要把规划过程输出出来。
图表中文字语言：中文。所有图表可见文本必须与用户当前网页界面语言保持一致。
仅输出最终代码。不要输出 ASCII Layout、Blueprint、规划说明、markdown 代码块、解释或多个候选方案。`
  }

  // Two-phase generation (for drawio/excalidraw)
  if (phase === 'elements') {
    return `用户需求：
"""
${userInput}
"""

根据以上需求，识别并列出所有必要的图表节点和组件。
仅输出包含节点/形状的数据结构，暂不创建任何连接或连线。`
  }

  return `原始需求：
"""
${userInput}
"""

已生成的元素：
"""
${elementsOutput}
"""

根据这些元素，建立它们之间的逻辑连接、箭头和层级关系。
输出最终完整的图表代码。`
}

/**
 * Build user prompt for secondary editing
 */
export function buildEditPrompt(
  currentCode: string,
  userInput: string
): string {
  return `当前图表内容：
"""
${currentCode}
"""

用户修改请求："""${userInput}"""

根据用户修改请求进行修改，同时尽量保持原有结构不变。输出完整的修改后的图表代码。`
}

/**
 * Build user prompt for Excalidraw review & enrich phase (phase 2 of two-phase generation).
 * 复核第一步生成的 JSON，补充遗漏元素、修正布局、丰富细节。
 */
export function buildReviewPrompt(userInput: string, phase1Code: string): string {
  return `原始需求：
"""
${userInput}
"""

已生成的 Excalidraw JSON：
"""
${phase1Code}
"""

对以上图表进行复核并丰富细节：检查元素是否齐全、分组/层级/连线是否合理，补充遗漏的参与者、状态、边界情况、图例或注释，修正明显的不合理坐标或重叠。
保持已有结构和坐标系大体不变，仅做增补与微调。
输出完整最终的 Excalidraw JSON 数组。`
}

/**
 * Extract code from AI response
 * Handles markdown code blocks and plain text
 */
export function extractCode(response: string, _engineType: EngineType): string {
  let code = response.trim()

  // Remove markdown code blocks if present
  const codeBlockPatterns = [
    /```mermaid\n?([\s\S]*?)```/i,
    /```json\n?([\s\S]*?)```/i,
    /```xml\n?([\s\S]*?)```/i,
    /```\n?([\s\S]*?)```/,
  ]

  for (const pattern of codeBlockPatterns) {
    const match = code.match(pattern)
    if (match) {
      code = match[1].trim()
      break
    }
  }

  return code
}
