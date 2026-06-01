"use client";

import { useRef } from "react";
import { SceneFrame } from "../_shared/SceneFrame";
import { BrowserChrome } from "../_shared/BrowserChrome";
import { useSceneTimeline } from "@/lib/use-scene-timeline";
import { INITIAL_TABS, TIDIED_TABS } from "./tab-data";
import { MockKbd } from "./MockKbd";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Sparkles, Check } from "lucide-react";
import { Logo } from "@/components/logo";

export function TabsScene() {
  const observeRef = useRef<HTMLDivElement>(null);
  // States: 
  // 0 = overlay open with messy tabs
  // 1 = typed "tidy", showing AI action
  // 2 = tidying animation
  // 3 = grouped result hold
  const { step } = useSceneTimeline(4, 3000, observeRef);

  const isTidied = step >= 2;
  const isSearching = step === 1;

  const spaces = isTidied 
    ? Array.from(new Set(TIDIED_TABS.map(t => t.space))) 
    : [];

  return (
    <div className="flex flex-col gap-4 w-full" ref={observeRef}>
      <SceneFrame
        className="w-full aspect-[4/3] md:aspect-[16/10] shadow-sm border-muted/30"
      >
        <BrowserChrome>
          <div className="relative w-full h-full p-4 pb-10 md:p-8 flex justify-center bg-muted/20 overflow-hidden">
            
            {/* Progress Indicator */}
            <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-background/50 backdrop-blur-md border rounded-full px-2 py-1.5 shadow-sm z-20">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-1 w-6 bg-muted-foreground/20 rounded-full overflow-hidden">
                  {i === step ? (
                    <div
                      className="h-full bg-primary"
                      style={{
                        animation: "scene-progress 3s linear forwards",
                      }}
                    />
                  ) : i < step ? (
                    <div className="h-full w-full bg-primary" />
                  ) : null}
                </div>
              ))}
            </div>
            <style dangerouslySetInnerHTML={{ __html: `
              @keyframes scene-progress {
                from { width: 0%; }
                to { width: 100%; }
              }
            `}} />

            {/* The OverlayApp Replica */}
            <div className="flex flex-col min-h-0 w-full max-w-[600px] h-fit max-h-full rounded-xl border shadow-2xl bg-popover overflow-hidden z-10 font-sans text-popover-foreground">
              
              {/* Header */}
              <div className="flex items-center gap-1.5 border-b px-2 py-1.5 shrink-0 bg-popover">
                <Search className="size-3.5 shrink-0 text-muted-foreground ml-1" />
                <div className="relative flex-1 min-w-0 flex items-center">
                  <div className="flex-1 min-w-0 truncate bg-transparent text-sm text-foreground outline-none py-1">
                    {isSearching ? "Tidy" : ""}
                    {!isSearching && <span className="text-muted-foreground">Search tabs...  / for commands</span>}
                  </div>
                </div>
                {isSearching ? (
                  <MockKbd className="mr-1">esc</MockKbd>
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors mr-1">
                    <Sparkles className="size-3" />
                    <MockKbd>⌥I</MockKbd>
                  </div>
                )}
              </div>

              {/* List Area */}
              <div className="flex flex-col min-h-0 overflow-y-auto styled-scrollbar pb-1 max-h-[300px] bg-popover">
                <AnimatePresence mode="wait">
                  {isSearching ? (
                    <motion.div
                      key="search"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="flex flex-col"
                    >
                      <div className="sticky top-0 z-10 px-3 py-1 text-xs font-medium text-muted-foreground bg-popover w-full text-left">
                        AI ACTIONS
                      </div>
                      <div className="flex items-center gap-2 px-3 py-1.5 text-sm bg-accent text-accent-foreground mx-1 rounded-sm cursor-default">
                        <Sparkles className="size-4 shrink-0 text-blue-500" />
                        <span className="flex-1 min-w-0 truncate font-medium">Tidy all tabs</span>
                        <MockKbd>↵</MockKbd>
                      </div>
                    </motion.div>
                  ) : !isTidied ? (
                    <motion.div
                      key="messy"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="flex flex-col"
                    >
                      <div className="sticky top-0 z-10 px-3 py-1 text-xs font-medium text-muted-foreground bg-popover w-full text-left">
                        Open Tabs
                      </div>
                      <div className="flex flex-col px-1">
                        {INITIAL_TABS.map((tab, i) => (
                          <div key={tab.id} className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-muted/50 cursor-default group">
                            <img src={tab.favicon} alt="" className="size-4 shrink-0 rounded-sm" />
                            <span className="flex-1 min-w-0 truncate">{tab.title}</span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="tidied"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
                      className="flex flex-col"
                    >
                      {spaces.map((space, i) => (
                        <motion.div 
                          key={space} 
                          initial={{ opacity: 0, y: 5 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.1 }}
                          className="flex flex-col"
                        >
                          <div className="sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted-foreground bg-popover w-full text-left">
                            {space}
                          </div>
                          <div className="flex flex-col px-1 pb-1">
                            {TIDIED_TABS.filter(t => t.space === space).map((tab) => (
                              <div key={tab.id} className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-muted/50 cursor-default group">
                                <img src={tab.favicon} alt="" className="size-4 shrink-0 rounded-sm" />
                                <span className="flex-1 min-w-0 truncate">{tab.title}</span>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Footer */}
              <div className="relative flex items-center justify-between border-t px-2 py-1.5 shrink-0 bg-popover">
                <div className="flex items-center gap-2">
                  <div className="flex size-6 items-center justify-center rounded-md text-muted-foreground">
                    <Logo className="size-4" />
                  </div>
                  {step === 2 ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground animate-pulse">
                      <Sparkles className="size-3" />
                      Tidying...
                    </span>
                  ) : step === 3 ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="size-3" />
                      Tidied
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                      <MockKbd className="h-4 min-w-4 text-[10px]">↑</MockKbd>
                      <MockKbd className="h-4 min-w-4 text-[10px]">↓</MockKbd>
                      to navigate
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors">
                    {isSearching ? "Run command" : "Open tab"}
                    <MockKbd>⏎</MockKbd>
                  </div>
                  {!isSearching && (
                    <div className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors">
                      Actions
                      <MockKbd>⌘K</MockKbd>
                    </div>
                  )}
                </div>
              </div>

            </div>

          </div>
        </BrowserChrome>
      </SceneFrame>

      {/* Caption */}
      <div className="flex items-center gap-3 px-2">
        <MockKbd className="h-6 px-2 text-xs">⌥ K</MockKbd>
        <p className="text-sm text-muted-foreground flex-1">
          Open the command palette anywhere. One action groups tabs by topic and cleans up messy titles.
        </p>
      </div>
    </div>
  );
}
