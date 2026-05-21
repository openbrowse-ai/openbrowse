import { useState, useEffect, RefObject } from "react";

export function useSceneTimeline(
  totalSteps: number,
  durationPerStep: number = 3000,
  observeRef: RefObject<HTMLElement | null>
) {
  const [step, setStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!observeRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.5 }
    );
    observer.observe(observeRef.current);
    return () => observer.disconnect();
  }, [observeRef]);

  useEffect(() => {
    if (!isVisible) return;
    const interval = setInterval(() => {
      setStep((s) => (s + 1) % totalSteps);
    }, durationPerStep);
    return () => clearInterval(interval);
  }, [totalSteps, durationPerStep, isVisible]);

  return { step, setStep };
}
