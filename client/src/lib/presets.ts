import type { RoomGoal } from "./optimizer";
import type { StatKey } from "./data";

export interface Preset {
  id: string;
  label: string;
  hint: string;
  primary: StatKey | null;
  weights: Partial<Record<StatKey, number>>;
  target: number | null;
  minComfort: number | null;
  maxComfort: number | null;
  mins?: Partial<Record<StatKey, number>>;
  cats: number;
}

/**
 * Mechanics these presets are built on (mewgenicswiki.org house furniture + breeding guides):
 * - Comfort: each cat past 4 costs 1. At 0 or below cats fight instead of breeding.
 * - Stimulation: better-parent stat chance = (1 + s/100) / (2 + s/100). 32 guarantees the first active, 95 the passive.
 * - Health 10+ cures disorders over time. Mutation above 10 unlocks full mutations (+2.5% per point).
 * - Appeal is house-wide, so it never needs its own room.
 */
export const PRESETS: Preset[] = [
  {
    id: "breeding",
    label: "Elite breeding: Stimulation",
    hint: "Your 7s pairs. Max Stimulation, Comfort kept just above 0 so they breed instead of fight. Keep it to 2 to 4 cats.",
    primary: "s",
    weights: { s: 1, c: 0.15 },
    target: 95,
    minComfort: 2,
    maxComfort: null,
    cats: 4,
  },
  {
    id: "nursery",
    label: "Feeder nursery: Mutation + Health",
    hint: "The big room of good-not-great cats. Health 10+ and Mutation 10+ first, then Mutation, with enough Comfort to cover the crowd.",
    primary: "m",
    weights: { m: 1, s: 0.35, h: 0.2, c: 0.15 },
    target: null,
    minComfort: 1,
    maxComfort: null,
    mins: { h: 10, m: 10 },
    cats: 12,
  },
  {
    id: "holding",
    label: "Holding: Health + Comfort",
    hint: "Adventure squad and retirees. Health 10+ to clear disorders, Comfort above 0 so nobody fights. Appeal pieces live well here.",
    primary: "h",
    weights: { h: 0.6, c: 0.4, s: 0.05 },
    target: null,
    minComfort: 1,
    maxComfort: null,
    mins: { h: 10 },
    cats: 4,
  },
  { id: "health", label: "Recovery: Health", hint: "Heals injuries and disorders overnight. 10+ cures disorders.", primary: "h", weights: { h: 1, c: 0.1 }, target: null, minComfort: 1, maxComfort: null, cats: 4 },
  { id: "mutation", label: "Lab: Mutation", hint: "Only Mutation above 10 rolls full mutations. It no longer removes birth defects (v1.1).", primary: "m", weights: { m: 1, c: 0.1 }, target: null, minComfort: 1, maxComfort: null, cats: 4 },
  { id: "comfort", label: "Comfort: breed often", hint: "More overnight breeding, fewer fights.", primary: "c", weights: { c: 1 }, target: null, minComfort: null, maxComfort: null, cats: 4 },
  { id: "fight", label: "Fight club: Comfort ≤ 0", hint: "At 0 Comfort cats fight between runs and the winner gains a stat. Risky: injuries.", primary: null, weights: { s: 0.05, m: 0.05, h: 0.05 }, target: null, minComfort: null, maxComfort: 0, cats: 4 },
  { id: "appeal", label: "Storage: Appeal only", hint: "Appeal counts from any room, so this mostly wastes a room. Use only for spare space.", primary: "a", weights: {}, target: null, minComfort: null, maxComfort: null, cats: 0 },
];

export const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

export function goalFromPreset(roomId: string, presetId: string, cats?: number): RoomGoal {
  const p = PRESET_BY_ID[presetId] ?? PRESETS[0];
  return {
    roomId,
    preset: p.id,
    weights: { ...p.weights },
    target: p.primary && p.target !== null && p.primary !== "a" ? { stat: p.primary, value: p.target } : null,
    minComfort: p.minComfort,
    maxComfort: p.maxComfort,
    mins: p.mins ? { ...p.mins } : undefined,
    cats: cats ?? p.cats,
  };
}

export const DEFAULT_ROOM_PRESET: Record<string, string> = {
  Floor1_Large: "breeding",
  Floor1_Small: "holding",
  LargeAttic: "nursery",
  SmallAttic: "nursery",
  Floor2_Small: "health",
  Floor2_Large: "breeding",
  Basement0: "mutation",
  Basement1: "comfort",
  Basement2: "holding",
  Basement3: "appeal",
  Basement4: "appeal",
};

/** Roles to hand out for a given number of rooms, most important first. */
export function rolesFor(n: number): string[] {
  const order = ["breeding", "nursery", "holding", "breeding", "mutation", "health", "comfort", "holding", "appeal", "appeal", "appeal"];
  return order.slice(0, n);
}

export const STIM_BREAKPOINTS = [
  { value: 32, label: "32: first active ability always passes down" },
  { value: 95, label: "95: passive always passes down" },
  { value: 196, label: "196: second active always passes down" },
];
