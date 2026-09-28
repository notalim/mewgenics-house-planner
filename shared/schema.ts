import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import * as z from "zod";

/** One row per furniture type the player owns. */
export const inventory = sqliteTable("inventory", {
  itemId: text("item_id").primaryKey(),
  count: integer("count").notNull().default(0),
  rare: integer("rare").notNull().default(0),
});

/** Key/value JSON settings: house stage, room goals, last layout. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const insertInventorySchema = createInsertSchema(inventory, {
  count: z.number().int().min(0).max(999),
  rare: z.number().int().min(0).max(999),
});
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type InventoryRow = typeof inventory.$inferSelect;

export const bulkInventorySchema = z.object({
  replace: z.boolean().default(false),
  items: z.array(insertInventorySchema),
});

export const insertSettingSchema = createInsertSchema(settings);
export type Setting = typeof settings.$inferSelect;
