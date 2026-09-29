import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import { FURNITURE_BY_ID, HIDDEN_ROOMS, HOUSES, ROOMS, statsOf } from "@/lib/data";
import type { RoomGoal, WarmStart } from "@/lib/optimizer";
import { toWarm } from "@/lib/optimizer";
import { EFFORTS, effortFor, runAutoStrategy, useOptimizer } from "@/lib/use-optimizer";
import { DEFAULT_ROOM_PRESET, PRESET_BY_ID, goalFromPreset, migrateGoal } from "@/lib/presets";
import { InventoryPanel, type Owned } from "@/components/inventory-panel";
import { RoomCard } from "@/components/room-card";
import { Glyph, Logo, StatChips } from "@/components/bits";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Dices, Github, ImageDown, Loader2, Moon, Sun, Wand2, X } from "lucide-react";
import { SnapshotsDialog, type Snapshot } from "@/components/snapshots";
import { exportHouseImage } from "@/lib/export-image";
import { useToast } from "@/hooks/use-toast";

export const GITHUB_URL = "https://github.com/notalim/mewgenics-house-planner";
export const AUTHOR_URL = "https://github.com/notalim";
import { cn } from "@/lib/utils";

interface HouseSetting {
  stage: string;
  enabled: string[];
}
interface Prefs {
  appealWeight: number;
  effort?: string;
}
interface StateResponse {
  inventory: Array<{ itemId: string; count: number; rare: number }>;
  settings: { house?: HouseSetting; goals?: Record<string, RoomGoal>; layout?: WarmStart; prefs?: Prefs; snapshots?: Snapshot[] };
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
  const [deepRun, setDeepRun] = useState(0);
  const deepPending = useRef(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const restoring = useRef(false);
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();
  const [focus, setFocus] = useState<string | null>(null);
  const seed = 1337;
  const warmRef = useRef<WarmStart | null>(null);
  const [mobileTab, setMobileTab] = useState<"furniture" | "rooms">("rooms");
  const [auto, setAuto] = useState<{ running: boolean; info: AutoInfo | null }>({ running: false, info: null });
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
    if (data.settings.house)
      setHouse({ ...data.settings.house, enabled: data.settings.house.enabled.filter((r) => !HIDDEN_ROOMS.test(r)) });
    if (data.settings.goals)
      setGoals(Object.fromEntries(Object.entries(data.settings.goals).map(([k, g]) => [k, migrateGoal(g)])));
    if (data.settings.prefs) setPrefs(data.settings.prefs);
    if (Array.isArray(data.settings.snapshots)) setSnapshots(data.settings.snapshots);
    warmRef.current = data.settings.layout ?? null;
    setReady(true);
  }, [data, ready]);

  useDebouncedSave("house", house, ready, setSavingSettings);
  useDebouncedSave("goals", goals, ready, setSavingSettings);
  useDebouncedSave("prefs", prefs, ready, setSavingSettings);
  useDebouncedSave("snapshots", snapshots, ready, setSavingSettings);

  const houseDef = HOUSES[house.stage] ?? HOUSES.House2;
  const activeRooms = houseDef.rooms.filter((r) => house.enabled.includes(r));

  const goalFor = useCallback(
    (roomId: string): RoomGoal => goals[roomId] ?? goalFromPreset(roomId, DEFAULT_ROOM_PRESET[roomId] ?? "comfort"),
    [goals],
  );

  const pickStrategy = async () => {
    setAuto({ running: true, info: null });
    const catsByRole: Record<string, number> = {};
    for (const r of activeRooms) {
      const g = goalFor(r);
      if (catsByRole[g.preset] === undefined) catsByRole[g.preset] = g.cats;
    }
    try {
      const res = await runAutoStrategy({ owned: ownedList, appealWeight: prefs.appealWeight }, activeRooms, catsByRole);
      warmRef.current = null;
      setGoals((prev) => {
        const next = { ...prev };
        for (const g of res.best) next[g.roomId] = g;
        return next;
      });
      setAuto({
        running: false,
        info: {
          assign: res.best.map((g) => ({ roomId: g.roomId, role: g.preset, cats: g.cats })),
          tried: res.candidates.length,
          margin: res.candidates.length > 1 ? res.candidates[0].score - res.candidates[1].score : null,
        },
      });
    } catch {
      setAuto({ running: false, info: null });
    }
  };

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

  // "Search deeper" runs one exhaustive pass on top of the current layout
  const effort = deepPending.current ? effortFor("max") : effortFor(prefs.effort ?? "normal");
  const req = ready
    ? {
        goals: goalList,
        owned: ownedList,
        appealWeight: prefs.appealWeight,
        warm: warmRef.current,
        effort,
        seed: seed + deepRun,
        // a restored snapshot must come back exactly as saved (still polished, never replaced)
        stabilityMargin: restoring.current ? Number.POSITIVE_INFINITY : undefined,
      }
    : null;
  const { result, running } = useOptimizer(req, [
    ready,
    JSON.stringify(ownedList),
    JSON.stringify(goalList),
    prefs.appealWeight,
    prefs.effort,
    deepRun,
  ]);
  useEffect(() => {
    if (!running) {
      deepPending.current = false;
      restoring.current = false;
    }
  }, [running]);

  const saveSnapshot = (name: string) => {
    if (!result) return;
    const snap: Snapshot = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      at: new Date().toISOString(),
      score: result.totalScore,
      placed: result.rooms.reduce((a, r) => a + r.placements.length, 0),
      house,
      goals: Object.fromEntries(activeRooms.map((r) => [r, goalFor(r)])),
      appealWeight: prefs.appealWeight,
      layout: toWarm(result),
    };
    setSnapshots((prev) => [...prev, snap].slice(-30));
    toast({ title: "Layout saved", description: `"${name}" is available on every device you open this planner on.` });
  };
  const restoreSnapshot = (snap: Snapshot) => {
    restoring.current = true;
    warmRef.current = snap.layout;
    setHouse(snap.house);
    setGoals((prev) => ({ ...prev, ...snap.goals }));
    setPrefs((p) => ({ ...p, appealWeight: snap.appealWeight }));
    setDeepRun((n) => n + 1);
    toast({ title: "Layout restored", description: `Back to "${snap.name}". Pieces you added since then are fitted around it.` });
  };
  const exportImage = async () => {
    if (!result) return;
    setExporting(true);
    try {
      await exportHouseImage({ result, goals: goalList, ownedCount: ownedList.reduce((a, o) => a + o.count + o.rare, 0) });
    } catch (e: any) {
      toast({ title: "Could not export image", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

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
    <div className="flex h-[100dvh] flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7 text-primary" />
          <div className="leading-tight">
            <h1 className="font-display text-base font-semibold tracking-tight">Mewgenics House Planner</h1>
            <p className="text-[11px] text-muted-foreground max-sm:hidden">Fits the furniture you own into your rooms, tile by tile</p>
          </div>
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2 lg:justify-end max-lg:basis-full max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:pb-1 [&>*]:shrink-0">
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

          <div className="flex flex-wrap gap-1 max-lg:flex-nowrap" role="group" aria-label="Unlocked rooms">
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
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={!ready || auto.running || activeRooms.length === 0}
            onClick={pickStrategy}
            title="Try every way of splitting roles across your rooms and keep the best"
            data-testid="button-auto-strategy"
          >
            {auto.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            Pick strategy for me
          </Button>
          <Select value={prefs.effort ?? "normal"} onValueChange={(v) => setPrefs({ ...prefs, effort: v })}>
            <SelectTrigger className="h-8 w-[160px] text-xs" data-testid="select-effort" title="How long each recompute searches. Same setting, same furniture, same layout, on any device.">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EFFORTS.map((e) => (
                <SelectItem key={e.id} value={e.id} title={e.hint}>
                  {e.label} search
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={!ready || running}
            onClick={() => {
              deepPending.current = true;
              setDeepRun((n) => n + 1);
            }}
            title="One exhaustive pass starting from the current layout. Keeps it unless something clearly better turns up."
            data-testid="button-deeper"
          >
            <Dices className="h-3.5 w-3.5" /> Search deeper
          </Button>
          <SnapshotsDialog
            snapshots={snapshots}
            canSave={!!result && !running}
            onSave={saveSnapshot}
            onRestore={restoreSnapshot}
            onDelete={(id) => setSnapshots((prev) => prev.filter((s) => s.id !== id))}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={!result || running || exporting}
            onClick={exportImage}
            title="Download the whole house as one PNG (good for sharing)"
            data-testid="button-export-image"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageDown className="h-3.5 w-3.5" />} Export image
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

      <div className="flex border-b border-border lg:hidden" role="tablist">
        {(["rooms", "furniture"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={mobileTab === t}
            onClick={() => setMobileTab(t)}
            className={cn(
              "flex-1 py-2 text-xs font-medium transition-colors",
              mobileTab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground",
            )}
            data-testid={`tab-${t}`}
          >
            {t === "rooms" ? "Rooms" : `Your furniture (${ownedList.reduce((a, o) => a + o.count + o.rare, 0)})`}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside
          className={cn(
            "min-h-0 flex-1 overflow-hidden lg:h-full lg:w-[360px] lg:flex-none lg:shrink-0 lg:border-r lg:border-border",
            mobileTab !== "furniture" && "max-lg:hidden",
          )}
        >
          {ready ? (
            <InventoryPanel
              owned={owned}
              onSet={setItem}
              placed={placed}
              exportHref={`${API_BASE}/api/export`}
              onImport={importItems}
              saving={savingInv > 0 || savingSettings}
              focus={focus}
              onFocus={setFocus}
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

        <main className={cn("min-h-0 flex-1 overflow-y-auto", mobileTab !== "rooms" && "max-lg:hidden")}>
          <div className="mx-auto max-w-[1180px] space-y-4 p-4">
            <SummaryBar
              running={running}
              iterations={result?.iterations ?? 0}
              effort={effort}
              chain={result?.chain ?? 0}
              score={result?.totalScore ?? 0}
              ms={result?.ms ?? 0}
              appeal={result?.houseAppeal ?? 0}
              placedCount={(result?.rooms ?? []).reduce((a, r) => a + r.placements.length, 0)}
              ownedCount={ownedList.reduce((a, o) => a + o.count + o.rare, 0)}
            />

            {auto.info && <StrategyCard info={auto.info} onClose={() => setAuto({ running: false, info: null })} />}

            {!isLoading && ready && !hasInventory && (
              <Card className="p-5 text-sm">
                <p className="font-medium">Start with the furniture you own</p>
                <p className="mt-1 text-muted-foreground">
                  Use Add furniture (left side on desktop, Your furniture tab on phone). Every piece you add is saved and the layout below recomputes. Rooms start
                  as elite breeding, holding and a feeder nursery. Once your furniture is in, press Pick strategy for me
                  to test every way of splitting those roles across your rooms.
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
                    focus={focus}
                    onFocus={setFocus}
                  />
                ))}

            {result && result.leftovers.length > 0 && <Leftovers leftovers={result.leftovers} />}

            <Faq />
            <About />
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-4 text-[11px] text-muted-foreground" data-testid="footer">
              <span>
                Built by{" "}
                <a className="underline hover:text-foreground" href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">
                  notalim
                </a>
              </span>
              <a className="inline-flex items-center gap-1 underline hover:text-foreground" href={GITHUB_URL} target="_blank" rel="noopener noreferrer" data-testid="link-github">
                <Github className="h-3 w-3" /> Source on GitHub
              </a>
              <span>Not affiliated with Edmund McMillen, Tyler Glaiel or Mewgenics. Furniture data belongs to the game.</span>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

interface AutoInfo {
  assign: Array<{ roomId: string; role: string; cats: number }>;
  tried: number;
  margin: number | null;
}

function StrategyCard({ info, onClose }: { info: AutoInfo; onClose: () => void }) {
  return (
    <Card className="border-primary/40 p-4" data-testid="card-strategy">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Strategy picked for your furniture</h3>
          <p className="text-xs text-muted-foreground">
            Tried {info.tried} way{info.tried === 1 ? "" : "s"} of splitting roles across your rooms and kept the highest
            scoring one{info.margin !== null ? ` (${info.margin.toFixed(1)} points ahead of the runner-up)` : ""}.
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Dismiss" data-testid="button-dismiss-strategy">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        {info.assign.map((a) => (
          <li key={a.roomId} className="rounded-md border border-border px-3 py-2 text-xs" data-testid={`strategy-${a.roomId}`}>
            <p className="font-medium">{ROOMS[a.roomId].label}</p>
            <p className="text-muted-foreground">
              {PRESET_BY_ID[a.role]?.label ?? a.role} · {a.cats} cats
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Cat counts are defaults; set yours on each room card and the layout recomputes.
      </p>
    </Card>
  );
}

function SummaryBar({
  running,
  iterations,
  effort,
  chain,
  score,
  ms,
  appeal,
  placedCount,
  ownedCount,
}: {
  running: boolean;
  iterations: number;
  effort: number;
  chain: number;
  score: number;
  ms: number;
  appeal: number;
  placedCount: number;
  ownedCount: number;
}) {
  const pct = running ? Math.min(100, Math.round((iterations / Math.max(1, effort)) * 100)) : 100;
  return (
    <div className="space-y-1.5" data-testid="status-optimizer">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Searching layouts, {pct}%
            </>
          ) : (
            <>
              Searched {iterations.toLocaleString()} layouts in {(ms / 1000).toFixed(1)}s
              {chain === 0 ? ", kept your previous layout (improved where possible)" : ""}
            </>
          )}
        </span>
        <span>
          Score <span className="font-mono text-foreground">{score.toFixed(1)}</span>
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
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${pct}%`, opacity: running ? 1 : 0.35 }}
        />
      </div>
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
        {notUseful.length
          ? `${notUseful.reduce((a, l) => a + l.count, 0)} pieces would lower every room's score: what they take away (with your goals' weights) outweighs what they add, so leaving them out beats any spot. Change a room's goal or weights and they get reconsidered.`
          : ""}
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

function Faq() {
  const qa: Array<[string, React.ReactNode]> = [
    [
      "How do I use this?",
      "Add every piece of furniture you own: on PC, Import your Steam save and it reads the list for you; on console, type them in with Add furniture. Pick your house stage and which rooms are unlocked, set each room's goal, then read the grids: numbers are placement order, so build each room from 1 upward and every stacked piece already has its base. Hover a piece anywhere for its name, stats and what it rests on.",
    ],
    [
      "I play on Steam. Can it read my save?",
      <>
        Yes. Press Import and pick your save, usually{" "}
        <code className="rounded bg-muted px-1 text-xs">%AppData%\\Glaiel Games\\Mewgenics\\&lt;SteamID&gt;\\saves\\steamcampaign01.sav</code> on Windows.
        The planner reads only the furniture table (every piece, placed or in storage), counts each type and shows a preview before replacing your list. The file is parsed and discarded, nothing from it is kept. Rare pieces are not marked in a way we can read yet, so set those with the Rare stepper afterwards. Console saves cannot be exported, so console players add pieces by hand.
      </>,
    ],
    [
      "Which goals should my rooms have?",
      "Press Pick strategy for me and it tries every way of splitting roles across your rooms and keeps the best. The usual shape is one elite breeding room (few cats, Stimulation as high as possible, Comfort above 0), one feeder nursery (many cats, Health 10 first) and a holding room for retirees and the adventure squad. Appeal is house-wide, so it does not matter which room it lands in.",
    ],
    [
      "Why is a piece left in storage?",
      "Two reasons, listed separately at the bottom. No space: it would help, but every layout that fits it scores lower than the one shown. Not useful: with your current goals its negatives outweigh its positives in every room (a Shrunken Cat Head is -5 Health for +1 Mutation, so it only earns a spot in a room that ignores Health). Change the room goal or fine-tune weights and it gets reconsidered.",
    ],
    [
      "Why does the layout change when I add one piece?",
      "It mostly should not. The previous layout is one of the search's starting points and wins ties, so a new piece is fitted around it. If a genuinely better arrangement appears (more than 0.35 points), the planner takes it and says so in the status line. Save a layout you like from Layouts to get it back at any time.",
    ],
    [
      "Does it sync between my phone and computer?",
      "Yes. Furniture, room goals, the current layout and saved layouts live on the server behind this link, so any device that opens it sees the same house. Export backup gives you a JSON copy you can re-import.",
    ],
    [
      "What do the search levels mean?",
      "How many ruin-and-repack rounds run each time something changes. Quick is about a second, Thorough (default) a few seconds, Deep and Exhaustive longer. Search deeper runs one exhaustive pass on top of the current layout. The search is deterministic: same furniture, goals and level give the same result everywhere.",
    ],
    [
      "How many rooms can I have? Where did the basements go?",
      "Five spaces in the current game: the starting room, the attic (1 retired cat sent to Frank), then rooms 2, 3 and 4 (25, 60 and 100 retired cats). The game's data files also contain five basement rooms with their own upgrade chain, but nothing in play unlocks them yet, so the planner hides them. If they ever ship, they are one flag away.",
    ],
    [
      "The game let me place something the planner refuses (or vice versa).",
      "Report it with the piece name and a screenshot on GitHub. Known rules built in: headroom tiles (dashed) must be open room space, nothing hangs from the attic roof, rare pieces count double, each cat past four costs one Comfort.",
    ],
  ];
  return (
    <Card className="p-4" data-testid="card-faq">
      <h3 className="text-sm font-semibold">FAQ</h3>
      <div className="mt-2 divide-y divide-border">
        {qa.map(([q, a]) => (
          <Collapsible key={q}>
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 py-2 text-left text-xs font-medium hover:text-foreground">
              {q}
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pb-3 text-xs leading-relaxed text-muted-foreground">{a}</CollapsibleContent>
          </Collapsible>
        ))}
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
          The optimizer is a deterministic search, not an exact solver: same furniture, same goals, same search level
          gives the same layout on every device. It builds a greedy layout (best stat per tile first), then runs a
          fixed number of ruin-and-repack rounds from several starting points, keeping changes that score higher and
          occasionally accepting worse ones early to escape dead ends. Small pieces are pushed onto shelves so the
          scarce floor width goes to big pieces. Comfort limits are enforced with a penalty. Your last layout is one
          of the starting points and wins ties, so adding a piece nudges the plan instead of reshuffling the house.
          Search deeper runs one exhaustive pass on top of it.
        </p>
        <p>
          Assumptions to check in game: rare pieces count 2× stats; the ground floor rooms are plain 16×7 rectangles; wall
          pieces can go anywhere open; nothing hangs from the attic roof. Pieces with a house-wide job but no room stats
          (Food Storage Box, +40 max food each) are placed wherever space is left after every stat piece has a spot.
          Columns count from the left wall, rows from the floor.
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
