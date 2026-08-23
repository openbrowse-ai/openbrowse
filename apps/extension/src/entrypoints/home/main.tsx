import React from 'react'
import ReactDOM from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { ensurePersistedStorage } from '@/lib/storage-persistence'
import App from './App'
import '../_shared/home.css'

// See newtab/main.tsx: persist() is Window-only, so every document
// surface opts in. Idempotent per document, and a no-op once granted.
void ensurePersistedStorage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
      <Toaster position="bottom-center" />
    </TooltipProvider>
  </React.StrictMode>,
)
