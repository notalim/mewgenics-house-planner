/**
 * Mewgenics Steam save furniture format, shared by the server (better-sqlite3) and the static
 * build (sql.js in the browser).
 *
 * The save is a plain SQLite 3 database. Its `furniture` table has one row per piece:
 *   key INTEGER PRIMARY KEY, data BLOB (not compressed)
 * and each blob is laid out as
 *   [u32 header=1][u32 nameLen][u32 pad][ascii item id][u32 rarity: 2 = rare, 0 = normal][u32 unk]
 *   [u32 roomLen][u32 pad][ascii room, empty when the piece sits in storage]
 *   [i32 x][i32 y][u32 z][u32 flag1][u32 flag2]
 * Layout from the community save editors; the rarity marker was worked out by the Breeding Manager fork
 * (github.com/whyayala/MewgenicsBreedingManager, save_parser.py: value 2 lines up with can_be_rare items and
 * never appears on special_* pieces, which cannot be rare).
 */
export type SaveFurnitureRow = {
  key: number;
  itemId: string;
  room: string;
  rare: boolean;
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
  rareCount: number;
  tailValues: Record<string, number>;
};

const ascii = (b: Uint8Array, s: number, e: number) => {
  let out = "";
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
};

export function isSqliteFile(head: Uint8Array): boolean {
  return head.length >= 15 && ascii(head, 0, 15) === "SQLite format 3";
}

export function parseFurnitureBlob(key: number, blob: Uint8Array): SaveFurnitureRow | null {
  if (blob.length < 4 + 8 + 8 + 8) return null;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let off = 4;
  const nameLen = dv.getUint32(off, true);
  off += 8;
  if (nameLen > 256 || off + nameLen > blob.length) return null;
  const itemId = ascii(blob, off, off + nameLen);
  off += nameLen;
  const rare = dv.getUint32(off, true) === 2;
  off += 8;
  if (off + 8 > blob.length) return null;
  const roomLen = dv.getUint32(off, true);
  off += 8;
  if (roomLen > 256 || off + roomLen > blob.length) return null;
  const room = ascii(blob, off, off + roomLen);
  off += roomLen;
  const tail: number[] = [];
  while (off + 4 <= blob.length) {
    tail.push(dv.getInt32(off, true));
    off += 4;
  }
  return { key, itemId, room, rare, x: tail[0] ?? 0, y: tail[1] ?? 0, tail };
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

export function summarizeFurniture(rows: SaveFurnitureRow[], known: (id: string) => boolean): SaveImportResult {
  const counts = new Map<string, number>();
  const rares = new Map<string, number>();
  const unknown = new Map<string, number>();
  let rareCount = 0;
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
    if (!known(base)) unknown.set(base, (unknown.get(base) ?? 0) + 1);
    else if (r.rare) {
      rares.set(base, (rares.get(base) ?? 0) + 1);
      rareCount++;
    } else counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const ids = new Set([...Array.from(counts.keys()), ...Array.from(rares.keys())]);
  return {
    items: Array.from(ids)
      .map((itemId) => ({ itemId, count: counts.get(itemId) ?? 0, rare: rares.get(itemId) ?? 0 }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId)),
    rareCount,
    unknown: Array.from(unknown).map(([itemId, count]) => ({ itemId, count })).sort((a, b) => b.count - a.count),
    pieces: rows.length,
    placed,
    stored,
    rooms,
    plusMerged,
    tailValues,
  };
}
