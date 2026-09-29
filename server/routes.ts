import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { insertInventorySchema, bulkInventorySchema } from "@shared/schema";
import * as z from "zod";
import express from "express";
import { readFurnitureRows, summarizeFurniture } from "./save-import";

const settingKeys = ["house", "goals", "layout", "prefs", "snapshots"] as const;

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/state", (_req, res) => {
    res.json({ inventory: storage.listInventory(), settings: storage.getAllSettings() });
  });

  app.put("/api/inventory/:itemId", (req, res) => {
    const parsed = insertInventorySchema.safeParse({ ...req.body, itemId: req.params.itemId });
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const row = storage.upsertItem(parsed.data);
    res.json({ row });
  });

  app.post("/api/inventory/bulk", (req, res) => {
    const parsed = bulkInventorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.json({ inventory: storage.bulk(parsed.data.items, parsed.data.replace) });
  });

  // Reads the furniture list out of an uploaded Steam save. Nothing is stored: the file is parsed and discarded,
  // and the browser decides whether to apply the result.
  app.post("/api/import/save", express.raw({ type: () => true, limit: "120mb" }), (req, res) => {
    try {
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ message: "Empty upload" });
      const rows = readFurnitureRows(body);
      res.json(summarizeFurniture(rows, () => true));
    } catch (e: any) {
      res.status(400).json({ message: e?.message ?? "Could not read that save file" });
    }
  });

  app.put("/api/settings/:key", (req, res) => {
    const key = z.enum(settingKeys).safeParse(req.params.key);
    if (!key.success) return res.status(400).json({ message: "unknown setting" });
    storage.setSetting(key.data, req.body?.value ?? null);
    res.json({ ok: true });
  });

  app.get("/api/export", (_req, res) => {
    const payload = {
      app: "mewgenics-house-planner",
      version: 1,
      exportedAt: new Date().toISOString(),
      inventory: storage.listInventory(),
      settings: storage.getAllSettings(),
    };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", 'attachment; filename="mewgenics-furniture.json"');
    res.send(JSON.stringify(payload, null, 2));
  });

  return httpServer;
}
