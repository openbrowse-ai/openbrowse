import React from 'react'
import ReactDOM from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import App from './App'
import '../_shared/home.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
      <Toaster position="bottom-center" />
    </TooltipProvider>
  </React.StrictMode>,
)
