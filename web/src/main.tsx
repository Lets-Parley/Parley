import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/nunito-sans/400.css'
import '@fontsource/nunito-sans/700.css'
import '@fontsource/fraunces/600.css'
import '@fontsource/jetbrains-mono/500.css'
import './tokens.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
