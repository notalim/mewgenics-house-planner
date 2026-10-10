import { useMemo, useRef, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Download, Minus, Plus, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { FURNITURE, FURNITURE_BY_ID, KIND_LABEL, STAT_KEYS, STAT_LABEL, type StatKey } from "@/lib/data";
import { Glyph, StatChips, tilesLabel } from "./bits";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

export type Owned = Record<string, { count: number; rare: number }>;

type SortKey = "name" | StatKey | "placed";

export function InventoryPanel({
  owned,
  onSet,
  placed,
  exportHref,
  onExport,
  onImport,
  saving,
  onFocus,
  focus,
}: {
  owned: Owned;
  /** hover a row to light up that piece in every room and show its stat effect */
  onFocus?: (itemId: string | null) => void;
  focus?: string | null;
  onSet: (itemId: string, count: number, rare: number) => void;
  placed: Record<string, { n: number; rooms: string[] }>;
  exportHref?: string;
  onExport?: () => void;
  onImport: (items: Array<{ itemId: string; count: number; rare: number }>) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [addRare, setAddRare] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  type Pending = {
    items: Array<{ itemId: string; count: number; rare: number }>;
    source: "json" | "save";
    pieces: number;
    note?: string;
    skipped?: string[];
  };
  const [pendingImport, setPendingImport] = useState<Pending | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [lastAdded, setLastAdded] = useState<string | null>(null);

  const addable = useMemo(
    () => [...FURNITURE].sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = Object.entries(owned)
      .filter(([id, o]) => FURNITURE_BY_ID[id] && o.count + o.rare > 0)
      .map(([id, o]) => ({ f: FURNITURE_BY_ID[id], ...o }))
      .filter((r) => !q || r.f.name.toLowerCase().includes(q) || (r.f.set ?? "").toLowerCase().includes(q));
    list.sort((a, b) => {
      if (sort === "name") return a.f.name.localeCompare(b.f.name);
      if (sort === "placed") return (placed[a.f.id]?.n ?? 0) - (placed[b.f.id]?.n ?? 0) || a.f.name.localeCompare(b.f.name);
      return (b.f.stats[sort] ?? 0) - (a.f.stats[sort] ?? 0) || a.f.name.localeCompare(b.f.name);
    });
    return list;
  }, [owned, filter, sort, placed]);

  const totals = useMemo(() => {
    let pieces = 0;
    let types = 0;
    for (const o of Object.values(owned)) {
      if (o.count + o.rare > 0) types++;
      pieces += o.count + o.rare;
    }
    return { pieces, types };
  }, [owned]);

  const add = (id: string) => {
    const cur = owned[id] ?? { count: 0, rare: 0 };
    if (addRare) onSet(id, cur.count, cur.rare + 1);
    else onSet(id, cur.count + 1, cur.rare);
    setLastAdded(id);
  };

  const readJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const inv = Array.isArray(data) ? data : data.inventory;
        if (!Array.isArray(inv)) throw new Error("No inventory list in file");
        const items = inv
          .filter((r: any) => r && typeof r.itemId === "string" && FURNITURE_BY_ID[r.itemId])
          .map((r: any) => ({ itemId: r.itemId, count: Math.max(0, Number(r.count) || 0), rare: Math.max(0, Number(r.rare) || 0) }));
        if (!items.length) throw new Error("No known furniture in file");
        setImportError(null);
        setPendingImport({ items, source: "json", pieces: items.reduce((a, i) => a + i.count + i.rare, 0) });
      } catch (e: any) {
        setImportError(e.message ?? "Could not read that file");
      }
    };
    reader.readAsText(file);
  };

  // Steam save (steamcampaign01.sav): a SQLite file. The server reads its furniture table and sends back counts.
  const readSave = async (file: File) => {
    setReading(true);
    try {
      const res = await apiRequest("POST", "/api/import/save", file);
      const data = (await res.json()) as {
        items: Array<{ itemId: string; count: number; rare: number }>;
        pieces: number;
        placed: number;
        stored: number;
        plusMerged: number;
        rareCount?: number;
      };
      const items = data.items
        .filter((r) => FURNITURE_BY_ID[r.itemId] && r.itemId !== "poop")
        // idols and other pieces that cannot be rare in the game are counted as normal whatever the flag says
        .map((r) => (FURNITURE_BY_ID[r.itemId].canRare ? r : { ...r, count: r.count + r.rare, rare: 0 }));
      const skipped = data.items.filter((r) => !FURNITURE_BY_ID[r.itemId] && r.itemId !== "poop").map((r) => `${r.itemId} ×${r.count + r.rare}`);
      if (!items.length) throw new Error("No furniture found in that save");
      const notes = [`${data.placed} placed in rooms, ${data.stored} in storage.`];
      notes.push(data.rareCount ? `${data.rareCount} rare piece${data.rareCount === 1 ? "" : "s"} detected from the save's rarity flag.` : "No rare pieces flagged in this save.");
      if (data.plusMerged) notes.push(`${data.plusMerged} merged "+N" pieces (FurnitureUpgrade mod) counted as one normal piece each.`);
      setImportError(null);
      setPendingImport({ items, source: "save", pieces: items.reduce((a, i) => a + i.count + i.rare, 0), note: notes.join(" "), skipped });
    } catch (e: any) {
      const msg = String(e?.message ?? "Could not read that save file");
      setImportError(msg.replace(/^\d{3}: /, "").replace(/^\{"message":"(.*)"\}$/, "$1"));
    } finally {
      setReading(false);
    }
  };

  const readFile = async (file: File) => {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const isSqlite = new TextDecoder().decode(head.slice(0, 15)) === "SQLite format 3";
    if (isSqlite || /\.sav$/i.test(file.name)) return readSave(file);
    return readJson(file);
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Your furniture">
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Your furniture</h2>
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="text-inventory-totals">
            {totals.pieces} pieces · {totals.types} types {saving ? "· saving" : "· saved"}
          </span>
        </div>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button className="w-full justify-start gap-2" data-testid="button-open-add">
              <Plus className="h-4 w-4" /> Add furniture
              <span className="ml-auto text-xs opacity-70">{FURNITURE.length} in game</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(420px,calc(100vw-2rem))] p-0" align="start">
            <Command
              filter={(value, search) => {
                const f = FURNITURE_BY_ID[value];
                if (!f) return 0;
                const hay = `${f.name} ${f.set ?? ""} ${f.id}`.toLowerCase();
                return search
                  .toLowerCase()
                  .split(/\s+/)
                  .every((w) => hay.includes(w))
                  ? 1
                  : 0;
              }}
            >
              <CommandInput placeholder="Search by name or set, e.g. sewer stool" data-testid="input-search-furniture" />
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Switch id="rare" checked={addRare} onCheckedChange={setAddRare} data-testid="switch-add-rare" />
                  <Label htmlFor="rare" className="text-xs">
                    Add as rare (2× stats)
                  </Label>
                </div>
                <span className="text-xs text-muted-foreground">Enter adds one, list stays open</span>
              </div>
              <CommandList className="max-h-[360px]">
                <CommandEmpty>No furniture matches.</CommandEmpty>
                <CommandGroup>
                  {addable.map((f) => {
                    const o = owned[f.id];
                    return (
                      <CommandItem
                        key={f.id}
                        value={f.id}
                        onSelect={() => add(f.id)}
                        className="gap-3"
                        data-testid={`option-furniture-${f.id}`}
                      >
                        <Glyph f={f} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{f.name}</span>
                            {o && o.count + o.rare > 0 && (
                              <span className="text-xs text-primary tabular-nums">
                                ×{o.count}
                                {o.rare ? ` +${o.rare}★` : ""}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <StatChips stats={f.stats} mult={addRare ? 2 : 1} size="xs" itemId={f.id} />
                            <span className="text-[11px] text-muted-foreground">{tilesLabel(f)}</span>
                          </div>
                        </div>
                        {lastAdded === f.id && <Plus className="h-3.5 w-3.5 text-primary" />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter owned"
              className="pl-8"
              data-testid="input-filter-owned"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Sort owned furniture"
            data-testid="select-sort-owned"
          >
            <option value="name">A–Z</option>
            {STAT_KEYS.map((k) => (
              <option key={k} value={k}>
                {STAT_LABEL[k]}
              </option>
            ))}
            <option value="placed">Unplaced first</option>
          </select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="list-owned">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {totals.types === 0 ? (
              <>
                <p className="font-medium text-foreground">No furniture yet</p>
                <p className="mt-1">Add what you own and the planner lays it out as you go.</p>
              </>
            ) : (
              "Nothing matches that filter."
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border" onMouseLeave={() => onFocus?.(null)}>
            {rows.map(({ f, count, rare }) => {
              const pl = placed[f.id];
              const total = count + rare;
              return (
                <li
                  key={f.id}
                  className={cn("flex items-start gap-3 px-4 py-2.5 transition-colors", focus === f.id && "bg-accent/60")}
                  onMouseEnter={() => onFocus?.(f.id)}
                  onMouseLeave={() => onFocus?.(null)}
                  data-testid={`row-owned-${f.id}`}
                >
                  <Glyph f={f} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium" title={f.name}>
                        {f.name}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <StatChips stats={f.stats} size="xs" itemId={f.id} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {tilesLabel(f)} · {KIND_LABEL[f.kind]} ·{" "}
                      <span className={cn(pl?.n ? "text-foreground" : "")}>
                        {pl?.n ? `${pl.n}/${total} placed` : "not placed"}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Stepper
                        label="Qty"
                        value={count}
                        onChange={(v) => onSet(f.id, v, rare)}
                        testid={`stepper-count-${f.id}`}
                      />
                      {f.canRare && (
                        <Stepper
                          label="Rare"
                          icon
                          value={rare}
                          onChange={(v) => onSet(f.id, count, v)}
                          testid={`stepper-rare-${f.id}`}
                        />
                      )}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground"
                    onClick={() => onSet(f.id, 0, 0)}
                    aria-label={`Remove ${f.name}`}
                    data-testid={`button-remove-${f.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border p-3">
        {exportHref ? (
          <Button variant="outline" size="sm" asChild className="flex-1 gap-1.5" data-testid="button-export">
            <a href={exportHref} target="_blank" rel="noopener noreferrer">
              <Download className="h-3.5 w-3.5" /> Export backup
            </a>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={onExport} data-testid="button-export">
            <Download className="h-3.5 w-3.5" /> Export backup
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-1.5"
          onClick={() => fileRef.current?.click()}
          disabled={reading}
          data-testid="button-import"
        >
          <Upload className="h-3.5 w-3.5" /> {reading ? "Reading" : "Import"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json,.sav"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) readFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {importError && <p className="px-4 pb-3 text-xs text-destructive">{importError}</p>}

      <AlertDialog open={!!pendingImport} onOpenChange={(o) => !o && setPendingImport(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your furniture list?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingImport?.source === "save"
                ? `Your Steam save has ${pendingImport.pieces} pieces of ${pendingImport.items.length} furniture types.`
                : `The file has ${pendingImport?.items.length ?? 0} furniture types.`}{" "}
              Importing replaces the {totals.types} types saved now.
              {pendingImport?.note && <span className="mt-2 block">{pendingImport.note}</span>}
              {!!pendingImport?.skipped?.length && (
                <span className="mt-2 block text-xs">Skipped unknown ids: {pendingImport.skipped.slice(0, 6).join(", ")}{pendingImport.skipped.length > 6 ? ` and ${pendingImport.skipped.length - 6} more` : ""}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-import">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-import"
              onClick={() => {
                if (pendingImport) onImport(pendingImport.items);
                setPendingImport(null);
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Stepper({
  label,
  value,
  onChange,
  icon,
  testid,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  icon?: boolean;
  testid: string;
}) {
  return (
    <div className="flex items-center gap-1" data-testid={testid}>
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon && <Sparkles className="h-3 w-3" style={{ color: "hsl(var(--rare))" }} />}
        {label}
      </span>
      <div className="flex items-center rounded-md border border-border">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
          onClick={() => onChange(Math.max(0, value - 1))}
          disabled={value <= 0}
          aria-label={`One less ${label.toLowerCase()}`}
        >
          <Minus className="h-3 w-3" />
        </button>
        <span className="w-6 text-center font-mono text-xs tabular-nums">{value}</span>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => onChange(Math.min(999, value + 1))}
          aria-label={`One more ${label.toLowerCase()}`}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export function RarePill() {
  return (
    <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]" style={{ color: "hsl(var(--rare))" }}>
      <Sparkles className="h-3 w-3" /> rare
    </Badge>
  );
}
