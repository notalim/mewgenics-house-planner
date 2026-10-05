import { useMemo, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FURNITURE_BY_ID, ROOMS } from "@/lib/data";
import type { OptimizeResult } from "@/lib/optimizer";
import type { Snapshot, SnapshotPlacement } from "@/components/snapshots";
import { cellLabel } from "@/components/room-card";

interface Change {
  itemId: string;
  rare: boolean;
  kind: "add" | "remove" | "move";
  from?: { roomId: string; x: number; y: number };
  to?: { roomId: string; x: number; y: number };
}

const key = (p: { itemId: string; rare: boolean }) => `${p.itemId}|${p.rare ? 1 : 0}`;

/** Multiset diff of two houses. Same item in the same room at the same cell cancels; what is left pairs up as moves. */
export function diffLayouts(before: Record<string, SnapshotPlacement[]>, after: Record<string, SnapshotPlacement[]>, exact: boolean): Change[] {
  const gone: Array<SnapshotPlacement & { roomId: string }> = [];
  const added: Array<SnapshotPlacement & { roomId: string }> = [];
  const rooms = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const roomId of Array.from(rooms)) {
    const b = (before[roomId] ?? []).map((p) => ({ ...p, roomId }));
    const a = (after[roomId] ?? []).map((p) => ({ ...p, roomId }));
    const used = new Set<number>();
    for (const pb of b) {
      const j = a.findIndex((pa, i) => !used.has(i) && key(pa) === key(pb) && (!exact || (pa.x === pb.x && pa.y === pb.y)));
      if (j >= 0) used.add(j);
      else gone.push(pb);
    }
    a.forEach((pa, i) => {
      if (!used.has(i)) added.push(pa);
    });
  }
  const changes: Change[] = [];
  const usedAdd = new Set<number>();
  for (const g of gone) {
    // prefer a match inside the same room (a nudge), then any room (a move)
    let j = added.findIndex((p, i) => !usedAdd.has(i) && key(p) === key(g) && p.roomId === g.roomId);
    if (j < 0) j = added.findIndex((p, i) => !usedAdd.has(i) && key(p) === key(g));
    if (j >= 0) {
      usedAdd.add(j);
      const a = added[j];
      changes.push({ itemId: g.itemId, rare: g.rare, kind: "move", from: g, to: a });
    } else changes.push({ itemId: g.itemId, rare: g.rare, kind: "remove", from: g });
  }
  added.forEach((a, i) => {
    if (!usedAdd.has(i)) changes.push({ itemId: a.itemId, rare: a.rare, kind: "add", to: a });
  });
  const order = { add: 0, move: 1, remove: 2 };
  return changes.sort((p, q) => order[p.kind] - order[q.kind] || FURNITURE_BY_ID[p.itemId].name.localeCompare(FURNITURE_BY_ID[q.itemId].name));
}

export function resultPlacements(result: OptimizeResult): Record<string, SnapshotPlacement[]> {
  return Object.fromEntries(result.rooms.map((r) => [r.roomId, r.placements.map((p) => ({ itemId: p.itemId, rare: p.rare, x: p.x, y: p.y }))]));
}

const roomName = (id: string) => ROOMS[id]?.label ?? id;
const where = (exact: boolean, itemId: string, p: { roomId: string; x: number; y: number }) =>
  exact ? `${roomName(p.roomId)} (${cellLabel(itemId, p.x, p.y)})` : roomName(p.roomId);

/**
 * What to change in the game to go from a saved layout to the one on screen. Save a snapshot when you have built the
 * house, then every later recompute lists only the pieces that differ, so you never rebuild from scratch.
 */
export function LayoutDiff({ result, snapshots }: { result: OptimizeResult; snapshots: Snapshot[] }) {
  const sorted = useMemo(() => snapshots.slice().sort((a, b) => b.at.localeCompare(a.at)), [snapshots]);
  const [pick, setPick] = useState<string>("");
  const snap = sorted.find((s) => s.id === pick) ?? sorted[0];
  const diff = useMemo(() => {
    if (!snap) return null;
    const layoutExact = Object.values(snap.layout).every((list) => list.every((e) => e.length === 4));
    const exact = !!snap.placements || layoutExact;
    const before: Record<string, SnapshotPlacement[]> =
      snap.placements ??
      Object.fromEntries(Object.entries(snap.layout).map(([r, list]) => [r, list.map((e) => ({ itemId: e[0], rare: e[1], x: e.length === 4 ? e[2] : -1, y: e.length === 4 ? e[3] : -1 }))]));
    return { exact, changes: diffLayouts(before, resultPlacements(result), exact) };
  }, [snap, result]);
  if (!snap || !diff) return null;
  const n = diff.changes.length;
  return (
    <Collapsible className="rounded-lg border border-border bg-card" data-testid="layout-diff">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <CollapsibleTrigger className="flex items-center gap-2 text-xs font-medium hover:underline" data-testid="button-diff-toggle">
          <GitCompareArrows className="h-3.5 w-3.5 text-primary" />
          Changes vs saved layout
          <span className="rounded-sm bg-muted px-1 font-mono text-[11px]">{n === 0 ? "none" : n}</span>
        </CollapsibleTrigger>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          compared with
          <Select value={snap.id} onValueChange={setPick}>
            <SelectTrigger className="h-7 w-[180px] text-[11px]" data-testid="select-diff-snapshot">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sorted.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      </div>
      <CollapsibleContent>
        <div className="border-t border-border px-4 py-3 text-xs">
          {n === 0 ? (
            <p className="text-muted-foreground">The house on screen matches "{snap.name}" piece for piece.</p>
          ) : (
            <>
              <p className="mb-2 text-muted-foreground">
                Do these in the game and your house matches the layout above.
                {!diff.exact && " This snapshot predates cell tracking, so only room changes are listed, not nudges inside a room. Save a new one after you build."}
              </p>
              <ul className="grid gap-1 sm:grid-cols-2" data-testid="list-diff">
                {diff.changes.map((c, i) => {
                  const f = FURNITURE_BY_ID[c.itemId];
                  const name = (
                    <span className="font-medium">
                      {f.name}
                      {c.rare && <span style={{ color: "hsl(var(--rare))" }}> ★</span>}
                    </span>
                  );
                  return (
                    <li key={i} className="rounded-md bg-muted/50 px-2 py-1" data-testid={`row-diff-${c.kind}`}>
                      {c.kind === "add" && (
                        <>
                          <span className="text-primary">Add</span> {name} <span className="text-muted-foreground">from storage to {where(diff.exact, c.itemId, c.to!)}</span>
                        </>
                      )}
                      {c.kind === "remove" && (
                        <>
                          <span className="text-destructive">Remove</span> {name} <span className="text-muted-foreground">from {where(diff.exact, c.itemId, c.from!)} to storage</span>
                        </>
                      )}
                      {c.kind === "move" && (
                        <>
                          Move {name}{" "}
                          <span className="text-muted-foreground">
                            {where(diff.exact, c.itemId, c.from!)} to {where(diff.exact, c.itemId, c.to!)}
                          </span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
