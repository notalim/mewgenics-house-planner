import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Reads the furniture list out of a Mewgenics Steam save (steamcampaign01.sav).
 *
 * The save is a plain SQLite 3 database. Its `furniture` table has one row per piece:
 *   key INTEGER PRIMARY KEY, data BLOB (not compressed)
 * and each blob is laid out as
 *   [u32 header=1][u32 nameLen][u32 pad][ascii item id][u64 unk]
 *   [u32 roomLen][u32 pad][ascii room, empty when the piece sits in storage]
 *   [i32 x][i32 y][u32 z][u32 flag1][u32 flag2]
 * (format documented by the community save editors; see README).
 */
export type SaveFurnitureRow = {
  key: number;
  itemId: string;
  room: string;
  x: number;
  y: number;
  tail: number[];
};

export type SaveImportResult = {
  items: Array<{ itemId: string; count: number; rare: number }>;
  unknown: Array<{ itemId: string; count: number }>;
  pieces: number;
  placed: number;
  stored: number;
  rooms: Record<string, number>;
  plusMerged: number;
  tailValues: Record<string, number>;
};

export function parseFurnitureBlob(key: number, blob: Buffer): SaveFurnitureRow | null {
  if (blob.length < 4 + 8 + 8 + 8) return null;
  let off = 4;
  const nameLen = blob.readUInt32LE(off);
  off += 8;
  if (nameLen > 256 || off + nameLen > blob.length) return null;
  const itemId = blob.toString("latin1", off, off + nameLen);
  off += nameLen;
  off += 8; // u64 unknown
  if (off + 8 > blob.length) return null;
  const roomLen = blob.readUInt32LE(off);
  off += 8;
  if (roomLen > 256 || off + roomLen > blob.length) return null;
  const room = blob.toString("latin1", off, off + roomLen);
  off += roomLen;
  const tail: number[] = [];
  while (off + 4 <= blob.length) {
    tail.push(blob.readInt32LE(off));
    off += 4;
  }
  return { key, itemId, room, x: tail[0] ?? 0, y: tail[1] ?? 0, tail };
}

/** "set_monster_shelf_plus2" (from the FurnitureUpgrade mod) -> base id "set_monster_shelf". */
export function stripPlusSuffix(id: string): { base: string; plus: number } {
  let base = id;
  let plus = 0;
  for (;;) {
    const m = /_plus(\d+)$/.exec(base);
    if (!m || m.index === 0) break;
    plus += Number(m[1]);
    base = base.slice(0, m.index);
  }
  return { base, plus };
}

export function readFurnitureRows(buffer: Buffer): SaveFurnitureRow[] {
  if (buffer.length < 100 || buffer.toString("latin1", 0, 15) !== "SQLite format 3") {
    throw new Error("That is not a Mewgenics save file (expected a SQLite database).");
  }
  const dir = mkdtempSync(join(tmpdir(), "mew-sav-"));
  const file = join(dir, "save.sav");
  writeFileSync(file, buffer);
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='furniture'")
      .get() as { name: string } | undefined;
    if (!table) throw new Error("This save has no furniture table. Is it a Mewgenics steamcampaign save?");
    const rows = db.prepare("SELECT key, data FROM furniture").all() as Array<{ key: number; data: Buffer }>;
    const out: SaveFurnitureRow[] = [];
    for (const r of rows) {
      if (!Buffer.isBuffer(r.data)) continue;
      const parsed = parseFurnitureBlob(Number(r.key), r.data);
      if (parsed) out.push(parsed);
    }
    return out;
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function summarizeFurniture(rows: SaveFurnitureRow[], known: (id: string) => boolean): SaveImportResult {
  const counts = new Map<string, number>();
  const unknown = new Map<string, number>();
  const rooms: Record<string, number> = {};
  const tailValues: Record<string, number> = {};
  let placed = 0;
  let stored = 0;
  let plusMerged = 0;
  for (const r of rows) {
    const { base, plus } = stripPlusSuffix(r.itemId.toLowerCase());
    if (plus > 0) plusMerged++;
    if (r.room) {
      placed++;
      rooms[r.room] = (rooms[r.room] ?? 0) + 1;
    } else stored++;
    const tk = r.tail.slice(2).join(",");
    tailValues[tk] = (tailValues[tk] ?? 0) + 1;
    if (known(base)) counts.set(base, (counts.get(base) ?? 0) + 1);
    else unknown.set(base, (unknown.get(base) ?? 0) + 1);
  }
  return {
    items: Array.from(counts).map(([itemId, count]) => ({ itemId, count, rare: 0 })).sort((a, b) => a.itemId.localeCompare(b.itemId)),
    unknown: Array.from(unknown).map(([itemId, count]) => ({ itemId, count })).sort((a, b) => b.count - a.count),
    pieces: rows.length,
    placed,
    stored,
    rooms,
    plusMerged,
    tailValues,
  };
}
