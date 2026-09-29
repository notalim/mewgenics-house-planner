import type { Furniture, RoomDef, StatKey } from "./data";
import { UTILITY_NOTE } from "./data";

/** Score credit for a piece with a house-wide job but no room stats (Food Storage Box): placed when space allows, never over a stat piece. */
const UTILITY_VALUE = 0.06;

/* ------------------------------------------------------------------ */
/* Inputs / outputs                                                     */
/* ------------------------------------------------------------------ */

export interface RoomGoal {
  roomId: string;
  preset: string;
  weights: Partial<Record<StatKey, number>>; // per-room weights (appeal handled globally)
  target: { stat: StatKey; value: number } | null;
  minComfort: number | null;
  maxComfort: number | null;
  /** floors for other stats, e.g. Health 10 (cures disorders) or Mutation 10 (full mutations) */
  mins?: Partial<Record<StatKey, number>>;
  cats: number;
}

export interface OwnedItem {
  itemId: string;
  count: number;
  rare: number;
}

export interface OptimizeInput {
  items: Record<string, Furniture>;
  rooms: Record<string, RoomDef>;
  goals: RoomGoal[]; // only rooms that are in use
  owned: OwnedItem[];
  appealWeight: number;
  warm?: WarmStart | null;
  /**
   * Search effort in LNS iterations. Deterministic: the same inventory, goals, effort and seed always
   * give the same layout, whatever device runs it. ~600 iterations per second on a laptop.
   */
  effort?: number;
  seed?: number;
  /**
   * Keep the previous layout (warm start chain) unless a fresh search beats it by more than this.
   * Stops the whole house reshuffling when one small piece is added. Default 0.35 points.
   */
  stabilityMargin?: number;
  /** Called with the best layout so far every `progressEvery` iterations. */
  onProgress?: (res: OptimizeResult) => void;
  progressEvery?: number;
  /** @deprecated kept for old callers; converted to effort */
  timeBudgetMs?: number;
}

/** A warm start is just the placement order per room: [itemId, rare][] */
export type WarmStart = Record<string, Array<[string, boolean]>>;

export interface Placement {
  itemId: string;
  rare: boolean;
  x: number; // grid coords incl. border
  y: number;
  restsOn: "floor" | "ceiling" | "item" | "wall" | null;
  hostIndex: number | null; // index of host placement inside the room
  step: number; // build order, 1-based
}

export interface RoomResult {
  roomId: string;
  placements: Placement[];
  stats: Record<StatKey, number>;
  score: number;
  goalMet: boolean;
  notes: string[];
  usedCells: number;
  freeCells: number;
}

export interface OptimizeResult {
  rooms: RoomResult[];
  houseAppeal: number;
  leftovers: Array<{ itemId: string; rare: boolean; count: number; reason: "no-space" | "not-useful" }>;
  totalScore: number;
  iterations: number;
  effort: number;
  ms: number;
  /** true while the search is still running (progress snapshots) */
  partial?: boolean;
  /** which start won: 0 = previous layout, 1+ = fresh chains */
  chain: number;
}

/* ------------------------------------------------------------------ */
/* RNG                                                                  */
/* ------------------------------------------------------------------ */
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Precomputed item shapes                                              */
/* ------------------------------------------------------------------ */
interface Shape {
  id: string;
  w: number;
  h: number;
  body: number[]; // flattened [dx,dy,type,...] for types 1,2
  sup: number[]; // flattened [dx,dy,...] required supports
  clear: number[]; // flattened [dx,dy,...] headroom tiles (type 4): must be open room space, other furniture may overlap
  kind: Furniture["kind"];
  base: Record<StatKey, number>;
  cost: number;
  bodyCount: number;
  surfCount: number;
  utility: number;
}

function buildShape(f: Furniture): Shape {
  const body: number[] = [];
  const sup: number[] = [];
  const clear: number[] = [];
  for (const [x, y, t] of f.cells) {
    if (t === 1 || t === 2) body.push(x, y, t);
    else if (t === 4) clear.push(x, y);
    else if (t === 3) {
      // "mixed" pieces (e.g. coffin) lean on a wall; only the bottom supports are enforced
      if (f.kind === "mixed" && y !== 0) continue;
      sup.push(x, y);
    }
  }
  const bodyCount = body.length / 3;
  let surf = 0;
  for (let i = 0; i < body.length; i += 3) if (body[i + 2] === 2) surf++;
  const base = { c: 0, s: 0, h: 0, m: 0, a: 0 } as Record<StatKey, number>;
  for (const k of Object.keys(base) as StatKey[]) base[k] = f.stats[k] ?? 0;
  // Surfaces create room for stacked pieces, so they are cheaper than solid tiles.
  const cost = Math.max(0.6, bodyCount - 0.5 * surf);
  const utility = UTILITY_NOTE[f.id] ? UTILITY_VALUE : 0;
  return { id: f.id, w: f.w, h: f.h, body, sup, clear, kind: f.kind, base, cost, bodyCount, surfCount: surf, utility };
}

/* ------------------------------------------------------------------ */
/* Room state                                                           */
/* ------------------------------------------------------------------ */
interface Unit {
  key: number; // unique unit index
  itemId: string;
  rare: boolean;
}

interface Placed {
  unit: Unit;
  x: number;
  y: number;
  host: number | null;
  restsOn: Placement["restsOn"];
}

class RoomState {
  def: RoomDef;
  W: number;
  H: number;
  base: Uint8Array; // 0 free, 1 blocked, 2 surface
  occ: Int16Array; // placement index or -1
  occType: Uint8Array; // 0 none, 1 solid, 2 surface
  supUsed: Uint8Array;
  placed: Placed[];
  stats: Record<StatKey, number>;
  used = 0;
  /** summed utility credit of placed pieces (see UTILITY_VALUE) */
  util = 0;
  noHang: boolean;

  constructor(def: RoomDef) {
    this.noHang = !!def.noHang;
    this.def = def;
    this.W = def.w;
    this.H = def.h;
    const n = this.W * this.H;
    this.base = new Uint8Array(n);
    for (let y = 0; y < this.H; y++) {
      const row = def.grid[y];
      for (let x = 0; x < this.W; x++) this.base[y * this.W + x] = row.charCodeAt(x) - 48;
    }
    this.occ = new Int16Array(n).fill(-1);
    this.occType = new Uint8Array(n);
    this.supUsed = new Uint8Array(n);
    this.placed = [];
    this.stats = { c: 0, s: 0, h: 0, m: 0, a: 0 };
  }

  canPlace(s: Shape, x: number, y: number): boolean {
    const { W, H } = this;
    const b = s.body;
    for (let i = 0; i < b.length; i += 3) {
      const cx = x + b[i];
      const cy = y + b[i + 1];
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
      const idx = cy * W + cx;
      if (this.base[idx] !== 0 || this.occ[idx] !== -1) return false;
    }
    // headroom (e.g. the spider on Spider TV, couch backs, hanging chains) can't poke into walls,
    // ceiling or roof, but other furniture may sit in it
    const cl = s.clear;
    for (let i = 0; i < cl.length; i += 2) {
      const cx = x + cl[i];
      const cy = y + cl[i + 1];
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
      if (this.base[cy * W + cx] !== 0) return false;
    }
    const sp = s.sup;
    for (let i = 0; i < sp.length; i += 2) {
      const cx = x + sp[i];
      const cy = y + sp[i + 1];
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
      const idx = cy * W + cx;
      if (this.supUsed[idx]) return false;
      if (this.base[idx] === 2) {
        // a surface above the floor row is ceiling or roof; the attic roof has no bolts to hang from
        if (cy > 0 && this.noHang) return false;
        continue;
      }
      if (this.occ[idx] !== -1 && this.occType[idx] === 2) continue;
      return false;
    }
    return true;
  }

  /** true if the cell is solid from the packing point of view (wall, roof, floor edge or furniture) */
  private solid(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
    const idx = cy * this.W + cx;
    return this.base[idx] !== 0 || this.occ[idx] !== -1;
  }

  /** is this an open surface that a grounded piece could still use? */
  private openSurfaceBelow(cx: number, cy: number): boolean {
    if (cy - 1 < 0) return false;
    const idx = (cy - 1) * this.W + cx;
    if (this.supUsed[idx]) return false;
    if (this.base[idx] === 2 && cy - 1 === 0) return true; // room floor
    return this.occ[idx] !== -1 && this.occType[idx] === 2; // top of another piece
  }

  /**
   * Packing quality of a position, higher is better. Rewards touching walls/other pieces (dense
   * packing, fewer stranded gaps), keeps grounded pieces low and hanging pieces high, and penalises
   * wall pieces that cover a still-usable surface (they would steal a stacking slot).
   */
  placementQuality(s: Shape, x: number, y: number): number {
    let contact = 0;
    let shadow = 0;
    const b = s.body;
    for (let i = 0; i < b.length; i += 3) {
      const cx = x + b[i];
      const cy = y + b[i + 1];
      if (this.solid(cx - 1, cy)) contact++;
      if (this.solid(cx + 1, cy)) contact++;
      if (this.solid(cx, cy + 1)) contact++;
      if (this.solid(cx, cy - 1)) contact++;
      if (s.kind !== "grounded" && s.kind !== "mixed" && this.openSurfaceBelow(cx, cy)) shadow++;
    }
    let q = contact - 3 * shadow;
    if (s.kind === "grounded" || s.kind === "mixed") {
      q += -0.9 * y - 0.05 * x;
      // floor width is the scarce resource: small pieces should climb onto shelves and tables
      if (y === 0 && s.surfCount < 3) q -= FLOOR_PENALTY;
    }
    else if (s.kind === "hanging") q += 0.9 * y + 0.05 * x;
    else q += 0.6 * y + 0.03 * x; // wall pieces: high and right, out of the way
    return q;
  }

  /** All feasible positions, sorted best first. */
  spots(s: Shape): Array<[number, number, number]> {
    const { W, H } = this;
    const maxX = W - s.w;
    const maxY = H - s.h;
    const out: Array<[number, number, number]> = [];
    if (maxX < 0 || maxY < 0) return out;
    for (let y = 0; y <= maxY; y++)
      for (let x = 0; x <= maxX; x++) if (this.canPlace(s, x, y)) out.push([x, y, this.placementQuality(s, x, y)]);
    out.sort((a, b) => b[2] - a[2]);
    return out;
  }

  /** Best position, optionally picking among the top few at random (diversification). */
  findSpot(s: Shape, rnd?: () => number, spread = 0): [number, number] | null {
    const sp = this.spots(s);
    if (!sp.length) return null;
    if (rnd && spread > 0 && sp.length > 1) {
      // geometric choice: mostly the best, sometimes 2nd/3rd
      let i = 0;
      while (i < sp.length - 1 && i < 4 && rnd() < spread) i++;
      return [sp[i][0], sp[i][1]];
    }
    return [sp[0][0], sp[0][1]];
  }

  place(s: Shape, unit: Unit, x: number, y: number) {
    const idxP = this.placed.length;
    const { W } = this;
    let host: number | null = null;
    let restsOn: Placement["restsOn"] = s.sup.length ? null : "wall";
    for (let i = 0; i < s.sup.length; i += 2) {
      const idx = (y + s.sup[i + 1]) * W + (x + s.sup[i]);
      this.supUsed[idx] = 1;
      if (this.base[idx] === 2) {
        if (!restsOn) restsOn = y + s.sup[i + 1] === 0 ? "floor" : "ceiling";
      } else {
        host = this.occ[idx];
        restsOn = "item";
      }
    }
    for (let i = 0; i < s.body.length; i += 3) {
      const idx = (y + s.body[i + 1]) * W + (x + s.body[i]);
      this.occ[idx] = idxP;
      this.occType[idx] = s.body[i + 2];
    }
    this.used += s.bodyCount;
    this.util += s.utility;
    this.placed.push({ unit, x, y, host, restsOn });
    const m = unit.rare ? 2 : 1;
    for (const k of STAT_ORDER) this.stats[k] += s.base[k] * m;
  }
}

const STAT_ORDER: StatKey[] = ["c", "s", "h", "m", "a"];
const STAT_NAME: Record<StatKey, string> = { c: "Comfort", s: "Stimulation", h: "Health", m: "Mutation", a: "Appeal" };

/* ------------------------------------------------------------------ */
/* Scoring                                                              */
/* ------------------------------------------------------------------ */
const COMFORT_PENALTY = 4;
/** floor width is the scarce resource in 16-wide rooms, so pieces that can stack are pushed up onto shelves */
const FLOOR_PENALTY = 5;
const FILL_PENALTY = 1.5;

function roomScore(stats: Record<StatKey, number>, g: RoomGoal, P = COMFORT_PENALTY): number {
  let sc = 0;
  const comfort = stats.c - Math.max(0, g.cats - 4);
  for (const k of STAT_ORDER) {
    if (k === "a") continue;
    const w = g.weights[k] ?? 0;
    if (!w) continue;
    let v = k === "c" ? comfort : stats[k];
    // Comfort past a small buffer above the floor barely matters unless Comfort is the room's point
    if (k === "c" && g.preset !== "comfort") {
      const cap = (g.minComfort ?? 0) + 4;
      if (v > cap) v = cap + 0.15 * (v - cap);
    }
    if (g.target && g.target.stat === k) {
      const T = g.target.value;
      v = Math.min(v, T) + 0.08 * Math.max(0, v - T);
    }
    sc += w * v;
  }
  if (g.minComfort !== null && comfort < g.minComfort) sc -= P * (g.minComfort - comfort);
  if (g.maxComfort !== null && comfort > g.maxComfort) sc -= P * (comfort - g.maxComfort);
  if (g.mins)
    for (const k of STAT_ORDER) {
      const m = g.mins[k];
      if (m === undefined || m === null || k === "c" || k === "a") continue;
      if (stats[k] < m) sc -= P * 0.6 * (m - stats[k]);
    }
  return sc;
}

/* ------------------------------------------------------------------ */
/* Solver                                                               */
/* ------------------------------------------------------------------ */
interface Solution {
  rooms: RoomState[];
  pool: Map<string, Unit[]>; // unplaced units by "itemId|rare"
}

const poolKey = (itemId: string, rare: boolean) => `${itemId}|${rare ? 1 : 0}`;

export function optimize(input: OptimizeInput): OptimizeResult {
  const t0 = Date.now();
  const effort = Math.max(0, Math.round(input.effort ?? (input.timeBudgetMs ? input.timeBudgetMs * 0.6 : 2500)));
  const seed = input.seed ?? 1337;
  const shapes: Record<string, Shape> = {};
  const aW = input.appealWeight;

  // Most a single room could reach in each stat if every positive piece went there. A floor above
  // that is impossible, so it is dropped instead of making the optimizer refuse useful pieces.
  const reach: Record<StatKey, number> = { c: 0, s: 0, h: 0, m: 0, a: 0 };
  for (const o of input.owned) {
    const f = input.items[o.itemId];
    if (!f) continue;
    const n = o.count + 2 * o.rare;
    for (const k of STAT_ORDER) reach[k] += Math.max(0, f.stats[k] ?? 0) * n;
  }
  const unreachable: Record<string, string[]> = {};
  const goals = input.goals
    .filter((g) => input.rooms[g.roomId])
    .map((g) => {
      if (!g.mins) return g;
      const mins: Partial<Record<StatKey, number>> = {};
      for (const [k, v] of Object.entries(g.mins) as Array<[StatKey, number]>) {
        if (v === undefined || v === null) continue;
        if (v > reach[k]) (unreachable[g.roomId] ??= []).push(`${STAT_NAME[k]} ${v} is out of reach: all your pieces add up to +${reach[k]}`);
        else mins[k] = v;
      }
      return { ...g, mins };
    });

  // Build units
  let key = 0;
  const allUnits: Unit[] = [];
  for (const o of input.owned) {
    const f = input.items[o.itemId];
    if (!f) continue;
    shapes[f.id] ??= buildShape(f);
    for (let i = 0; i < o.count; i++) allUnits.push({ key: key++, itemId: f.id, rare: false });
    for (let i = 0; i < o.rare; i++) allUnits.push({ key: key++, itemId: f.id, rare: true });
  }

  const makePool = (units: Unit[]) => {
    const pool = new Map<string, Unit[]>();
    for (const u of units) {
      const k = poolKey(u.itemId, u.rare);
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k)!.push(u);
    }
    return pool;
  };
  const pushPool = (pool: Map<string, Unit[]>, u: Unit) => {
    const k = poolKey(u.itemId, u.rare);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k)!.push(u);
  };
  const clonePool = (p: Map<string, Unit[]>) => {
    const n = new Map<string, Unit[]>();
    p.forEach((v, k) => n.set(k, v.slice()));
    return n;
  };

  const totalScore = (rooms: RoomState[]) => {
    let s = 0;
    let appeal = 0;
    for (let i = 0; i < rooms.length; i++) {
      s += roomScore(rooms[i].stats, goals[i]) + rooms[i].util;
      appeal += rooms[i].stats.a;
    }
    // tiny tie-breaker: prefer layouts that leave more empty tiles
    let used = 0;
    for (const r of rooms) used += r.used;
    return s + aW * appeal - used * 0.0005;
  };

  const marginal = (room: RoomState, gi: number, sh: Shape, rare: boolean) => {
    const g = goals[gi];
    const before = roomScore(room.stats, g, FILL_PENALTY) + aW * room.stats.a;
    const m = rare ? 2 : 1;
    const st = { ...room.stats };
    for (const k of STAT_ORDER) st[k] += sh.base[k] * m;
    return roomScore(st, g, FILL_PENALTY) + aW * st.a - before + sh.utility;
  };

  /**
   * The candidate doesn't fit as the room stands. Rebuild the room with the candidate included in
   * canonical order (big pieces first). Accept only if nothing already placed is lost.
   */
  const insertWithRepack = (sol: Solution, ri: number, u: Unit, rnd: () => number, attempts = 1): boolean => {
    const room = sol.rooms[ri];
    const sh = shapes[u.itemId];
    if (room.used + sh.bodyCount > room.def.free) return false;
    const order = room.placed.map((p) => p.unit);
    order.push(u);
    for (let a = 0; a < attempts; a++) {
      const scratch = new Map<string, Unit[]>();
      const r2 = a === 0 ? replay(room.def, order, scratch) : replay(room.def, order, scratch, rnd, 0.3, 60);
      if (r2.placed.length === order.length) {
        sol.rooms[ri] = r2;
        return true;
      }
    }
    return false;
  };

  /** Greedy fill: repeatedly add the best density candidate that fits. */
  const fill = (sol: Solution, roomIdx: number[], noise: number, rnd: () => number, spread: number, repacks = 4, repackAttempts = 1) => {
    const blocked = new Set<string>();
    let repackLeft = repacks;
    for (let guard = 0; guard < 3000; guard++) {
      const cands: Array<{ ri: number; k: string; dens: number }> = [];
      sol.pool.forEach((units, k) => {
        if (!units.length) return;
        const u = units[0];
        const sh = shapes[u.itemId];
        for (const ri of roomIdx) {
          if (blocked.has(ri + "#" + k)) continue;
          const d = marginal(sol.rooms[ri], ri, sh, u.rare);
          if (d <= 1e-9) continue;
          const dens = (d / sh.cost) * (1 + noise * (rnd() - 0.5));
          cands.push({ ri, k, dens });
        }
      });
      if (!cands.length) return;
      cands.sort((a, b) => b.dens - a.dens);
      let placedOne = false;
      for (const c of cands) {
        const units = sol.pool.get(c.k)!;
        const sh = shapes[units[0].itemId];
        const room = sol.rooms[c.ri];
        const spot = room.findSpot(sh, rnd, spread);
        if (spot) {
          const u = units.shift()!;
          room.place(sh, u, spot[0], spot[1]);
          placedOne = true;
          break;
        }
        if (repackLeft > 0 && sh.bodyCount >= 3) {
          repackLeft--;
          if (insertWithRepack(sol, c.ri, units[0], rnd, repackAttempts)) {
            units.shift();
            placedOne = true;
            break;
          }
        }
        blocked.add(c.ri + "#" + c.k);
      }
      if (!placedOne) return;
    }
  };

  /**
   * Packing order: big grounded pieces (shelves and tables first, they carry others), then hanging,
   * then wall pieces last since they can go anywhere. `jitter` shuffles this a little for diversity.
   */
  const kindRank = (k: Shape["kind"]) => (k === "grounded" || k === "mixed" ? 0 : k === "hanging" ? 1 : 2);
  const canonical = (units: Unit[], rnd?: () => number, jitter = 0) => {
    const keyed = units.map((u) => {
      const sh = shapes[u.itemId];
      let k = kindRank(sh.kind) * 1000 - sh.bodyCount * 10 - sh.surfCount * 6 - sh.h * 2;
      if (rnd && jitter > 0) k += (rnd() - 0.5) * jitter;
      return { u, k };
    });
    keyed.sort((a, b) => a.k - b.k);
    return keyed.map((x) => x.u);
  };

  /** Rebuild a room from an order of units; units that no longer fit go back to the pool. */
  const replay = (def: RoomDef, order: Unit[], pool: Map<string, Unit[]>, rnd?: () => number, spread = 0, jitter = 0) => {
    const r = new RoomState(def);
    for (const u of canonical(order, rnd, jitter)) {
      const sh = shapes[u.itemId];
      const spot = r.findSpot(sh, rnd, spread);
      if (spot) r.place(sh, u, spot[0], spot[1]);
      else pushPool(pool, u);
    }
    return r;
  };

  const allIdx = goals.map((_, i) => i);
  const emptyResult = () => toResult({ rooms: goals.map((g) => new RoomState(input.rooms[g.roomId])), pool: makePool(allUnits) }, goals, shapes, input, 0, 0, effort, Date.now() - t0, unreachable, 1);
  if (!goals.length || !allUnits.length) return emptyResult();

  /* ---------------- starting points ---------------- */
  const starts: Array<{ sol: Solution; label: number }> = [];
  if (input.warm) {
    const pool = makePool(allUnits);
    const rooms = goals.map((g) => {
      const order: Unit[] = [];
      for (const [itemId, rare] of input.warm![g.roomId] ?? []) {
        const list = pool.get(poolKey(itemId, rare));
        if (list && list.length) order.push(list.shift()!);
      }
      return replay(input.rooms[g.roomId], order, pool);
    });
    const warm: Solution = { rooms, pool };
    fill(warm, allIdx, 0, mulberry32(seed), 0);
    starts.push({ sol: warm, label: 0 });
  }
  const nFresh = effort >= 1500 ? 3 : effort >= 400 ? 2 : 1;
  for (let c = 0; c < nFresh; c++) {
    const rnd = mulberry32(seed + 101 * (c + 1));
    const sol: Solution = { rooms: goals.map((g) => new RoomState(input.rooms[g.roomId])), pool: makePool(allUnits) };
    fill(sol, allIdx, c === 0 ? 0 : 0.5, rnd, c === 0 ? 0 : 0.3);
    starts.push({ sol, label: c + 1 });
  }

  /* ---------------- annealed large neighbourhood search ---------------- */
  let globalBest = starts[0].sol;
  let globalBestScore = totalScore(globalBest.rooms);
  let globalChain = starts[0].label;
  for (const s of starts) {
    const sc = totalScore(s.sol.rooms);
    if (sc > globalBestScore + 1e-9) {
      globalBest = s.sol;
      globalBestScore = sc;
      globalChain = s.label;
    }
  }

  const perChain = Math.floor(effort / starts.length);
  let iterations = 0;
  let lastProgress = 0;
  const progressEvery = input.progressEvery ?? 250;
  const report = () => {
    if (!input.onProgress) return;
    input.onProgress(toResult(globalBest, goals, shapes, input, globalBestScore, iterations, effort, Date.now() - t0, unreachable, globalChain, true));
  };

  let warmChain: { sol: Solution; score: number } | null = null;
  const T0 = 0.3;
  const T1 = 0.02;
  const lnsRepackAttempts = 3;
  const lnsRepacks = 6;

  for (const start of starts) {
    const rnd = mulberry32(seed * 7 + start.label * 9973);
    let cur = start.sol;
    let curScore = totalScore(cur.rooms);
    let chainBest = cur;
    let chainBestScore = curScore;
    let sinceImprove = 0;

    for (let it = 0; it < perChain; it++) {
      iterations++;
      const frac = it / Math.max(1, perChain);
      const T = T0 * Math.pow(T1 / T0, frac);

      const pool = clonePool(cur.pool);
      const rooms = cur.rooms.slice();
      const touched: number[] = [];
      const move = rnd();

      const ruinRoom = (ri: number, mode: number) => {
        const room = cur.rooms[ri];
        const order = room.placed.map((p) => p.unit);
        let kept = order.slice();
        if (mode === 0) {
          // random pieces
          const nRemove = Math.min(kept.length, 1 + Math.floor(rnd() * 5));
          for (let i = 0; i < nRemove && kept.length; i++) {
            const j = Math.floor(rnd() * kept.length);
            const [u] = kept.splice(j, 1);
            pushPool(pool, u);
          }
        } else if (mode === 1) {
          // a vertical band: everything whose body touches columns [x0, x0+w)
          const x0 = 1 + Math.floor(rnd() * (room.W - 2));
          const w = 1 + Math.floor(rnd() * 4);
          kept = [];
          for (const p of room.placed) {
            const sh = shapes[p.unit.itemId];
            let hit = false;
            for (let i = 0; i < sh.body.length && !hit; i += 3) {
              const cx = p.x + sh.body[i];
              if (cx >= x0 && cx < x0 + w) hit = true;
            }
            if (hit) pushPool(pool, p.unit);
            else kept.push(p.unit);
          }
        } else if (mode === 2) {
          // every copy of one item type (lets a whole family be swapped out)
          if (order.length) {
            const pick = order[Math.floor(rnd() * order.length)];
            kept = [];
            for (const u of order) {
              if (u.itemId === pick.itemId && u.rare === pick.rare) pushPool(pool, u);
              else kept.push(u);
            }
          }
        } else {
          // the biggest piece plus a couple of random ones
          if (order.length) {
            let bi = 0;
            for (let i = 1; i < order.length; i++) if (shapes[order[i].itemId].bodyCount > shapes[order[bi].itemId].bodyCount) bi = i;
            const [u] = kept.splice(bi, 1);
            pushPool(pool, u);
            const extra = Math.min(kept.length, Math.floor(rnd() * 3));
            for (let i = 0; i < extra && kept.length; i++) {
              const j = Math.floor(rnd() * kept.length);
              const [v] = kept.splice(j, 1);
              pushPool(pool, v);
            }
          }
        }
        rooms[ri] = replay(room.def, kept, pool, rnd, 0.25, rnd() < 0.4 ? 40 : 0);
        touched.push(ri);
      };

      if (move < 0.55 || goals.length === 1) {
        // one room ruined, one other room re-opened so pieces can migrate
        const ri = Math.floor(rnd() * goals.length);
        ruinRoom(ri, Math.floor(rnd() * 4));
        if (goals.length > 1) {
          const others = allIdx.filter((i) => i !== ri);
          const o = others[Math.floor(rnd() * others.length)];
          rooms[o] = replay(cur.rooms[o].def, cur.rooms[o].placed.map((p) => p.unit), pool, undefined, 0);
          touched.push(o);
        }
      } else if (move < 0.85) {
        // two rooms ruined at once: real exchanges between rooms
        const a = Math.floor(rnd() * goals.length);
        let b = Math.floor(rnd() * (goals.length - 1));
        if (b >= a) b++;
        ruinRoom(a, Math.floor(rnd() * 4));
        ruinRoom(b, Math.floor(rnd() * 4));
      } else {
        // repack one room from scratch in a new order (pure geometry move)
        const ri = Math.floor(rnd() * goals.length);
        const order = cur.rooms[ri].placed.map((p) => p.unit);
        rooms[ri] = replay(cur.rooms[ri].def, order, pool, rnd, 0.35, 120);
        touched.push(ri);
      }

      const cand: Solution = { rooms, pool };
      fill(cand, touched, 0.6, rnd, 0.15, lnsRepacks, lnsRepackAttempts);
      const sc = totalScore(cand.rooms);
      const delta = sc - curScore;
      if (delta >= -1e-9 || rnd() < Math.exp(delta / T)) {
        cur = cand;
        curScore = sc;
        if (sc > chainBestScore + 1e-9) {
          chainBest = cand;
          chainBestScore = sc;
          sinceImprove = 0;
        } else sinceImprove++;
      } else sinceImprove++;

      // stuck for a long while: jump back to the chain's best
      if (sinceImprove > 400) {
        cur = chainBest;
        curScore = chainBestScore;
        sinceImprove = 0;
      }

      if (chainBestScore > globalBestScore + 1e-9) {
        globalBest = chainBest;
        globalBestScore = chainBestScore;
        globalChain = start.label;
      }
      if (iterations - lastProgress >= progressEvery) {
        lastProgress = iterations;
        report();
      }
    }
    if (start.label === 0) warmChain = { sol: chainBest, score: chainBestScore };
  }

  // ---- stability: prefer the chain that started from the previous layout unless clearly beaten
  if (warmChain && globalChain !== 0 && globalBestScore - warmChain.score <= (input.stabilityMargin ?? 0.35)) {
    globalBest = warmChain.sol;
    globalBestScore = warmChain.score;
    globalChain = 0;
  }

  // ---- final polish: deterministic greedy pass, then squeeze in anything left
  const polishRnd = mulberry32(seed + 5);
  fill(globalBest, allIdx, 0, polishRnd, 0, 60, 12);
  globalBestScore = totalScore(globalBest.rooms);

  return toResult(globalBest, goals, shapes, input, globalBestScore, iterations, effort, Date.now() - t0, unreachable, globalChain);
}

function toResult(
  sol: Solution,
  goals: RoomGoal[],
  shapes: Record<string, Shape>,
  input: OptimizeInput,
  score: number,
  iterations: number,
  effort: number,
  ms: number,
  unreachableNotes: Record<string, string[]>,
  chain: number,
  partial = false,
): OptimizeResult {
  let houseAppeal = 0;
  const rooms: RoomResult[] = sol.rooms.map((r, i) => {
    const g = goals[i];
    houseAppeal += r.stats.a;
    const stats = { ...r.stats, c: r.stats.c - Math.max(0, g.cats - 4) };
    const notes: string[] = [...(unreachableNotes[g.roomId] ?? [])];
    let goalMet = notes.length === 0;
    if (g.minComfort !== null && stats.c < g.minComfort) {
      goalMet = false;
      notes.push(`Comfort ${stats.c} is below ${g.minComfort}`);
    }
    if (g.maxComfort !== null && stats.c > g.maxComfort) {
      goalMet = false;
      notes.push(`Comfort ${stats.c} is above ${g.maxComfort}`);
    }
    if (g.mins)
      for (const k of STAT_ORDER) {
        const m = g.mins[k];
        if (m === undefined || m === null || k === "c" || k === "a") continue;
        if (stats[k] < m) {
          goalMet = false;
          notes.push(`${STAT_NAME[k]} ${stats[k]} is below ${m}`);
        }
      }
    if (g.target && stats[g.target.stat] < g.target.value) {
      goalMet = false;
      notes.push(`Short of target by ${g.target.value - stats[g.target.stat]}`);
    }
    let free = 0;
    for (let k = 0; k < r.base.length; k++) if (r.base[k] === 0) free++;
    return {
      roomId: g.roomId,
      placements: r.placed.map((p, idx) => ({
        itemId: p.unit.itemId,
        rare: p.unit.rare,
        x: p.x,
        y: p.y,
        restsOn: p.restsOn,
        hostIndex: p.host,
        step: idx + 1,
      })),
      stats,
      score: roomScore(r.stats, g),
      goalMet,
      notes,
      usedCells: r.used,
      freeCells: free,
    };
  });

  const leftovers: OptimizeResult["leftovers"] = [];
  sol.pool.forEach((units, k) => {
    if (!units.length) return;
    const [itemId, rare] = k.split("|");
    const sh = shapes[itemId];
    // useful if it would improve any room's score
    let useful = sh.utility > 0;
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const st = { ...sol.rooms[i].stats };
      const m = rare === "1" ? 2 : 1;
      const before = roomScore(st, g, FILL_PENALTY) + input.appealWeight * st.a;
      for (const s of STAT_ORDER) st[s] += sh.base[s] * m;
      if (roomScore(st, g, FILL_PENALTY) + input.appealWeight * st.a > before + 1e-9) useful = true;
    }
    leftovers.push({ itemId, rare: rare === "1", count: units.length, reason: useful ? "no-space" : "not-useful" });
  });
  leftovers.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "no-space" ? -1 : 1));
  return { rooms, houseAppeal, leftovers, totalScore: score, iterations, effort, ms, partial, chain };
}

export function toWarm(res: OptimizeResult): WarmStart {
  const w: WarmStart = {};
  for (const r of res.rooms) w[r.roomId] = r.placements.map((p) => [p.itemId, p.rare]);
  return w;
}
