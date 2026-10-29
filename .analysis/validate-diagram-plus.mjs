import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const root = process.cwd()
const port = 4173
const origin = `http://127.0.0.1:${port}`
const server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  shell: true,
  stdio: 'pipe',
})

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(origin)
      if (response.ok) return
    } catch {
      // preview is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Vite preview did not start')
}

async function stopServer() {
  if (!server.pid) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('exit', resolve)
      killer.on('error', resolve)
    })
  } else {
    server.kill('SIGTERM')
  }
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(origin, { waitUntil: 'networkidle' })
  const engineOrder = await page.locator('button').allTextContents()
  const filteredOrder = engineOrder.filter((text) => ['Mermaid', 'Excalidraw', 'Draw.io', 'Diagram+', 'Image2'].includes(text.trim()))
  if (filteredOrder.join('|') !== 'Mermaid|Excalidraw|Draw.io|Diagram+|Image2') {
    throw new Error(`Unexpected engine order: ${filteredOrder.join('|')}`)
  }

  const html = await readFile(`${root}/.analysis/diagram-design/skills/diagram-design/assets/example-flowchart.html`, 'utf8')
  await page.evaluate(async (content) => {
    const request = indexedDB.open('WeDrawDB', 3)
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        request.result.createObjectStore('projects', { keyPath: 'id' })
        request.result.createObjectStore('versionHistory', { keyPath: 'id' })
        request.result.createObjectStore('chatHistories', { keyPath: 'projectId' })
        request.result.createObjectStore('drafts', { keyPath: 'projectId' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const now = new Date()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['projects', 'versionHistory'], 'readwrite')
      tx.objectStore('projects').put({
        id: 'diagram-plus-smoke',
        title: 'Diagram+ 冒烟验证',
        engineType: 'diagram-design',
        thumbnail: '',
        createdAt: now,
        updatedAt: now,
      })
      tx.objectStore('versionHistory').put({
        id: 'diagram-plus-smoke-v1',
        projectId: 'diagram-plus-smoke',
        content,
        changeSummary: '测试版本',
        timestamp: now,
      })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, html)

  await page.goto(`${origin}/editor/diagram-plus-smoke`, { waitUntil: 'networkidle' })
  const preview = page.getByTitle('Diagram+ 图表预览')
  await preview.waitFor({ state: 'visible' })
  const frame = page.frameLocator('iframe[title="Diagram+ 图表预览"]')
  await frame.locator('svg').waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '源码', exact: true }).click()
  await page.locator('.monaco-editor').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '源码', exact: true }).click()

  await page.getByRole('button', { name: '导出', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByText('导出为 SVG', { exact: true }).click()
  const download = await downloadPromise
  if (!download.suggestedFilename().endsWith('.svg')) {
    throw new Error(`Unexpected export filename: ${download.suggestedFilename()}`)
  }

  await page.getByRole('button', { name: '导出', exact: true }).click()
  const pngDownloadPromise = page.waitForEvent('download')
  await page.getByText('导出为 PNG', { exact: true }).click()
  const pngDownload = await pngDownloadPromise
  if (!pngDownload.suggestedFilename().endsWith('.png')) {
    throw new Error(`Unexpected export filename: ${pngDownload.suggestedFilename()}`)
  }
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${root}/.analysis/diagram-plus-smoke.png`, fullPage: true })
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join(' | ')}`)
  console.log('PASS: engine order, iframe SVG preview, source panel, SVG and PNG downloads')
} finally {
  if (browser) await browser.close()
  await stopServer()
}
