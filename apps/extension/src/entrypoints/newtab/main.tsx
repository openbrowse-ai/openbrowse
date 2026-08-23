import React from 'react'
import ReactDOM from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { ensurePersistedStorage } from '@/lib/storage-persistence'
import App from './App'
import '../_shared/home.css'

// Ask Chrome for eviction-exempt storage. Must run from a document:
// StorageManager.persist() is [Exposed=Window], so the MV3 service
// worker cannot call it. Fire-and-forget - never throws, and must not
// delay first paint.
void ensurePersistedStorage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
      <Toaster position="bottom-center" />
    </TooltipProvider>
  </React.StrictMode>,
)
