import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import { FURNITURE_BY_ID, HOUSES, ROOMS, statsOf } from "@/lib/data";
import type { RoomGoal, WarmStart } from "@/lib/optimizer";
import { toWarm } from "@/lib/optimizer";
import { useOptimizer } from "@/lib/use-optimizer";
import { DEFAULT_ROOM_PRESET, goalFromPreset } from "@/lib/presets";
import { InventoryPanel, type Owned } from "@/components/inventory-panel";
import { RoomCard } from "@/components/room-card";
import { Glyph, Logo, StatChips } from "@/components/bits";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Dices, Loader2, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

interface HouseSetting {
  stage: string;
  enabled: string[];
}
interface Prefs {
  appealWeight: number;
}
interface StateResponse {
  inventory: Array<{ itemId: string; count: number; rare: number }>;
  settings: { house?: HouseSetting; goals?: Record<string, RoomGoal>; layout?: WarmStart; prefs?: Prefs };
}

const DEFAULT_HOUSE: HouseSetting = { stage: "House2", enabled: ["Floor1_Large", "Floor1_Small", "LargeAttic"] };
const APPEAL_OPTIONS = [
  { v: 0, label: "Ignore Appeal" },
  { v: 0.2, label: "Appeal: a little" },
  { v: 0.6, label: "Appeal: matters" },
];

function useDebouncedSave(key: string, value: unknown, ready: boolean, setSaving: (b: boolean) => void) {
  const first = useRef(true);
  useEffect(() => {
    if (!ready) return;
    if (first.current) {
      first.current = false;
      return;
    }
    setSaving(true);
    const t = setTimeout(async () => {
      try {
        await apiRequest("PUT", `/api/settings/${key}`, { value });
      } finally {
        setSaving(false);
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value), ready]);
}

export default function Planner() {
  const { data, isLoading, isError } = useQuery<StateResponse>({ queryKey: ["/api/state"] });
  const [ready, setReady] = useState(false);
  const [owned, setOwned] = useState<Owned>({});
  const [house, setHouse] = useState<HouseSetting>(DEFAULT_HOUSE);
  const [goals, setGoals] = useState<Record<string, RoomGoal>>({});
  const [prefs, setPrefs] = useState<Prefs>({ appealWeight: 0.2 });
  const [savingInv, setSavingInv] = useState(0);
  const [savingSettings, setSavingSettings] = useState(false);
  const [seed, setSeed] = useState(1337);
  const warmRef = useRef<WarmStart | null>(null);
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // hydrate once from the server
  useEffect(() => {
    if (!data || ready) return;
    const o: Owned = {};
    for (const r of data.inventory) o[r.itemId] = { count: r.count, rare: r.rare };
    setOwned(o);
    if (data.settings.house) setHouse(data.settings.house);
    if (data.settings.goals) setGoals(data.settings.goals);
    if (data.settings.prefs) setPrefs(data.settings.prefs);
    warmRef.current = data.settings.layout ?? null;
    setReady(true);
  }, [data, ready]);

  useDebouncedSave("house", house, ready, setSavingSettings);
  useDebouncedSave("goals", goals, ready, setSavingSettings);
  useDebouncedSave("prefs", prefs, ready, setSavingSettings);

  const houseDef = HOUSES[house.stage] ?? HOUSES.House2;
  const activeRooms = houseDef.rooms.filter((r) => house.enabled.includes(r));

  const goalFor = useCallback(
    (roomId: string): RoomGoal => goals[roomId] ?? goalFromPreset(roomId, DEFAULT_ROOM_PRESET[roomId] ?? "comfort"),
    [goals],
  );

  const setItem = useCallback((itemId: string, count: number, rare: number) => {
    setOwned((prev) => {
      const next = { ...prev };
      if (count + rare <= 0) delete next[itemId];
      else next[itemId] = { count, rare };
      return next;
    });
    setSavingInv((n) => n + 1);
    apiRequest("PUT", `/api/inventory/${encodeURIComponent(itemId)}`, { count, rare })
      .catch(() => {})
      .finally(() => setSavingInv((n) => n - 1));
  }, []);

  const importItems = useCallback(async (items: Array<{ itemId: string; count: number; rare: number }>) => {
    setSavingInv((n) => n + 1);
    try {
      const res = await apiRequest("POST", "/api/inventory/bulk", { replace: true, items });
      const json = await res.json();
      const o: Owned = {};
      for (const r of json.inventory) o[r.itemId] = { count: r.count, rare: r.rare };
      setOwned(o);
    } finally {
      setSavingInv((n) => n - 1);
    }
  }, []);

  const ownedList = useMemo(
    () => Object.entries(owned).map(([itemId, o]) => ({ itemId, count: o.count, rare: o.rare })),
    [owned],
  );
  const goalList = useMemo(() => activeRooms.map(goalFor), [activeRooms.join(","), goalFor]);

  const req = ready
    ? { goals: goalList, owned: ownedList, appealWeight: prefs.appealWeight, warm: warmRef.current, timeBudgetMs: 900, seed }
    : null;
  const { result, running } = useOptimizer(req, [ready, JSON.stringify(ownedList), JSON.stringify(goalList), prefs.appealWeight, seed]);

  // remember the layout so the next recompute starts from it (keeps the house stable)
  useEffect(() => {
    if (!result) return;
    warmRef.current = toWarm(result);
    const t = setTimeout(() => apiRequest("PUT", "/api/settings/layout", { value: warmRef.current }).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [result]);

  const placed = useMemo(() => {
    const m: Record<string, { n: number; rooms: string[] }> = {};
    for (const r of result?.rooms ?? [])
      for (const p of r.placements) {
        m[p.itemId] ??= { n: 0, rooms: [] };
        m[p.itemId].n++;
        if (!m[p.itemId].rooms.includes(r.roomId)) m[p.itemId].rooms.push(r.roomId);
      }
    return m;
  }, [result]);

  const resultByRoom = useMemo(() => Object.fromEntries((result?.rooms ?? []).map((r) => [r.roomId, r])), [result]);
  const hasInventory = ownedList.length > 0;

  if (isError)
    return (
      <div className="flex h-screen items-center justify-center p-6 text-sm text-muted-foreground">
        Could not reach the planner's save server. Reload in a moment.
      </div>
    );

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7 text-primary" />
          <div className="leading-tight">
            <h1 className="font-display text-base font-semibold tracking-tight">Mewgenics House Planner</h1>
            <p className="text-[11px] text-muted-foreground">Fits the furniture you own into your rooms, tile by tile</p>
          </div>
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2 lg:justify-end">
          <Select
            value={house.stage}
            onValueChange={(stage) => {
              const rooms = HOUSES[stage].rooms;
              const enabled = house.enabled.filter((r) => rooms.includes(r));
              setHouse({ stage, enabled: enabled.length ? enabled : rooms.slice(0, 2) });
            }}
          >
            <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="select-house">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(HOUSES).map(([id, h]) => (
                <SelectItem key={id} value={id}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex flex-wrap gap-1" role="group" aria-label="Unlocked rooms">
            {houseDef.rooms.map((r) => {
              const on = house.enabled.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() =>
                    setHouse({ ...house, enabled: on ? house.enabled.filter((x) => x !== r) : [...house.enabled, r] })
                  }
                  className={cn(
                    "h-8 rounded-md border px-2.5 text-xs transition-colors",
                    on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                  aria-pressed={on}
                  data-testid={`toggle-room-${r}`}
                >
                  {ROOMS[r].label}
                </button>
              );
            })}
          </div>

          <Select value={String(prefs.appealWeight)} onValueChange={(v) => setPrefs({ ...prefs, appealWeight: Number(v) })}>
            <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="select-appeal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPEAL_OPTIONS.map((o) => (
                <SelectItem key={o.v} value={String(o.v)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => {
              warmRef.current = null;
              setSeed((s) => s + 1);
            }}
            title="Throw away the current layout and search again from scratch"
            data-testid="button-reroll"
          >
            <Dices className="h-3.5 w-3.5" /> Fresh search
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setDark((d) => !d)}
            aria-label="Toggle dark mode"
            data-testid="button-theme"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="border-b border-border lg:h-full lg:w-[360px] lg:shrink-0 lg:border-b-0 lg:border-r max-lg:max-h-[70vh]">
          {ready ? (
            <InventoryPanel
              owned={owned}
              onSet={setItem}
              placed={placed}
              exportHref={`${API_BASE}/api/export`}
              onImport={importItems}
              saving={savingInv > 0 || savingSettings}
            />
          ) : (
            <div className="space-y-3 p-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          )}
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1180px] space-y-4 p-4">
            <SummaryBar
              running={running}
              iterations={result?.iterations ?? 0}
              ms={result?.ms ?? 0}
              appeal={result?.houseAppeal ?? 0}
              placedCount={(result?.rooms ?? []).reduce((a, r) => a + r.placements.length, 0)}
              ownedCount={ownedList.reduce((a, o) => a + o.count + o.rare, 0)}
            />

            {!isLoading && ready && !hasInventory && (
              <Card className="p-5 text-sm">
                <p className="font-medium">Start with the furniture you own</p>
                <p className="mt-1 text-muted-foreground">
                  Use Add furniture on the left. Every piece you add is saved and the layout below recomputes. Rooms are
                  set to Stimulation, Health and Mutation by default; change any room goal on its card.
                </p>
              </Card>
            )}

            {isLoading || !ready
              ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-72 w-full" />)
              : activeRooms.map((r) => (
                  <RoomCard
                    key={r}
                    def={ROOMS[r]}
                    goal={goalFor(r)}
                    result={resultByRoom[r]}
                    stale={running}
                    onGoal={(g) => setGoals((prev) => ({ ...prev, [r]: g }))}
                  />
                ))}

            {result && result.leftovers.length > 0 && <Leftovers leftovers={result.leftovers} />}

            <About />
          </div>
        </main>
      </div>
    </div>
  );
}

function SummaryBar({
  running,
  iterations,
  ms,
  appeal,
  placedCount,
  ownedCount,
}: {
  running: boolean;
  iterations: number;
  ms: number;
  appeal: number;
  placedCount: number;
  ownedCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground" data-testid="status-optimizer">
      <span className="flex items-center gap-1.5">
        {running ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Optimizing layout
          </>
        ) : (
          <>Searched {iterations.toLocaleString()} layouts in {(ms / 1000).toFixed(1)}s</>
        )}
      </span>
      <span>
        <span className="font-mono text-foreground">{placedCount}</span> of{" "}
        <span className="font-mono text-foreground">{ownedCount}</span> pieces placed
      </span>
      <span>
        House Appeal <span className="font-mono" style={{ color: "hsl(var(--stat-a))" }}>{appeal}</span>
        <span className="ml-1">(100+ and 200+ improve strays)</span>
      </span>
    </div>
  );
}

function Leftovers({ leftovers }: { leftovers: Array<{ itemId: string; rare: boolean; count: number; reason: string }> }) {
  const noSpace = leftovers.filter((l) => l.reason === "no-space");
  const notUseful = leftovers.filter((l) => l.reason !== "no-space");
  return (
    <Card className="p-4" data-testid="card-leftovers">
      <h3 className="text-sm font-semibold">Left in storage</h3>
      <p className="text-xs text-muted-foreground">
        {noSpace.length ? `${noSpace.reduce((a, l) => a + l.count, 0)} useful pieces lost out on space. ` : ""}
        {notUseful.length ? `${notUseful.reduce((a, l) => a + l.count, 0)} pieces don't help any room's goal.` : ""}
      </p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {[
          { title: "Useful, but lost on space", list: noSpace },
          { title: "No help for current goals", list: notUseful },
        ].map((g) =>
          g.list.length ? (
            <div key={g.title}>
              <p className="mb-1.5 text-xs font-medium">{g.title}</p>
              <ul className="space-y-1">
                {g.list.slice(0, 40).map((l) => {
                  const f = FURNITURE_BY_ID[l.itemId];
                  return (
                    <li key={l.itemId + l.rare} className="flex items-center gap-2 text-xs" data-testid={`row-leftover-${l.itemId}`}>
                      <Glyph f={f} cell={4} />
                      <span className="min-w-0 flex-1 truncate">
                        {f.name}
                        {l.rare && <span style={{ color: "hsl(var(--rare))" }}> ★</span>}
                        {l.count > 1 && <span className="text-muted-foreground"> ×{l.count}</span>}
                      </span>
                      <StatChips stats={statsOf(f, l.rare)} size="xs" />
                    </li>
                  );
                })}
                {g.list.length > 40 && <li className="text-xs text-muted-foreground">and {g.list.length - 40} more</li>}
              </ul>
            </div>
          ) : null,
        )}
      </div>
    </Card>
  );
}

function About() {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="button-about">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
        How the planner works and what it assumes
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          Tile shapes come from the game's <span className="font-mono">furniture_info.data</span> and stats from{" "}
          <span className="font-mono">furniture_effects.gon</span> (633 pieces). Each piece has solid tiles, stackable
          surface tiles, and support tiles that must rest on a floor, ceiling, or another piece's surface. Room sizes and
          the attic roof shape come from the game's house data.
        </p>
        <p>
          The optimizer is a search, not an exact solver: it builds a greedy layout (best stat per tile first), then
          keeps pulling pieces out and repacking for about a second, keeping any change that scores higher. Comfort
          limits are enforced with a penalty. Your last layout is kept as the starting point, so adding a piece only
          nudges the plan instead of reshuffling everything. Fresh search starts over.
        </p>
        <p>
          Assumptions to check in game: rare pieces count 2× stats; the ground floor rooms are plain 16×7 rectangles; wall
          pieces can go anywhere open. Columns count from the left wall, rows from the floor.
        </p>
        <p>
          Data sources:{" "}
          <a className="underline" href="https://github.com/kazzade42/mewgenics-furniture-upgrade" target="_blank" rel="noopener noreferrer">
            furniture data files
          </a>
          ,{" "}
          <a className="underline" href="https://github.com/michael-trinity/mewgenics-savegame-editor" target="_blank" rel="noopener noreferrer">
            house layout and names
          </a>
          ,{" "}
          <a className="underline" href="https://github.com/Pseudonym-Tim/mewgenics-furniture-framework" target="_blank" rel="noopener noreferrer">
            tile type meanings
          </a>
          .
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
