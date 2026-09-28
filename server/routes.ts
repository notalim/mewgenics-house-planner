import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { insertInventorySchema, bulkInventorySchema } from "@shared/schema";
import * as z from "zod";

const settingKeys = ["house", "goals", "layout", "prefs"] as const;

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
