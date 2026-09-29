import { useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, CircleCheck, CircleAlert, Sparkles } from "lucide-react";
import { FURNITURE_BY_ID, STAT_KEYS, STAT_LABEL, dominantStat, statsOf, type RoomDef, type StatKey } from "@/lib/data";
import type { Placement, RoomGoal, RoomResult } from "@/lib/optimizer";
import { PRESETS, PRESET_BY_ID, STIM_BREAKPOINTS, goalFromPreset } from "@/lib/presets";
import { StatChips } from "./bits";
import { cn } from "@/lib/utils";

const C = 20; // svg units per tile

export function RoomCard({
  def,
  goal,
  result,
  onGoal,
  stale,
  focus,
  onFocus,
}: {
  def: RoomDef;
  goal: RoomGoal;
  result: RoomResult | undefined;
  onGoal: (g: RoomGoal) => void;
  stale: boolean;
  /** item hovered anywhere in the app (inventory list or another room) */
  focus: string | null;
  onFocus: (itemId: string | null) => void;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const setHover = (i: number | null) => {
    setHoverIdx(i);
    onFocus(i === null ? null : result?.placements[i]?.itemId ?? null);
  };
  const hover = hoverIdx;
  // what the focused piece contributes to this room, shown on the stat strip
  const focusStats = useMemo(() => {
    if (!focus || !result) return null;
    const mine = result.placements.filter((p) => p.itemId === focus);
    if (!mine.length) return null;
    const sum: Record<StatKey, number> = { c: 0, s: 0, h: 0, m: 0, a: 0 };
    for (const p of mine) {
      const st = statsOf(FURNITURE_BY_ID[p.itemId], p.rare);
      for (const k of STAT_KEYS) sum[k] += st[k] ?? 0;
    }
    return { sum, n: mine.length };
  }, [focus, result]);
  const preset = PRESET_BY_ID[goal.preset];
  const primary: StatKey | null = goal.target?.stat ?? preset?.primary ?? null;

  return (
    <Card className="overflow-hidden" data-testid={`card-room-${def.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">{def.label}</h3>
          <p className="text-xs text-muted-foreground">
            {def.w - 2}×{def.h - 2} tiles · {def.free} usable
            {result ? ` · ${result.usedCells} filled · ${result.placements.length} pieces` : ""}
          </p>
        </div>
        {result && (
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
              result.goalMet ? "text-[hsl(var(--stat-m))]" : "text-[hsl(var(--stat-s))]",
            )}
            data-testid={`status-goal-${def.id}`}
          >
            {result.goalMet ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
            {result.goalMet ? "Goal met" : result.notes.join(" · ")}
          </div>
        )}
      </div>

      <GoalControls goal={goal} onGoal={onGoal} roomId={def.id} />

      <StatStrip result={result} goal={goal} primary={primary} focus={focusStats} />

      <div className={cn("px-4 pb-4 transition-opacity", stale && "opacity-60")}>
        <RoomGrid def={def} result={result} hover={hover} setHover={setHover} focus={focus} />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Light top edge = stackable surface. Dashed outline = headroom the piece needs (like the spider on Spider TV):
          nothing from the room can be there, but other furniture can sit in it.
          {def.noHang ? " The attic roof has no bolts, so nothing hangs from it here." : ""}
        </p>
      </div>

      {result && result.placements.length > 0 && (
        <Steps result={result} hover={hover} setHover={setHover} />
      )}
    </Card>
  );
}

function GoalControls({ goal, onGoal, roomId }: { goal: RoomGoal; onGoal: (g: RoomGoal) => void; roomId: string }) {
  const preset = PRESET_BY_ID[goal.preset];
  const targetStat: StatKey | null = goal.target?.stat ?? (preset?.primary && preset.primary !== "a" ? preset.primary : null);
  return (
    <div className="grid gap-3 border-b border-border px-4 py-3 sm:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Room goal</Label>
        <Select value={goal.preset} onValueChange={(v) => onGoal(goalFromPreset(roomId, v))}>
          <SelectTrigger className="h-9" data-testid={`select-preset-${roomId}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
            {goal.preset === "custom" && <SelectItem value="custom">Custom weights</SelectItem>}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {preset?.hint ?? "Custom weights"}
          {goal.mins && Object.keys(goal.mins).length > 0 && (
            <span className="block text-foreground/70">
              Floors: {Object.entries(goal.mins).map(([k, v]) => `${STAT_LABEL[k as StatKey]} ≥ ${v}`).join(", ")}
            </span>
          )}
        </p>
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          Target {targetStat ? STAT_LABEL[targetStat] : ""}
        </Label>
        <Input
          type="number"
          inputMode="numeric"
          className="h-9 font-mono"
          placeholder="No cap"
          disabled={!targetStat}
          value={goal.target?.value ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            onGoal({ ...goal, target: v === null || !targetStat ? null : { stat: targetStat, value: v } });
          }}
          data-testid={`input-target-${roomId}`}
        />
        {targetStat === "s" && (
          <div className="flex gap-1">
            {STIM_BREAKPOINTS.map((b) => (
              <button
                key={b.value}
                type="button"
                title={b.label}
                onClick={() => onGoal({ ...goal, target: { stat: "s", value: b.value } })}
                className={cn(
                  "rounded-sm border border-border px-1.5 font-mono text-[11px] leading-5 hover:border-primary",
                  goal.target?.value === b.value && "border-primary text-primary",
                )}
                data-testid={`button-breakpoint-${roomId}-${b.value}`}
              >
                {b.value}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          {goal.maxComfort !== null ? "Max Comfort" : "Min Comfort"}
        </Label>
        <Input
          type="number"
          className="h-9 font-mono"
          placeholder="Any"
          value={(goal.maxComfort !== null ? goal.maxComfort : goal.minComfort) ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            if (goal.maxComfort !== null) onGoal({ ...goal, maxComfort: v });
            else onGoal({ ...goal, minComfort: v });
          }}
          data-testid={`input-comfort-${roomId}`}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Cats in room</Label>
        <Input
          type="number"
          min={0}
          className="h-9 font-mono"
          value={goal.cats}
          onChange={(e) => onGoal({ ...goal, cats: Math.max(0, Number(e.target.value) || 0) })}
          data-testid={`input-cats-${roomId}`}
        />
        <p className="text-[11px] text-muted-foreground">Each cat past 4 costs 1 Comfort</p>
      </div>
      <Collapsible className="sm:col-span-4">
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid={`button-weights-${roomId}`}>
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
          Fine-tune weights
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["s", "h", "m", "c"] as StatKey[]).map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs">
                <span className="w-20" style={{ color: `hsl(var(--stat-${k}))` }}>
                  {STAT_LABEL[k]}
                </span>
                <Input
                  type="number"
                  step="0.05"
                  className="h-8 font-mono"
                  value={goal.weights[k] ?? 0}
                  onChange={(e) =>
                    onGoal({ ...goal, preset: "custom", weights: { ...goal.weights, [k]: Number(e.target.value) || 0 } })
                  }
                  data-testid={`input-weight-${roomId}-${k}`}
                />
              </label>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["h", "m", "s"] as StatKey[]).map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs">
                <span className="w-20 text-muted-foreground">Min {STAT_LABEL[k]}</span>
                <Input
                  type="number"
                  className="h-8 font-mono"
                  placeholder="None"
                  value={goal.mins?.[k] ?? ""}
                  onChange={(e) => {
                    const mins = { ...(goal.mins ?? {}) };
                    if (e.target.value === "") delete mins[k];
                    else mins[k] = Number(e.target.value);
                    onGoal({ ...goal, mins });
                  }}
                  data-testid={`input-min-${roomId}-${k}`}
                />
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Score = sum of weight × stat, minus a penalty for every point a floor is missed. Health 10+ cures disorders;
            Mutation above 10 rolls full mutations. Appeal is house-wide and set in the top bar.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function StatStrip({
  result,
  goal,
  primary,
  focus,
}: {
  result: RoomResult | undefined;
  goal: RoomGoal;
  primary: StatKey | null;
  focus: { sum: Record<StatKey, number>; n: number } | null;
}) {
  return (
    <div className="grid grid-cols-5 gap-px border-b border-border bg-border">
      {STAT_KEYS.map((k) => {
        const v = result?.stats[k] ?? 0;
        const isPrimary = k === primary;
        const target = goal.target?.stat === k ? goal.target.value : null;
        const delta = focus?.sum[k] ?? 0;
        return (
          <div key={k} className="relative bg-card px-3 py-2" data-testid={`stat-${goal.roomId}-${k}`}>
            {focus && delta !== 0 && (
              <span
                className="absolute right-2 top-1.5 rounded-sm px-1 font-mono text-[11px] font-semibold"
                style={{ color: `hsl(var(--stat-${k}))`, background: `hsl(var(--stat-${k}) / 0.15)` }}
                data-testid={`stat-delta-${goal.roomId}-${k}`}
              >
                {delta > 0 ? `+${delta}` : delta}
              </span>
            )}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span style={isPrimary ? { color: `hsl(var(--stat-${k}))` } : undefined}>
                {STAT_LABEL[k]}
                {k === "a" ? " (house)" : ""}
                {k === "c" && goal.cats > 4 ? ` (after ${goal.cats} cats)` : ""}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span
                className={cn("font-mono text-lg font-semibold tabular-nums", isPrimary ? "" : "text-foreground/80")}
                style={isPrimary ? { color: `hsl(var(--stat-${k}))` } : undefined}
              >
                {v}
              </span>
              {target !== null && <span className="font-mono text-xs text-muted-foreground">/ {target}</span>}
            </div>
            {target !== null && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, Math.max(0, (v / target) * 100))}%`, background: `hsl(var(--stat-${k}))` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function placementLabel(p: Placement, placements: Placement[]) {
  const f = FURNITURE_BY_ID[p.itemId];
  const xs = f.cells.filter((c) => c[2] === 1 || c[2] === 2).map((c) => c[0] + p.x);
  const ys = f.cells.filter((c) => c[2] === 1 || c[2] === 2).map((c) => c[1] + p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const col = x0 === x1 ? `col ${x0}` : `cols ${x0}–${x1}`;
  const row = y0 === y1 ? `row ${y0}` : `rows ${y0}–${y1}`;
  let rests = "";
  if (p.restsOn === "floor") rests = "on the floor";
  else if (p.restsOn === "ceiling") rests = "hung from the ceiling";
  else if (p.restsOn === "wall") rests = "on the wall";
  else if (p.restsOn === "item" && p.hostIndex !== null) {
    const h = placements[p.hostIndex];
    rests = `on ${FURNITURE_BY_ID[h.itemId].name} (step ${h.step})`;
  }
  return { col, row, rests };
}

function RoomGrid({
  def,
  result,
  hover,
  setHover,
  focus,
}: {
  def: RoomDef;
  result: RoomResult | undefined;
  hover: number | null;
  setHover: (i: number | null) => void;
  focus: string | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const { w: W, h: H } = def;

  const base = useMemo(() => {
    const cells: JSX.Element[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = def.grid[y][x];
        const px = x * C;
        const py = (H - 1 - y) * C;
        if (v === "0") cells.push(<rect key={`f${x}-${y}`} x={px} y={py} width={C} height={C} fill="hsl(var(--room-free))" stroke="hsl(var(--room-grid))" strokeWidth={0.6} />);
        else {
          cells.push(<rect key={`b${x}-${y}`} x={px} y={py} width={C} height={C} fill="hsl(var(--room-block))" />);
          const isFloor = y + 1 < H && def.grid[y + 1][x] === "0";
          const isCeil = y > 0 && def.grid[y - 1][x] === "0";
          if (v === "2" && (isFloor || isCeil)) {
            // surface edge: floor line on top of a floor cell, ceiling line under a ceiling cell
            cells.push(
              <rect
                key={`s${x}-${y}`}
                x={px}
                y={isFloor ? py : py + C - 2.5}
                width={C}
                height={2.5}
                fill="hsl(var(--primary))"
                opacity={isFloor ? 0.9 : 0.45}
              />,
            );
          }
        }
      }
    }
    return cells;
  }, [def, W, H]);

  const items = result?.placements ?? [];
  const hovered = hover !== null ? items[hover] : null;
  const focusHere = focus !== null && items.some((p) => p.itemId === focus);

  return (
    <div
      ref={wrap}
      className="relative mt-3"
      onMouseLeave={() => {
        setHover(null);
        setTip(null);
      }}
      onMouseMove={(e) => {
        setTip({ x: e.clientX, y: e.clientY });
      }}
    >
      <svg viewBox={`0 0 ${W * C} ${(H + 1) * C}`} className="block w-full" role="img" aria-label={`Layout for ${def.label}`}>
        {base}
        {items.map((p, i) => {
          const f = FURNITURE_BY_ID[p.itemId];
          const dom = dominantStat(f);
          const color = dom ? `hsl(var(--stat-${dom}))` : "hsl(var(--stat-none))";
          const body = f.cells.filter((c) => c[2] === 1 || c[2] === 2);
          const set = new Set(body.map((c) => `${c[0]},${c[1]}`));
          const edges: JSX.Element[] = [];
          for (const [dx, dy] of body) {
            const px = (p.x + dx) * C;
            const py = (H - 1 - (p.y + dy)) * C;
            if (!set.has(`${dx},${dy + 1}`)) edges.push(<line key={`t${dx}-${dy}`} x1={px} y1={py} x2={px + C} y2={py} />);
            if (!set.has(`${dx},${dy - 1}`)) edges.push(<line key={`b${dx}-${dy}`} x1={px} y1={py + C} x2={px + C} y2={py + C} />);
            if (!set.has(`${dx - 1},${dy}`)) edges.push(<line key={`l${dx}-${dy}`} x1={px} y1={py} x2={px} y2={py + C} />);
            if (!set.has(`${dx + 1},${dy}`)) edges.push(<line key={`r${dx}-${dy}`} x1={px + C} y1={py} x2={px + C} y2={py + C} />);
          }
          const cx = body.reduce((a, c) => a + c[0], 0) / body.length;
          const cy = body.reduce((a, c) => a + c[1], 0) / body.length;
          const isHover = hover === i || (focusHere && p.itemId === focus);
          const dim = (hover !== null || focusHere) && !isHover;
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              style={{ cursor: "default", opacity: dim ? 0.4 : 1, transition: "opacity 120ms" }}
              data-testid={`grid-item-${def.id}-${i}`}
            >
              {f.cells
                .filter((c) => c[2] === 4)
                .map(([dx, dy]) => (
                  <rect
                    key={`h${dx}-${dy}`}
                    x={(p.x + dx) * C + 2}
                    y={(H - 1 - (p.y + dy)) * C + 2}
                    width={C - 4}
                    height={C - 4}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.2}
                    strokeDasharray="3 2"
                    opacity={0.85}
                  />
                ))}
              {body.map(([dx, dy, t]) => (
                <rect
                  key={`${dx}-${dy}`}
                  x={(p.x + dx) * C}
                  y={(H - 1 - (p.y + dy)) * C}
                  width={C}
                  height={C}
                  fill={color}
                  opacity={t === 2 ? 0.72 : 0.92}
                />
              ))}
              {body
                .filter((c) => c[2] === 2)
                .map(([dx, dy]) => (
                  <rect
                    key={`st${dx}-${dy}`}
                    x={(p.x + dx) * C + 1}
                    y={(H - 1 - (p.y + dy)) * C + 1}
                    width={C - 2}
                    height={2}
                    fill="hsl(var(--foreground))"
                    opacity={0.55}
                  />
                ))}
              <g stroke={isHover ? "hsl(var(--foreground))" : p.rare ? "hsl(var(--rare))" : "hsl(var(--room-block))"} strokeWidth={isHover ? 2.6 : p.rare ? 2 : 1.4}>
                {edges}
              </g>
              <text
                x={(p.x + cx) * C + C / 2}
                y={(H - 1 - (p.y + cy)) * C + C / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={C * 0.46}
                fontFamily="var(--font-mono)"
                fontWeight={600}
                fill="hsl(var(--card))"
                stroke="hsl(var(--room-block))"
                strokeWidth={0.7}
                paintOrder="stroke"
                style={{ pointerEvents: "none" }}
              >
                {p.step}
              </text>
            </g>
          );
        })}
        {/* column ruler */}
        {Array.from({ length: W - 2 }, (_, i) => i + 1).map((x) => (
          <text
            key={`cx${x}`}
            x={x * C + C / 2}
            y={H * C + C * 0.6}
            textAnchor="middle"
            fontSize={C * 0.42}
            fontFamily="var(--font-mono)"
            fill="hsl(var(--muted-foreground))"
          >
            {x % 2 === 1 || W < 24 ? x : ""}
          </text>
        ))}
      </svg>

      {hovered && tip && <Tooltip p={hovered} placements={items} x={tip.x} y={tip.y} />}
    </div>
  );
}

function Tooltip({ p, placements, x, y }: { p: Placement; placements: Placement[]; x: number; y: number }) {
  const f = FURNITURE_BY_ID[p.itemId];
  const { col, row, rests } = placementLabel(p, placements);
  const left = Math.min(Math.max(8, x + 14), window.innerWidth - 256);
  const top = y + 170 > window.innerHeight ? y - 160 : y + 16;
  return (
    <div
      className="pointer-events-none fixed z-50 w-60 rounded-md border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg"
      style={{ left, top }}
      data-testid="tooltip-placement"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-muted-foreground">#{p.step}</span>
        <span className="text-sm font-semibold leading-tight">{f.name}</span>
        {p.rare && <Sparkles className="h-3.5 w-3.5" style={{ color: "hsl(var(--rare))" }} />}
      </div>
      <div className="mt-1.5">
        <StatChips stats={statsOf(f, p.rare)} size="xs" itemId={f.id} />
      </div>
      <p className="mt-2 text-xs">
        <span className="font-mono">{col}</span>, <span className="font-mono">{row}</span>
      </p>
      <p className="text-xs text-muted-foreground">{rests}</p>
      {f.set && <p className="mt-1 text-[11px] text-muted-foreground">Set: {f.set}</p>}
    </div>
  );
}

function Steps({ result, hover, setHover }: { result: RoomResult; hover: number | null; setHover: (i: number | null) => void }) {
  return (
    <Collapsible className="border-t border-border">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group h-10 w-full justify-start gap-2 rounded-none px-4 text-xs" data-testid={`button-steps-${result.roomId}`}>
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
          Placement steps ({result.placements.length}), in order so every stacked piece has its base placed first
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="max-h-80 overflow-y-auto px-2 pb-2" onMouseLeave={() => setHover(null)}>
          {result.placements.map((p, i) => {
            const f = FURNITURE_BY_ID[p.itemId];
            const { col, row, rests } = placementLabel(p, result.placements);
            return (
              <li
                key={i}
                onMouseEnter={() => setHover(i)}
                className={cn(
                  "grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                  hover === i && "bg-muted",
                )}
                data-testid={`row-step-${result.roomId}-${i}`}
              >
                <span className="font-mono text-muted-foreground">#{p.step}</span>
                <span className="min-w-0">
                  <span className="font-medium">{f.name}</span>
                  {p.rare && <span style={{ color: "hsl(var(--rare))" }}> ★</span>}
                  <span className="text-muted-foreground"> · {rests}</span>
                </span>
                <span className="font-mono text-muted-foreground">
                  {col}, {row}
                </span>
              </li>
            );
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
