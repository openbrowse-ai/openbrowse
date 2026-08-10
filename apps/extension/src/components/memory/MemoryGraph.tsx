// src/components/memory/MemoryGraph.tsx
//
// Obsidian-style force-directed view of the memory `[[wikilink]]` graph.
//
// Deliberately dependency-free: a small velocity-damped force simulation
// (pairwise repulsion + edge springs + weak centering) stepped in
// requestAnimationFrame, rendered as SVG. Memory stores are tens-to-low-
// hundreds of notes, so O(n^2) repulsion and SVG hit-testing are plenty fast
// and we avoid adding a graph library to the bundle.
//
// Interactions: wheel to zoom about the cursor, drag the background to pan,
// drag a node (it keeps momentum on release — the springs pull it back),
// hover for a tooltip, click to open the note. Nodes are also tabbable, with
// Enter/Space as the keyboard equivalent of a click.

import { parseMemoryPath } from "@/lib/memory/format";
import type { GraphEdge, GraphNode } from "@/lib/memory/store";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Simulation tuning ──────────────────────────────────────────────────────
const REPULSION = 7000;
const SPRING = 0.015;
const REST_LENGTH = 110;
const CENTER_PULL = 0.004;
const DAMPING = 0.87;
/** Below this total kinetic energy the layout is considered settled. */
const SETTLE_ENERGY = 0.05;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3.5;
/** Pointer travel (px) beyond which a press is a drag, not a click. */
const CLICK_SLOP = 4;

// ── Visual tuning ──────────────────────────────────────────────────────────
/** Stroke width (screen px) for edges. Nodes are borderless. */
const EDGE_STROKE = 0.8;
/** Opacity applied to nodes/edges unrelated to the hovered node. */
const UNRELATED_OPACITY = 0.3;
/** Node scale-up on hover. */
const HOVER_SCALE = 1.3;
/** How far (screen px) the label slides down on hover. */
const LABEL_DROP = 7;
const TRANSITION = "150ms ease-out";

/**
 * Hover accent. NOTE: the theme's `--primary` is a near-black warm neutral
 * (`oklch(0.22 0.01 75)`), so `stroke-primary` renders black, not blue. The
 * app's blue tint is `blue-500` / `blue-400` (as used for drag-over states).
 */
const ACCENT_FILL = "fill-blue-500 dark:fill-blue-400";
const ACCENT_STROKE = "stroke-blue-500 dark:stroke-blue-400";

/**
 * Node fills are **opaque** — faded by mixing toward the background rather
 * than by alpha, so edges never show through a node. (`fill-foreground/40`
 * would be translucent and let edges bleed through.)
 */
function nodeFill(n: GraphNode, hovered: boolean): string {
  if (hovered) return "var(--node-accent)";
  if (n.dangling)
    return "color-mix(in oklab, var(--muted-foreground) 26%, var(--background))";
  if (n.scope === "space")
    return "color-mix(in oklab, var(--muted-foreground) 55%, var(--background))";
  return "color-mix(in oklab, var(--foreground) 42%, var(--background))";
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface View {
  x: number;
  y: number;
  k: number;
}

function nodeRadius(n: GraphNode): number {
  return 3.5 + Math.min(4.5, Math.sqrt(n.backlinks) * 1.8);
}

/**
 * Deterministic initial ring layout. Starting every node at the same point
 * makes repulsion explode, and randomness makes the view jump between opens.
 */
function seedPositions(nodes: GraphNode[], w: number, h: number): SimNode[] {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.max(80, Math.min(w, h) * 0.32);
  return nodes.map((n, i) => {
    // Golden-angle spiral: even spread, stable per index.
    const angle = i * 2.399963;
    const r = radius * Math.sqrt((i + 1) / nodes.length);
    return {
      ...n,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0,
      vy: 0,
    };
  });
}

export function MemoryGraph({
  nodes,
  edges,
  onOpenNode,
  className,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Open a real (non-dangling) note. */
  onOpenNode: (path: string) => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [, setFrame] = useState(0);
  const [hover, setHover] = useState<{
    node: SimNode;
    sx: number;
    sy: number;
  } | null>(null);

  const simRef = useRef<SimNode[]>([]);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<{
    node: SimNode;
    wx: number;
    wy: number;
    vx: number;
    vy: number;
  } | null>(null);
  const panRef = useRef<{
    sx: number;
    sy: number;
    vx: number;
    vy: number;
  } | null>(null);
  const movedRef = useRef(0);

  // Neighbour map for hover highlighting.
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      const s = m.get(a);
      if (s) s.add(b);
      else m.set(a, new Set([b]));
    };
    for (const e of edges) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return m;
  }, [edges]);

  // Track container size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // (Re)seed the simulation when the graph data changes.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    simRef.current = seedPositions(nodes, size.w, size.h);
    setView({ x: 0, y: 0, k: 1 });
    setFrame((f) => f + 1);
    // Only reseed on data change, not on every resize tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, size.w === 0 || size.h === 0]);

  const step = useCallback(() => {
    const sim = simRef.current;
    const n = sim.length;
    if (n === 0) return 0;
    const cx = size.w / 2;
    const cy = size.h / 2;

    // Pairwise repulsion.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = sim[i];
        const b = sim[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Deterministic nudge so coincident nodes separate.
          dx = (i % 2 === 0 ? 1 : -1) * 0.5;
          dy = (j % 2 === 0 ? 1 : -1) * 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = REPULSION / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Edge springs.
    const byId = new Map(sim.map((s) => [s.id, s]));
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = SPRING * (d - REST_LENGTH);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Weak centering + integrate.
    let energy = 0;
    const dragged = dragRef.current?.node;
    for (const s of sim) {
      s.vx += (cx - s.x) * CENTER_PULL;
      s.vy += (cy - s.y) * CENTER_PULL;
      s.vx *= DAMPING;
      s.vy *= DAMPING;
      if (s === dragged) {
        // Pinned to the pointer; momentum is applied on release.
        s.vx = 0;
        s.vy = 0;
        continue;
      }
      s.x += s.vx;
      s.y += s.vy;
      energy += s.vx * s.vx + s.vy * s.vy;
    }
    return energy;
  }, [edges, size.w, size.h]);

  // Animation loop — stops when settled, restarts on data/interaction.
  useEffect(() => {
    if (size.w === 0 || simRef.current.length === 0) return;
    let stop = false;
    const tick = () => {
      if (stop) return;
      const energy = step();
      setFrame((f) => f + 1);
      if (energy > SETTLE_ENERGY || dragRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stop = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [step, size.w, nodes]);

  /** Kick the loop back on after an interaction. */
  const reheat = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const energy = step();
      setFrame((f) => f + 1);
      if (energy > SETTLE_ENERGY || dragRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [step]);

  // Zoom about the cursor. Registered natively with `passive: false` because
  // React attaches `wheel` at the root as passive, where preventDefault() is
  // ignored (the page would scroll instead of the graph zooming).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const k = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * 0.0015)),
        );
        const ratio = k / v.k;
        return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
      });
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      const px = clientX - (rect?.left ?? 0);
      const py = clientY - (rect?.top ?? 0);
      return { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
    },
    [view],
  );

  // ── Pointer handling ─────────────────────────────────────────────────────

  const onNodePointerDown = (e: React.PointerEvent, node: SimNode) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = { node, wx: w.x, wy: w.y, vx: 0, vy: 0 };
    movedRef.current = 0;
    reheat();
  };

  const onPointerDownBg = (e: React.PointerEvent) => {
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: 0, vy: 0 };
    movedRef.current = 0;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      const w = toWorld(e.clientX, e.clientY);
      // Pointer delta in world units becomes the node's release velocity.
      drag.vx = w.x - drag.wx;
      drag.vy = w.y - drag.wy;
      drag.wx = w.x;
      drag.wy = w.y;
      drag.node.x = w.x;
      drag.node.y = w.y;
      movedRef.current += Math.abs(drag.vx) + Math.abs(drag.vy);
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const dx = e.clientX - pan.sx;
      const dy = e.clientY - pan.sy;
      pan.sx = e.clientX;
      pan.sy = e.clientY;
      movedRef.current += Math.abs(dx) + Math.abs(dy);
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  };

  const endPointer = () => {
    const drag = dragRef.current;
    if (drag) {
      // Inertia: hand the node the pointer's last velocity so it coasts and
      // the springs settle it back into place.
      drag.node.vx = drag.vx;
      drag.node.vy = drag.vy;
      dragRef.current = null;
      reheat();
    }
    panRef.current = null;
  };

  const sim = simRef.current;
  const byId = useMemo(() => new Map(sim.map((s) => [s.id, s])), [sim]);
  const hoverId = hover?.node.id ?? null;
  const hoverSet = hoverId ? neighbours.get(hoverId) : undefined;
  // Constant on-screen sizes regardless of zoom.
  const inv = 1 / view.k;

  return (
    <div
      ref={wrapRef}
      className={cn("relative h-full w-full overflow-hidden", className)}
    >
      <svg
        className="h-full w-full touch-none select-none [--node-accent:var(--color-blue-500)] dark:[--node-accent:var(--color-blue-400)]"
        style={{ cursor: panRef.current ? "grabbing" : "grab" }}
        // Named via `aria-label` rather than an SVG `<title>`, which browsers
        // surface as a native tooltip that would fight the hover tooltip below.
        role="img"
        aria-label="Memory note graph"
        onPointerDown={onPointerDownBg}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={endPointer}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const a = byId.get(e.source);
            const b = byId.get(e.target);
            if (!a || !b) return null;
            const connected =
              hoverId !== null &&
              (e.source === hoverId || e.target === hoverId);
            const unrelated = hoverId !== null && !connected;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={
                  connected ? ACCENT_STROKE : "stroke-muted-foreground/25"
                }
                strokeWidth={EDGE_STROKE * inv}
                opacity={unrelated ? UNRELATED_OPACITY : 1}
                style={{ transition: `opacity ${TRANSITION}` }}
              />
            );
          })}
          {sim.map((n) => {
            const r = nodeRadius(n);
            const hovered = n.id === hoverId;
            const unrelated =
              hoverId !== null && !hovered && !hoverSet?.has(n.id);
            return (
              <g
                key={n.id}
                // NOTE: no CSS transition on this transform — the simulation
                // rewrites it every frame, so animating it would lag motion.
                transform={`translate(${n.x},${n.y})`}
                opacity={unrelated ? UNRELATED_OPACITY : 1}
                style={{
                  cursor: n.dangling ? "default" : "pointer",
                  transition: `opacity ${TRANSITION}`,
                }}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onPointerEnter={(e) =>
                  setHover({ node: n, sx: e.clientX, sy: e.clientY })
                }
                onPointerLeave={() => setHover(null)}
                onClick={() => {
                  if (movedRef.current > CLICK_SLOP) return;
                  if (n.path) onOpenNode(n.path);
                }}
                // Keyboard equivalent of the click above. Dangling nodes have
                // no note to open, so they stay out of the tab order.
                tabIndex={n.path ? 0 : undefined}
                role={n.path ? "button" : undefined}
                aria-label={n.path ? `Open note: ${n.title}` : undefined}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  // Space would otherwise scroll the surrounding pane.
                  e.preventDefault();
                  if (n.path) onOpenNode(n.path);
                }}
              >
                <circle
                  // `r` is untouched by the simulation, so it's safe to
                  // transition for the hover scale-up. Borderless (no stroke):
                  // the fill alone carries the node.
                  r={hovered ? r * HOVER_SCALE : r}
                  style={{
                    fill: nodeFill(n, hovered),
                    transition: `r ${TRANSITION}, fill ${TRANSITION}`,
                  }}
                />
                <text
                  y={r + 11 * inv}
                  textAnchor="middle"
                  fontSize={11 * inv}
                  className={cn(
                    "pointer-events-none",
                    hovered ? ACCENT_FILL : "fill-muted-foreground/70",
                  )}
                  style={{
                    transform: hovered
                      ? `translateY(${LABEL_DROP * inv}px)`
                      : undefined,
                    transition: `transform ${TRANSITION}`,
                  }}
                >
                  {n.slug}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Hover tooltip */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
          style={{
            left: Math.min(
              (hover.sx ?? 0) -
                (wrapRef.current?.getBoundingClientRect().left ?? 0) +
                12,
              Math.max(0, size.w - 260),
            ),
            top:
              (hover.sy ?? 0) -
              (wrapRef.current?.getBoundingClientRect().top ?? 0) +
              12,
          }}
        >
          <div className="text-xs font-medium">{hover.node.title}</div>
          {hover.node.description && (
            <div className="mt-0.5 text-[11px] text-muted-foreground line-clamp-3">
              {hover.node.description}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            {hover.node.dangling ? (
              <span>No note yet — referenced by a link</span>
            ) : (
              <>
                <span className="font-mono">
                  {parseMemoryPath(hover.node.path ?? "")?.relPath ??
                    hover.node.path}
                </span>
                <span>· {hover.node.backlinks} in</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        {[
          { label: "Zoom in", delta: 1.25, glyph: "+" },
          { label: "Zoom out", delta: 0.8, glyph: "−" },
        ].map((b) => (
          <button
            key={b.label}
            type="button"
            aria-label={b.label}
            className="size-7 rounded-md border border-border bg-background/90 text-sm text-muted-foreground hover:text-foreground"
            onClick={() =>
              setView((v) => {
                const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * b.delta));
                const ratio = k / v.k;
                const px = size.w / 2;
                const py = size.h / 2;
                return {
                  k,
                  x: px - (px - v.x) * ratio,
                  y: py - (py - v.y) * ratio,
                };
              })
            }
          >
            {b.glyph}
          </button>
        ))}
      </div>
    </div>
  );
}
