import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const root = process.cwd()
const origin = 'http://127.0.0.1:4173'
const server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
  cwd: root,
  shell: true,
  stdio: 'pipe',
})

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(origin)).ok) return
    } catch {
      // Preview is starting.
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
  await page.goto(origin, { waitUntil: 'networkidle' })
  const buttons = await page.locator('button').allTextContents()
  const visibleEngines = buttons.filter((text) => ['Mermaid', 'Excalidraw', 'Draw.io', 'Diagram+', 'Image2'].includes(text.trim()))
  if (visibleEngines.join('|') !== 'Mermaid|Excalidraw|Draw.io') {
    throw new Error(`Disabled engines are still visible: ${visibleEngines.join('|')}`)
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
        id: 'disabled-engine-smoke', title: '已关闭引擎的项目', engineType: 'diagram-design',
        thumbnail: '', createdAt: now, updatedAt: now,
      })
      tx.objectStore('versionHistory').put({
        id: 'disabled-engine-smoke-v1', projectId: 'disabled-engine-smoke', content,
        changeSummary: '测试版本', timestamp: now,
      })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, html)

  await page.goto(`${origin}/editor/disabled-engine-smoke`, { waitUntil: 'networkidle' })
  await page.frameLocator('iframe[title="Diagram+ 图表预览"]').locator('svg').waitFor({ state: 'visible' })
  const input = page.getByPlaceholder('此绘图引擎已关闭，可在 .env 中重新启用')
  if (!(await input.isDisabled())) throw new Error('Disabled engine still allows chat input')
  console.log('PASS: creation entries hidden; existing project preview retained; chat generation disabled')
} finally {
  if (browser) await browser.close()
  await stopServer()
}
