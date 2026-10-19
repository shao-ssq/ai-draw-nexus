/**
 * File upload utilities for document & image handling
 */

// Maximum file size (in bytes)
export const MAX_DOCUMENT_SIZE = 1 * 1024 * 1024 // 1MB
export const MAX_IMAGE_SIZE = 1 * 1024 * 1024 // 1MB

// Maximum number of documents allowed per request (HomePage & ChatPanel 共用)
export const MAX_DOCUMENT_COUNT = 5
// 图片上限 1 张：统一首页 / 绘图界面
export const MAX_IMAGE_COUNT = 1

// Supported file types
export const SUPPORTED_DOCUMENT_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain', // .txt
  'text/markdown', // .md
]
// 文件扩展名映射（用于处理某些浏览器不识别 MIME 类型的情况）
export const SUPPORTED_DOCUMENT_EXTENSIONS = ['.docx', '.txt', '.md']

export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]
export const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

export interface FileValidationResult {
  valid: boolean
  error?: string
}

/**
 * 获取文件扩展名
 */
export function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : ''
}

/**
 * 验证文档文件
 */
export function validateDocumentFile(file: File): FileValidationResult {
  const extension = getFileExtension(file.name)
  const isValidType = SUPPORTED_DOCUMENT_TYPES.includes(file.type) ||
                      SUPPORTED_DOCUMENT_EXTENSIONS.includes(extension)

  if (!isValidType) {
    return {
      valid: false,
      error: `不支持的文档类型。支持的格式：docx、txt、md`,
    }
  }

  if (file.size > MAX_DOCUMENT_SIZE) {
    return {
      valid: false,
      error: `文档过大：${(file.size / 1024 / 1024).toFixed(2)}MB。最大支持：1MB`,
    }
  }

  return { valid: true }
}

/**
 * 验证图片文件
 */
export function validateImageFile(file: File): FileValidationResult {
  const extension = getFileExtension(file.name)
  const isValidType = SUPPORTED_IMAGE_TYPES.includes(file.type) ||
                      SUPPORTED_IMAGE_EXTENSIONS.includes(extension)

  if (!isValidType) {
    return {
      valid: false,
      error: `不支持的图片格式。支持的格式：png、jpg、jpeg、gif、webp`,
    }
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return {
      valid: false,
      error: `图片过大：${(file.size / 1024 / 1024).toFixed(2)}MB。最大支持：1MB`,
    }
  }

  return { valid: true }
}

/**
 * 读取文件为 Data URL（用于图片预览 / 后续送 AI）
 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 解析 Word 文档
 */
export async function parseWordDocument(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value
}

/**
 * 解析文本文件（txt、md）
 */
export async function parseTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(reader.result as string)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 根据文件类型解析文档内容
 */
export async function parseDocument(file: File): Promise<string> {
  const extension = getFileExtension(file.name)

  if (extension === '.docx') {
    return parseWordDocument(file)
  } else if (extension === '.txt' || extension === '.md') {
    return parseTextFile(file)
  }

  // 根据 MIME 类型判断
  if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return parseWordDocument(file)
  }

  // 默认当作文本文件处理
  return parseTextFile(file)
}

/**
 * Create an input element for file selection
 */
export function createFileInput(
  accept: string,
  multiple: boolean = false
): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.multiple = multiple
  return input
}

/**
 * Open file picker and return selected files
 */
export function selectFiles(
  accept: string,
  multiple: boolean = false
): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = createFileInput(accept, multiple)
    input.onchange = () => {
      resolve(input.files)
    }
    input.click()
  })
}
