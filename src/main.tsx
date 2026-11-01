import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Controller } from './core/controller'
import { applyTheme } from './core/prefs'
import { App } from './ui/App'
import { ControllerContext } from './ui/controllerContext'
import { registerServiceWorker } from './pwa'
import './styles.css'

applyTheme()
const controller = new Controller()
void controller.init()
controller.setUpdater(registerServiceWorker(() => controller.setUpdateAvailable()))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControllerContext.Provider value={controller}>
      <App />
    </ControllerContext.Provider>
  </StrictMode>,
)
