// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import React from 'react'
import ReactDOM from 'react-dom/client'
import './lib/user-session'
import './index.css'
import { installWebPlatformAdapters } from './lib/web-platform'

installWebPlatformAdapters()

async function bootstrap() {
  const { default: App } = await import('./App.tsx')

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

  // Use contextBridge (only available in Electron)
  if (window.ipcRenderer) {
    window.ipcRenderer.on('main-process-message', (_event, message) => {
      console.log(message)
    })
  }
}

void bootstrap()
