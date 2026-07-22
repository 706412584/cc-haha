import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme/globals.css'
import { initializeAppZoom } from './lib/appZoom'
import { initializeTouchH5 } from './lib/touchH5'
import { runDesktopPersistenceMigrations } from './lib/persistenceMigrations'

declare global {
  interface Window {
    __CC_HAHA_BOOTSTRAPPED__?: boolean
    __CC_HAHA_SHOW_STARTUP_ERROR__?: (reason: unknown) => void
  }
}

type DesktopBootstrapModules = [
  { App: React.ComponentType },
  { ErrorBoundary: React.ComponentType<{ children: React.ReactNode }> },
  { installClientDiagnosticsCapture: () => void },
  { initializeTheme: () => void },
]

export function isPetWindowLocation(search = window.location.search): boolean {
  return new URLSearchParams(search).get('petWindow') === '1'
}

function loadDesktopBootstrapModules() {
  const appModule = isPetWindowLocation()
    ? import('./features/pets/PetApp').then(({ PetApp }) => ({ App: PetApp }))
    : import('./App')
  return Promise.all([
    appModule,
    import('./components/ErrorBoundary'),
    import('./lib/diagnosticsCapture'),
    import('./stores/uiStore'),
  ])
}

if (isPetWindowLocation()) {
  document.documentElement.dataset.windowKind = 'pet'
}

export async function bootstrapDesktopApp(
  root: HTMLElement | null = document.getElementById('root'),
  loadModules: () => Promise<DesktopBootstrapModules> = loadDesktopBootstrapModules,
) {
  try {
    const [{ App }, { ErrorBoundary }, { installClientDiagnosticsCapture }, { initializeTheme }] = await loadModules()
    initializeTheme()
    installClientDiagnosticsCapture()

    if (!root) {
      throw new Error('Desktop root element not found')
    }

    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    )
    window.__CC_HAHA_BOOTSTRAPPED__ = true
  } catch (error) {
    console.error('[desktop] Failed to bootstrap app', error)
    if (root) {
      if (window.__CC_HAHA_SHOW_STARTUP_ERROR__) {
        window.__CC_HAHA_SHOW_STARTUP_ERROR__(error)
      } else {
        root.textContent = error instanceof Error ? error.message : String(error)
      }
    }
  }
}

runDesktopPersistenceMigrations()
initializeTouchH5()
void initializeAppZoom()

void bootstrapDesktopApp()
