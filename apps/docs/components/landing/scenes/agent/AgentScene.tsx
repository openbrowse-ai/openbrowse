"use client";

import { useRef } from "react";
import { SceneFrame } from "../_shared/SceneFrame";
import { useSceneTimeline } from "@/lib/use-scene-timeline";
import { SCENARIOS } from "./scenarios";
import { VideoSlide } from "./VideoSlide";
import { cn } from "@/lib/utils";

export function AgentScene() {
  const observeRef = useRef<HTMLDivElement>(null);
  const { step, setStep } = useSceneTimeline(SCENARIOS.length, 14000, observeRef);

  return (
    <div className="flex flex-col gap-4 w-full" ref={observeRef}>
      <SceneFrame
        className="w-full aspect-[16/10] md:aspect-[16/9] shadow-lg border-muted/30"
      >
        <VideoSlide scenario={SCENARIOS[step]} />
      </SceneFrame>
      
      {/* Caption & Navigation */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-2">
        <p className="text-sm text-muted-foreground flex-1 min-h-[40px] flex items-center">
          {SCENARIOS[step].caption}
        </p>
        
        <div className="flex items-center gap-2 shrink-0">
          {SCENARIOS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(i)}
              className={cn(
                "w-2 h-2 rounded-full transition-all duration-300",
                i === step ? "bg-primary w-4" : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
              )}
              aria-label={`View scenario: ${s.label}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
