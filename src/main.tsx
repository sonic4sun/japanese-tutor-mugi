import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initViewport } from './viewport'
import { startWithYuiOnce } from './startYui'
import './desktop.css' // 電腦版版面，要放在最後

// standalone (home-screen) app: tag <html> and size #root to the real screen height (see viewport.ts); ?vp=1 = debug overlay
initViewport()
// 第一次打開時換成結衣（只做一次）
startWithYuiOnce()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
