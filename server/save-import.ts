import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSqliteFile, parseFurnitureBlob, type SaveFurnitureRow } from "@shared/save-format";

export { summarizeFurniture } from "@shared/save-format";

/** Opens an uploaded Mewgenics save (SQLite) and returns its furniture rows. Nothing is kept on disk. */
export function readFurnitureRows(buffer: Buffer): SaveFurnitureRow[] {
  if (buffer.length < 100 || !isSqliteFile(buffer.subarray(0, 16))) {
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
