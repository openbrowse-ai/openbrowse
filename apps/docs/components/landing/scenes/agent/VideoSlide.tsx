"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { AgentScenario } from "./scenarios";

export function VideoSlide({ scenario }: { scenario: AgentScenario }) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="w-full h-full bg-muted/20 animate-pulse" />;
  }

  const isDark = resolvedTheme === "dark";
  const videoSrc = isDark ? scenario.videoDark : scenario.videoLight;
  const posterSrc = isDark ? scenario.posterDark : scenario.posterLight;

  return (
    <video
      key={videoSrc} // Force remount on theme/source change
      src={videoSrc}
      poster={posterSrc}
      autoPlay
      loop
      muted
      playsInline
      preload="metadata"
      className="w-full h-full object-cover object-left-top"
    />
  );
}
