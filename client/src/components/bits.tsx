import { cn } from "@/lib/utils";
import { STAT_KEYS, STAT_LABEL, STAT_SHORT, type Furniture, type StatKey, dominantStat, UTILITY_NOTE } from "@/lib/data";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-label="Mewgenics House Planner logo" fill="none">
      <path
        d="M6 13 L6 5 L12 10 L20 10 L26 5 L26 13 L26 26 L6 26 Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M11 17h4v4h-4zM17 17h4v4h-4z" fill="currentColor" opacity=".9" />
      <path d="M11 23h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".6" />
    </svg>
  );
}

export function StatChips({
  stats,
  mult = 1,
  className,
  size = "sm",
  itemId,
}: {
  stats: Partial<Record<StatKey, number>>;
  mult?: number;
  className?: string;
  size?: "xs" | "sm";
  /** item id, used to show a house-wide job for pieces without room stats */
  itemId?: string;
}) {
  const entries = STAT_KEYS.filter((k) => (stats[k] ?? 0) !== 0);
  if (!entries.length)
    return <span className="text-xs text-muted-foreground">{(itemId && UTILITY_NOTE[itemId]) || "no stats"}</span>;
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)}>
      {entries.map((k) => {
        const v = (stats[k] ?? 0) * mult;
        return (
          <span
            key={k}
            title={STAT_LABEL[k]}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm px-1.5 font-mono tabular-nums leading-5",
              size === "xs" ? "text-[11px]" : "text-xs",
              v < 0 ? "opacity-70" : "",
            )}
            style={{
              background: `hsl(var(--stat-${k}) / ${v < 0 ? 0.1 : 0.18})`,
              color: `hsl(var(--stat-${k}))`,
            }}
          >
            {v > 0 ? "+" : ""}
            {v} {STAT_SHORT[k]}
          </span>
        );
      })}
    </span>
  );
}

/** Tiny preview of a piece's tile footprint. */
export function Glyph({ f, cell = 5, className }: { f: Furniture; cell?: number; className?: string }) {
  const dom = dominantStat(f);
  const color = dom ? `hsl(var(--stat-${dom}))` : "hsl(var(--stat-none))";
  const W = Math.max(f.w, 1);
  const H = Math.max(f.h, 1);
  const s = Math.min(cell, 28 / Math.max(W, H));
  return (
    <svg
      width={Math.max(28, W * s)}
      height={Math.max(28, H * s)}
      viewBox={`0 0 ${Math.max(28, W * s)} ${Math.max(28, H * s)}`}
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <g transform={`translate(${(Math.max(28, W * s) - W * s) / 2} ${(Math.max(28, H * s) - H * s) / 2})`}>
        {f.cells.map(([x, y, t], i) => {
          const px = x * s;
          const py = (H - 1 - y) * s;
          if (t === 1)
            return <rect key={i} x={px + 0.3} y={py + 0.3} width={s - 0.6} height={s - 0.6} fill={color} rx={0.8} />;
          if (t === 2)
            return (
              <g key={i}>
                <rect x={px + 0.3} y={py + 0.3} width={s - 0.6} height={s - 0.6} fill={color} opacity={0.55} rx={0.8} />
                <rect x={px} y={py} width={s} height={1.2} fill="currentColor" opacity={0.8} />
              </g>
            );
          if (t === 3)
            return <rect key={i} x={px + s * 0.3} y={py + s * 0.3} width={s * 0.4} height={s * 0.4} fill="currentColor" opacity={0.35} />;
          if (t === 4)
            return <rect key={i} x={px + 0.6} y={py + 0.6} width={s - 1.2} height={s - 1.2} fill="none" stroke={color} strokeWidth={0.6} strokeDasharray="1 0.8" opacity={0.8} />;
          return null;
        })}
      </g>
    </svg>
  );
}

export function tilesLabel(f: Furniture) {
  const body = f.cells.filter((c) => c[2] === 1 || c[2] === 2).length;
  const surf = f.cells.filter((c) => c[2] === 2).length;
  const head = f.cells.filter((c) => c[2] === 4).length;
  return `${body} tile${body === 1 ? "" : "s"}${surf ? `, ${surf} stackable` : ""}${head ? `, +${head} headroom` : ""}`;
}
