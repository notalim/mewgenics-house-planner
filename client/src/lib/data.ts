import furnitureRaw from "@/data/furniture.json";
import houseRaw from "@/data/house.json";

export type StatKey = "c" | "s" | "h" | "m" | "a";
export const STAT_KEYS: StatKey[] = ["c", "s", "h", "m", "a"];
export const STAT_LABEL: Record<StatKey, string> = {
  c: "Comfort",
  s: "Stimulation",
  h: "Health",
  m: "Mutation",
  a: "Appeal",
};
export const STAT_SHORT: Record<StatKey, string> = { c: "CMF", s: "STM", h: "HP", m: "MUT", a: "APL" };

/** Tile types from furniture_info.data: 1 solid, 2 surface, 3 support, 4 clickable-only, 5 poop logic */
export type Cell = [number, number, number];
export type Kind = "grounded" | "hanging" | "floating" | "mixed";

export interface Furniture {
  id: string;
  name: string;
  set: string | null;
  stats: Partial<Record<StatKey, number>>;
  extra: Record<string, string>;
  cells: Cell[];
  w: number;
  h: number;
  kind: Kind;
  special: boolean;
  canRare: boolean;
}

export interface RoomDef {
  id: string;
  label: string;
  w: number; // grid width incl. 1-cell border
  h: number; // grid height incl. border
  grid: string[]; // y-up rows, 0 free, 1 blocked, 2 surface
  free: number;
}

export interface HouseDef {
  label: string;
  rooms: string[];
}

export const FURNITURE = furnitureRaw as Furniture[];
export const FURNITURE_BY_ID: Record<string, Furniture> = Object.fromEntries(FURNITURE.map((f) => [f.id, f]));
export const ROOMS = (houseRaw as any).rooms as Record<string, RoomDef>;
export const HOUSES = (houseRaw as any).houses as Record<string, HouseDef>;

export function bodyCells(f: Furniture) {
  return f.cells.filter((c) => c[2] === 1 || c[2] === 2).length;
}
export function surfaceCells(f: Furniture) {
  return f.cells.filter((c) => c[2] === 2).length;
}
export function statsOf(f: Furniture, rare: boolean): Record<StatKey, number> {
  const m = rare ? 2 : 1;
  const out = { c: 0, s: 0, h: 0, m: 0, a: 0 } as Record<StatKey, number>;
  for (const k of STAT_KEYS) out[k] = (f.stats[k] ?? 0) * m;
  return out;
}

export const KIND_LABEL: Record<Kind, string> = {
  grounded: "Sits on a surface",
  hanging: "Hangs from ceiling",
  floating: "Wall / floats",
  mixed: "Leans on floor",
};

/** Dominant positive stat for color coding. */
export function dominantStat(f: Furniture): StatKey | null {
  let best: StatKey | null = null;
  let bv = 0;
  for (const k of STAT_KEYS) {
    const v = f.stats[k] ?? 0;
    if (v > bv) {
      bv = v;
      best = k;
    }
  }
  return best;
}

export const STAT_COLOR: Record<StatKey | "none", string> = {
  c: "var(--stat-c)",
  s: "var(--stat-s)",
  h: "var(--stat-h)",
  m: "var(--stat-m)",
  a: "var(--stat-a)",
  none: "var(--stat-none)",
};
