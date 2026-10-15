import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useChatStore } from './stores/chatStore'

// 页面卸载兜底：浏览器关闭 / 刷新时取消所有后台 AI 流式请求，
// 防止页面已经关闭但 fetch 还在跑、继续消耗 token。
window.addEventListener('beforeunload', () => {
  useChatStore.getState().abortAllStreams()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
