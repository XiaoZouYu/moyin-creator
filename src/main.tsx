// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import React from 'react'
import ReactDOM from 'react-dom/client'
import './lib/user-session'
import './index.css'
import { installGlobalFetchGuard } from './lib/cors-fetch'
import { installWebPlatformAdapters } from './lib/web-platform'

installGlobalFetchGuard()
installWebPlatformAdapters()

async function bootstrap() {
  const { default: App } = await import('./App.tsx')

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void bootstrap()
