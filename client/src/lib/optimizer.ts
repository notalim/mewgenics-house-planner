import type { Furniture, RoomDef, StatKey } from "./data";

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
  timeBudgetMs?: number;
  seed?: number;
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
  ms: number;
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
  kind: Furniture["kind"];
  base: Record<StatKey, number>;
  cost: number;
  bodyCount: number;
}

function buildShape(f: Furniture): Shape {
  const body: number[] = [];
  const sup: number[] = [];
  for (const [x, y, t] of f.cells) {
    if (t === 1 || t === 2) body.push(x, y, t);
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
  return { id: f.id, w: f.w, h: f.h, body, sup, kind: f.kind, base, cost, bodyCount };
}

/* ------------------------------------------------------------------ */
/* Room state                                                           */
/* ------------------------------------------------------------------ */
interface Unit {
  key: number; // unique unit index
  itemId: string;
  rare: boolean;
}

class RoomState {
  def: RoomDef;
  W: number;
  H: number;
  base: Uint8Array; // 0 free, 1 blocked, 2 surface
  occ: Int16Array; // placement index or -1
  occType: Uint8Array; // 0 none, 1 solid, 2 surface
  supUsed: Uint8Array;
  placed: Array<{ unit: Unit; x: number; y: number; host: number | null; restsOn: Placement["restsOn"] }>;
  stats: Record<StatKey, number>;
  used = 0;

  constructor(def: RoomDef) {
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
    const sp = s.sup;
    for (let i = 0; i < sp.length; i += 2) {
      const cx = x + sp[i];
      const cy = y + sp[i + 1];
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
      const idx = cy * W + cx;
      if (this.supUsed[idx]) return false;
      if (this.base[idx] === 2) continue;
      if (this.occ[idx] !== -1 && this.occType[idx] === 2) continue;
      return false;
    }
    return true;
  }

  findSpot(s: Shape): [number, number] | null {
    const { W, H } = this;
    const maxX = W - s.w;
    const maxY = H - s.h;
    if (maxX < 0 || maxY < 0) return null;
    if (s.kind === "grounded" || s.kind === "mixed") {
      for (let y = 0; y <= maxY; y++) for (let x = 0; x <= maxX; x++) if (this.canPlace(s, x, y)) return [x, y];
    } else if (s.kind === "hanging") {
      for (let y = maxY; y >= 0; y--) for (let x = 0; x <= maxX; x++) if (this.canPlace(s, x, y)) return [x, y];
    } else {
      // floating wall pieces: keep them high and to the right so floor and low surfaces stay open
      for (let y = maxY; y >= 0; y--) for (let x = maxX; x >= 0; x--) if (this.canPlace(s, x, y)) return [x, y];
    }
    return null;
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
    this.placed.push({ unit, x, y, host, restsOn });
    const m = unit.rare ? 2 : 1;
    for (const k of STAT_ORDER) this.stats[k] += s.base[k] * m;
  }
}

const STAT_ORDER: StatKey[] = ["c", "s", "h", "m", "a"];

/* ------------------------------------------------------------------ */
/* Scoring                                                              */
/* ------------------------------------------------------------------ */
const COMFORT_PENALTY = 4;
/** Softer penalty while constructing, so trade-off pieces get tried and then balanced. */
const FILL_PENALTY = 1.5;

function roomScore(stats: Record<StatKey, number>, g: RoomGoal, P = COMFORT_PENALTY): number {
  let sc = 0;
  const comfort = stats.c - Math.max(0, g.cats - 4);
  for (const k of STAT_ORDER) {
    if (k === "a") continue;
    const w = g.weights[k] ?? 0;
    if (!w) continue;
    let v = k === "c" ? comfort : stats[k];
    if (g.target && g.target.stat === k) {
      const T = g.target.value;
      v = Math.min(v, T) + 0.08 * Math.max(0, v - T);
    }
    sc += w * v;
  }
  if (g.minComfort !== null && comfort < g.minComfort) sc -= P * (g.minComfort - comfort);
  if (g.maxComfort !== null && comfort > g.maxComfort) sc -= P * (comfort - g.maxComfort);
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
  const budget = input.timeBudgetMs ?? 900;
  const rnd = mulberry32(input.seed ?? 1337);
  const shapes: Record<string, Shape> = {};
  const goals = input.goals.filter((g) => input.rooms[g.roomId]);
  const aW = input.appealWeight;

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

  const totalScore = (rooms: RoomState[]) => {
    let s = 0;
    let appeal = 0;
    for (let i = 0; i < rooms.length; i++) {
      s += roomScore(rooms[i].stats, goals[i]);
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
    return roomScore(st, g, FILL_PENALTY) + aW * st.a - before;
  };

  /** Greedy fill: repeatedly add the best density candidate that fits. */
  const fill = (sol: Solution, roomIdx: number[], noise: number) => {
    const blocked = new Set<string>();
    for (let guard = 0; guard < 2000; guard++) {
      let best: { ri: number; k: string; dens: number } | null = null;
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
      for (const c of cands) {
        const units = sol.pool.get(c.k)!;
        const sh = shapes[units[0].itemId];
        const room = sol.rooms[c.ri];
        const spot = room.findSpot(sh);
        if (spot) {
          const u = units.shift()!;
          room.place(sh, u, spot[0], spot[1]);
          best = c;
          break;
        }
        blocked.add(c.ri + "#" + c.k);
      }
      if (!best) return;
    }
  };

  /** Rebuild a room from an order of units; units that no longer fit go back to the pool. */
  const replay = (def: RoomDef, order: Unit[], pool: Map<string, Unit[]>) => {
    const r = new RoomState(def);
    for (const u of order) {
      const sh = shapes[u.itemId];
      const spot = r.findSpot(sh);
      if (spot) r.place(sh, u, spot[0], spot[1]);
      else {
        const k = poolKey(u.itemId, u.rare);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k)!.push(u);
      }
    }
    return r;
  };

  const clonePool = (p: Map<string, Unit[]>) => {
    const n = new Map<string, Unit[]>();
    p.forEach((v, k) => n.set(k, v.slice()));
    return n;
  };

  const allIdx = goals.map((_, i) => i);

  // ---- fresh greedy
  const fresh: Solution = { rooms: goals.map((g) => new RoomState(input.rooms[g.roomId])), pool: makePool(allUnits) };
  fill(fresh, allIdx, 0);
  let best = fresh;
  let bestScore = totalScore(fresh.rooms);

  // ---- warm start from previous layout
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
    fill(warm, allIdx, 0);
    const ws = totalScore(warm.rooms);
    if (ws >= bestScore - 1e-9) {
      best = warm;
      bestScore = ws;
    }
  }

  // ---- large neighbourhood search: ruin part of a room, refill everything
  let cur = best;
  let curScore = bestScore;
  let iterations = 0;
  if (goals.length && allUnits.length) {
    while (Date.now() - t0 < budget) {
      iterations++;
      const pool = clonePool(cur.pool);
      const ri = Math.floor(rnd() * goals.length);
      const room = cur.rooms[ri];
      const order = room.placed.map((p) => p.unit);
      const nRemove = Math.min(order.length, 1 + Math.floor(rnd() * 5));
      const kept = order.slice();
      for (let i = 0; i < nRemove && kept.length; i++) {
        const j = Math.floor(rnd() * kept.length);
        const [u] = kept.splice(j, 1);
        const k = poolKey(u.itemId, u.rare);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k)!.push(u);
      }
      // occasional shuffle of placement order changes the packing
      if (rnd() < 0.35 && kept.length > 1) {
        const a = Math.floor(rnd() * kept.length);
        const b = Math.floor(rnd() * kept.length);
        [kept[a], kept[b]] = [kept[b], kept[a]];
      }
      const rooms = cur.rooms.slice();
      rooms[ri] = replay(room.def, kept, pool);
      const cand: Solution = { rooms, pool };
      // only refill the touched room plus one random other room (cheaper, still lets items migrate)
      const others = allIdx.filter((i) => i !== ri);
      const touched = [ri];
      if (others.length) {
        const o = others[Math.floor(rnd() * others.length)];
        // other room must be cloned before mutation
        rooms[o] = replay(cur.rooms[o].def, cur.rooms[o].placed.map((p) => p.unit), pool);
        touched.push(o);
      }
      fill(cand, touched, 0.6);
      const sc = totalScore(cand.rooms);
      if (sc >= curScore - 1e-9 || rnd() < 0.02) {
        cur = cand;
        curScore = sc;
        if (sc > bestScore + 1e-9) {
          best = cand;
          bestScore = sc;
        }
      }
    }
  }

  // ---- final polish: a deterministic greedy pass on the best solution
  fill(best, allIdx, 0);
  bestScore = totalScore(best.rooms);

  return toResult(best, goals, shapes, input, bestScore, iterations, Date.now() - t0);
}

function toResult(
  sol: Solution,
  goals: RoomGoal[],
  shapes: Record<string, Shape>,
  input: OptimizeInput,
  score: number,
  iterations: number,
  ms: number,
): OptimizeResult {
  let houseAppeal = 0;
  const rooms: RoomResult[] = sol.rooms.map((r, i) => {
    const g = goals[i];
    houseAppeal += r.stats.a;
    const stats = { ...r.stats, c: r.stats.c - Math.max(0, g.cats - 4) };
    const notes: string[] = [];
    let goalMet = true;
    if (g.minComfort !== null && stats.c < g.minComfort) {
      goalMet = false;
      notes.push(`Comfort ${stats.c} is below ${g.minComfort}`);
    }
    if (g.maxComfort !== null && stats.c > g.maxComfort) {
      goalMet = false;
      notes.push(`Comfort ${stats.c} is above ${g.maxComfort}`);
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
    let useful = false;
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
  return { rooms, houseAppeal, leftovers, totalScore: score, iterations, ms };
}

export function toWarm(res: OptimizeResult): WarmStart {
  const w: WarmStart = {};
  for (const r of res.rooms) w[r.roomId] = r.placements.map((p) => [p.itemId, p.rare]);
  return w;
}
