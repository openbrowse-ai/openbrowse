import React from 'react'
import ReactDOM from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { SettingsPage } from './SettingsPage'
import { useOverlay } from '@/hooks/useOverlay'
import { ensurePersistedStorage } from '@/lib/storage-persistence'
import './app.css'

// See newtab/main.tsx: persist() is Window-only, so every document
// surface opts in. Idempotent per document, and a no-op once granted.
void ensurePersistedStorage()

function App() {
  const { OverlayPortal } = useOverlay();
  return (
    <div className="min-h-screen bg-[var(--background)]">
      <SettingsPage onBack={() => { window.close(); }} />
      {OverlayPortal}
      <Toaster />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
)
