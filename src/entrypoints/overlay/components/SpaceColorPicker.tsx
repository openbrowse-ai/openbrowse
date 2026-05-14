import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Moon, Plus, Sparkles, Sun } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ColorPicker from "@/components/ui/color-picker";
import { PALETTE_PAGES, type ColorPreset } from "@/lib/color-presets";
import { adjustColorsForMode } from "@/lib/color-utils";

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

const PICKER_SIZE = 240;
const PICKER_PADDING = 20;
const PICKER_RADIUS = PICKER_SIZE / 2 - PICKER_PADDING;
const MAX_LIGHT = 90;

function deriveAngleRadius(colors: string[]): { angle: number; radius: number } {
  const primary = colors.length === 1 ? colors[0] : colors[1];
  const { h, l } = hexToHsl(primary);
  const angle = (h * Math.PI) / 180;
  const radius = (l / MAX_LIGHT) * PICKER_RADIUS;
  return { angle, radius };
}

interface SpaceColorPickerProps {
  initialColors: string[] | null;
  initialColorMode: "auto" | "light" | "dark" | null;
  systemDark: boolean;
  onSave: (colors: string[] | null, colorMode: "auto" | "light" | "dark" | null) => void;
  onPreview: (colors: string[] | null, colorMode: "auto" | "light" | "dark" | null) => void;
}

function PresetSwatch({ preset, onClick }: {
  preset: ColorPreset;
  onClick: () => void;
}) {
  const bg = preset.colors.length === 1
    ? preset.colors[0]
    : `linear-gradient(135deg, ${preset.colors.join(", ")})`;

  return (
    <button
      onClick={onClick}
      className="size-8 shrink-0 rounded-full border-2 border-transparent transition-all hover:border-muted-foreground/50"
      style={{ background: bg }}
    />
  );
}

export function SpaceColorPicker({ initialColors, initialColorMode, systemDark, onSave, onPreview }: SpaceColorPickerProps) {
  const [colors, setColors] = useState<string[] | null>(initialColors);
  const [colorMode, setColorMode] = useState<"auto" | "light" | "dark">(initialColorMode ?? "auto");
  const [numPoints, setNumPoints] = useState(() => initialColors?.length ?? 3);
  const initialPosition = useMemo(
    () => initialColors ? deriveAngleRadius(initialColors) : null,
    [initialColors],
  );
  const [paletteIndex, setPaletteIndex] = useState(() => {
    if (!initialColors) return 0;
    const numPts = initialColors.length;
    const pos = initialColors ? deriveAngleRadius(initialColors) : null;
    if (!pos) return 0;
    for (let i = 0; i < PALETTE_PAGES.length; i++) {
      for (const preset of PALETTE_PAGES[i].presets) {
        if (preset.numPoints !== numPts) continue;
        if (Math.abs(preset.angle - pos.angle) < 0.15 && Math.abs(preset.radius - pos.radius) < 10) {
          return i;
        }
      }
    }
    return 0;
  });
  const [pickerAngle, setPickerAngle] = useState<number | undefined>(initialPosition?.angle);
  const [pickerRadius, setPickerRadius] = useState<number | undefined>(initialPosition?.radius);
  const colorsRef = useRef<string[] | null>(initialColors);

  const handleColorChange = useCallback((newColors: string[]) => {
    colorsRef.current = newColors;
    setColors(newColors);
  }, []);

  const handleStateChange = useCallback((_state: { angle: number; radius: number }) => {
  }, []);

  const handlePresetSelect = useCallback((preset: ColorPreset) => {
    setNumPoints(preset.numPoints);
    setPickerAngle(preset.angle);
    setPickerRadius(preset.radius);
  }, []);

  const isDirty = useMemo(() => {
    const currentColors = colorsRef.current;
    if (currentColors === null && initialColors === null) return colorMode !== (initialColorMode ?? "auto");
    if (currentColors === null || initialColors === null) return true;
    if (currentColors.length !== initialColors.length) return true;
    return currentColors.some((c, i) => c !== initialColors[i]) || colorMode !== (initialColorMode ?? "auto");
  }, [colors, colorMode, initialColors, initialColorMode]);

  useEffect(() => {
    onPreview(colorsRef.current, colorsRef.current ? colorMode : null);
  }, [colors, colorMode, onPreview]);

  const handleSave = useCallback(() => {
    onSave(colorsRef.current, colorsRef.current ? colorMode : null);
  }, [colorMode, onSave]);

  const page = PALETTE_PAGES[paletteIndex];

  const colorTransform = useMemo(() => {
    return (hex: string) => adjustColorsForMode([hex], colorMode, systemDark)[0];
  }, [colorMode, systemDark]);

  const modes = [
    { mode: "auto" as const, icon: Sparkles, label: "Automatic" },
    { mode: "light" as const, icon: Sun, label: "Light" },
    { mode: "dark" as const, icon: Moon, label: "Dark" },
  ];

  return (
    <div className="flex flex-col items-center gap-2 px-3 py-3">
      <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
        {modes.map(({ mode, icon: Icon, label }) => (
          <Tooltip key={mode}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setColorMode(mode)}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                  colorMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <ColorPicker
        size={240}
        numPoints={numPoints}
        initialAngle={pickerAngle}
        initialRadius={pickerRadius}
        colorTransform={colorTransform}
        onColorChange={handleColorChange}
        onStateChange={handleStateChange}
      />

      <div className="flex items-center gap-2">
        <button
          className="flex size-7 items-center justify-center rounded text-xl text-muted-foreground transition-all hover:bg-muted disabled:opacity-30"
          onClick={() => setNumPoints((n) => Math.max(1, n - 1))}
          disabled={numPoints <= 1}
        >
          <Minus className="size-4" />
        </button>
        <button
          className="flex size-7 items-center justify-center rounded text-xl text-muted-foreground transition-all hover:bg-muted disabled:opacity-30"
          onClick={() => setNumPoints((n) => Math.min(3, n + 1))}
          disabled={numPoints >= 3}
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="flex w-full items-center gap-1.5">
        <button
          onClick={() => setPaletteIndex((i) => (i - 1 + PALETTE_PAGES.length) % PALETTE_PAGES.length)}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted transition-colors"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <div className="flex flex-1 items-center justify-center gap-1.5">
          {page.presets.map((preset, i) => (
            <PresetSwatch
              key={`${paletteIndex}-${i}`}
              preset={preset}
              onClick={() => handlePresetSelect(preset)}
            />
          ))}
        </div>
        <button
          onClick={() => setPaletteIndex((i) => (i + 1) % PALETTE_PAGES.length)}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted transition-colors"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      <p className="text-xs text-muted-foreground">{page.name}</p>

      <button
        onClick={handleSave}
        disabled={!isDirty}
        className="mt-1 w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:pointer-events-none"
      >
        Save
      </button>
    </div>
  );
}
