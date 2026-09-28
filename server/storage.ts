import { inventory, settings } from "@shared/schema";
import type { InventoryRow, InsertInventory } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS inventory (item_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, rare INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const db = drizzle(sqlite);

export interface IStorage {
  listInventory(): InventoryRow[];
  upsertItem(row: InsertInventory): InventoryRow | null;
  bulk(rows: InsertInventory[], replace: boolean): InventoryRow[];
  getSetting(key: string): unknown;
  getAllSettings(): Record<string, unknown>;
  setSetting(key: string, value: unknown): void;
}

export class DatabaseStorage implements IStorage {
  listInventory() {
    return db.select().from(inventory).all();
  }
  upsertItem(row: InsertInventory) {
    const count = row.count ?? 0;
    const rare = row.rare ?? 0;
    if (count + rare <= 0) {
      db.delete(inventory).where(eq(inventory.itemId, row.itemId)).run();
      return null;
    }
    return db
      .insert(inventory)
      .values({ itemId: row.itemId, count, rare })
      .onConflictDoUpdate({ target: inventory.itemId, set: { count, rare } })
      .returning()
      .get();
  }
  bulk(rows: InsertInventory[], replace: boolean) {
    const tx = sqlite.transaction(() => {
      if (replace) db.delete(inventory).run();
      for (const r of rows) this.upsertItem(r);
    });
    tx();
    return this.listInventory();
  }
  getSetting(key: string) {
    const r = db.select().from(settings).where(eq(settings.key, key)).get();
    return r ? JSON.parse(r.value) : null;
  }
  getAllSettings() {
    const out: Record<string, unknown> = {};
    for (const r of db.select().from(settings).all()) out[r.key] = JSON.parse(r.value);
    return out;
  }
  setSetting(key: string, value: unknown) {
    const v = JSON.stringify(value);
    db.insert(settings).values({ key, value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } }).run();
  }
}

export const storage = new DatabaseStorage();
