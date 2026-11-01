import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initViewport } from './viewport'
import { startWithYuiOnce } from './startYui'
import { LocalSpeechRecognition, localSttAvailable } from './ui/localSpeech'
import { setLocalSpeech } from './ui/useSpeechInput'
import './desktop.css' // 電腦版版面，要放在最後

// standalone (home-screen) app: tag <html> and size #root to the real screen height (see viewport.ts); ?vp=1 = debug overlay
initViewport()
// 第一次打開時換成結衣（只做一次）
startWithYuiOnce()

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// the PC's own speech recognition (Chinese / Japanese found per sentence) when it is installed; the page waits for the
// answer at most 1.5 s, then starts with the browser's recognizer
Promise.race([
  localSttAvailable().then((ok) => { if (ok) setLocalSpeech(LocalSpeechRecognition); }),
  new Promise((r) => setTimeout(r, 1500)),
]).finally(render)
