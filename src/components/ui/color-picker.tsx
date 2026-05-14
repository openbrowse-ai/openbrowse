"use client";

import { useEffect, useRef, useState } from "react";

function hslToHex(h: number, s: number, l: number) {
  l /= 100;
  s /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
  return (
    "#" +
    [f(0), f(8), f(4)]
      .map((x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

interface ColorPickerProps {
  size?: number;
  padding?: number;
  bulletRadius?: number;
  spreadFactor?: number;
  minSpread?: number;
  maxSpread?: number;
  minLight?: number;
  maxLight?: number;
  showColorWheel?: boolean;
  numPoints?: number;
  initialAngle?: number;
  initialRadius?: number;
  colorTransform?: (hex: string) => string;
  onColorChange?: (colors: string[]) => void;
  onStateChange?: (state: { angle: number; radius: number }) => void;
}

export default function ColorPicker({
  size = 280,
  padding = 20,
  bulletRadius = 24,
  spreadFactor = 0.4,
  minSpread = Math.PI / 1.5,
  maxSpread = Math.PI / 3,
  minLight = 15,
  maxLight = 90,
  showColorWheel = false,
  numPoints = 1,
  initialAngle,
  initialRadius,
  colorTransform,
  onColorChange,
  onStateChange,
}: ColorPickerProps) {
  const RADIUS = size / 2 - padding;

  const [angle, setAngle] = useState(initialAngle ?? -Math.PI / 2);
  const [radius, setRadius] = useState(initialRadius ?? RADIUS * 0.7);
  const [drag, setDrag] = useState(false);

  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (initialAngle !== undefined) setAngle(initialAngle);
  }, [initialAngle]);

  useEffect(() => {
    if (initialRadius !== undefined) setRadius(initialRadius);
  }, [initialRadius]);

  const hue = (angle * 180) / Math.PI;
  const light = maxLight * (radius / RADIUS);
  const color = hslToHex(hue, 100, light);

  const normalizedRadius = radius / RADIUS;
  const spread =
    (minSpread + (maxSpread - minSpread) * Math.pow(normalizedRadius, 3)) *
    spreadFactor;

  const bx1 = size / 2 + Math.cos(angle - spread) * radius;
  const by1 = size / 2 + Math.sin(angle - spread) * radius;
  const bx2 = size / 2 + Math.cos(angle + spread) * radius;
  const by2 = size / 2 + Math.sin(angle + spread) * radius;

  const angle1 = angle - spread;
  const angle2 = angle + spread;
  const hue1 = (angle1 * 180) / Math.PI;
  const hue2 = (angle2 * 180) / Math.PI;
  const light1 = maxLight * (radius / RADIUS);
  const light2 = maxLight * (radius / RADIUS);
  const color1 = hslToHex(hue1, 100, light1);
  const color2 = hslToHex(hue2, 100, light2);

  const t = colorTransform ?? ((c: string) => c);
  const displayColor = t(color);
  const displayColor1 = t(color1);
  const displayColor2 = t(color2);

  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, RADIUS, 0, Math.PI * 2);
    ctx.clip();

    for (let r = 0; r <= RADIUS; r++) {
      for (let a = 0; a < 360; a += 1) {
        const rad = (a * Math.PI) / 180;
        const x = size / 2 + Math.cos(rad) * r;
        const y = size / 2 + Math.sin(rad) * r;
        const lightness = minLight + (maxLight - minLight) * (r / RADIUS);
        ctx.beginPath();
        ctx.strokeStyle = hslToHex(a, 100, lightness);
        ctx.moveTo(x, y);
        ctx.lineTo(x + 1, y + 1);
        ctx.stroke();
      }
    }
  }, [size, RADIUS, minLight, maxLight]);

  useEffect(() => {
    const colors =
      numPoints === 1
        ? [color]
        : numPoints === 2
          ? [color2, color]
          : [color2, color, color1];
    onColorChange?.(colors);
  }, [color, color1, color2, numPoints, onColorChange]);

  useEffect(() => {
    onStateChange?.({ angle, radius });
  }, [angle, radius, onStateChange]);

  function setFromPointer(e: React.PointerEvent) {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    let r = Math.sqrt(x * x + y * y);
    let a = Math.atan2(y, x);
    if (a < 0) a += 2 * Math.PI;
    r = Math.max(0, Math.min(RADIUS, r));
    setAngle(a);
    setRadius(r);
  }

  function onPointerDown(e: React.PointerEvent) {
    setDrag(true);
    setFromPointer(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    setFromPointer(e);
  }
  function onPointerUp() {
    setDrag(false);
  }

  const bx = size / 2 + Math.cos(angle) * radius;
  const by = size / 2 + Math.sin(angle) * radius;

  return (
    <div>
      <div
        style={{ width: size, height: size }}
        className="relative select-none"
      >
        <svg
          className="absolute inset-0 size-full z-0"
          style={{
            maskImage: `radial-gradient(${size * 0.7}px circle at center, white, transparent)`,
          }}
          aria-hidden="true"
        >
          <defs>
            <pattern id="colorPickerDots" width={10} height={10} patternUnits="userSpaceOnUse">
              <circle cx={5} cy={5} r={1} className="fill-gray-500/20" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#colorPickerDots)" />
        </svg>
        <canvas
          ref={ref}
          width={size}
          height={size}
          className={`rounded-full ${!showColorWheel && "opacity-0"}`}
        />

        {numPoints >= 2 && (
          <div
            className="pointer-events-none absolute z-20 rounded-full border-2 border-white/80 opacity-90 shadow"
            style={{
              left: bx2 - bulletRadius / 1.7,
              top: by2 - bulletRadius / 1.7,
              width: bulletRadius * 1.2,
              height: bulletRadius * 1.2,
              background: displayColor2,
            }}
          />
        )}

        <div
          className="absolute z-30 cursor-grab touch-none rounded-full border-3 border-white/90 shadow"
          style={{
            left: bx - bulletRadius,
            top: by - bulletRadius,
            width: bulletRadius * 2,
            height: bulletRadius * 2,
            background: displayColor,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />

        {numPoints >= 3 && (
          <div
            className="pointer-events-none absolute z-20 rounded-full border-2 border-white/80 opacity-90 shadow"
            style={{
              left: bx1 - bulletRadius / 1.7,
              top: by1 - bulletRadius / 1.7,
              width: bulletRadius * 1.2,
              height: bulletRadius * 1.2,
              background: displayColor1,
            }}
          />
        )}
      </div>
    </div>
  );
}
