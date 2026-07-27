import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@xterm/xterm/css/xterm.css'
import '../theme/globals.css'
import { ComponentGallery } from './ComponentGallery'

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><ComponentGallery /></StrictMode>)
