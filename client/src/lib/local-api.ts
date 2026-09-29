/**
 * Static build (GitHub Pages) backend: the same routes the Express server exposes, served from
 * this browser's localStorage. Steam saves are read with sql.js (SQLite compiled to WebAssembly)
 * so nothing ever leaves the device.
 */
import { isSqliteFile, parseFurnitureBlob, summarizeFurniture, type SaveFurnitureRow } from "@shared/save-format";

export const IS_STATIC = import.meta.env.VITE_STATIC === "1";

const INV_KEY = "mewgenics-house-planner:inventory";
const SET_KEY = "mewgenics-house-planner:settings";

type Row = { itemId: string; count: number; rare: number };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
const writeJson = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

const listInventory = (): Row[] => readJson<Row[]>(INV_KEY, []);
const getSettings = (): Record<string, unknown> => readJson<Record<string, unknown>>(SET_KEY, {});

function upsert(rows: Row[], r: Row): Row[] {
  const rest = rows.filter((x) => x.itemId !== r.itemId);
  if (r.count + r.rare <= 0) return rest;
  return [...rest, { itemId: r.itemId, count: r.count, rare: r.rare }];
}

export function exportPayload() {
  return {
    app: "mewgenics-house-planner",
    version: 1,
    exportedAt: new Date().toISOString(),
    inventory: listInventory(),
    settings: getSettings(),
  };
}

async function readSave(file: Blob | ArrayBuffer) {
  const buf = new Uint8Array(file instanceof Blob ? await file.arrayBuffer() : file);
  if (buf.length < 100 || !isSqliteFile(buf.subarray(0, 16))) {
    throw new Error("That is not a Mewgenics save file (expected a SQLite database).");
  }
  const [{ default: initSqlJs }, wasm] = await Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")]);
  const SQL = await initSqlJs({ locateFile: () => wasm.default });
  const db = new SQL.Database(buf);
  try {
    const t = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='furniture'");
    if (!t.length || !t[0].values.length) throw new Error("This save has no furniture table. Is it a Mewgenics steamcampaign save?");
    const res = db.exec("SELECT key, data FROM furniture");
    const rows: SaveFurnitureRow[] = [];
    for (const [key, data] of res[0]?.values ?? []) {
      if (!(data instanceof Uint8Array)) continue;
      const parsed = parseFurnitureBlob(Number(key), data);
      if (parsed) rows.push(parsed);
    }
    return summarizeFurniture(rows, () => true);
  } finally {
    db.close();
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Handles one request the way server/routes.ts would. */
export async function localApi(method: string, url: string, body?: unknown): Promise<Response> {
  const path = url.replace(/\?.*$/, "");
  const m = method.toUpperCase();
  try {
    if (m === "GET" && path === "/api/state") return json({ inventory: listInventory(), settings: getSettings() });
    if (m === "GET" && path === "/api/export") return json(exportPayload());

    const one = /^\/api\/inventory\/([^/]+)$/.exec(path);
    if (m === "PUT" && one) {
      const b = (body ?? {}) as Partial<Row>;
      const row = { itemId: decodeURIComponent(one[1]), count: Number(b.count) || 0, rare: Number(b.rare) || 0 };
      writeJson(INV_KEY, upsert(listInventory(), row));
      return json({ row: row.count + row.rare > 0 ? row : null });
    }
    if (m === "POST" && path === "/api/inventory/bulk") {
      const b = (body ?? {}) as { replace?: boolean; items?: Row[] };
      let rows = b.replace ? [] : listInventory();
      for (const r of b.items ?? []) rows = upsert(rows, { itemId: r.itemId, count: Number(r.count) || 0, rare: Number(r.rare) || 0 });
      writeJson(INV_KEY, rows);
      return json({ inventory: rows });
    }
    const setting = /^\/api\/settings\/([a-z]+)$/.exec(path);
    if (m === "PUT" && setting) {
      const s = getSettings();
      s[setting[1]] = (body as { value?: unknown })?.value ?? null;
      writeJson(SET_KEY, s);
      return json({ ok: true });
    }
    if (m === "POST" && path === "/api/import/save") {
      if (!(body instanceof Blob) && !(body instanceof ArrayBuffer)) return json({ message: "Empty upload" }, 400);
      return json(await readSave(body));
    }
    return json({ message: `No local handler for ${m} ${path}` }, 404);
  } catch (e: any) {
    return json({ message: e?.message ?? "Local storage error" }, 400);
  }
}
