import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@phosphor-icons/web/regular'
import '@phosphor-icons/web/fill'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'

import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
