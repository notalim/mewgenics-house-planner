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
}

export const PRESETS: Preset[] = [
  { id: "breeding", label: "Breeding: Stimulation", hint: "Better stat and ability inheritance. Keeps Comfort positive so cats still breed.", primary: "s", weights: { s: 1, c: 0.1 }, target: 95, minComfort: 1, maxComfort: null },
  { id: "health", label: "Recovery: Health", hint: "Heals injuries and diseases overnight.", primary: "h", weights: { h: 1, c: 0.1 }, target: null, minComfort: 1, maxComfort: null },
  { id: "mutation", label: "Lab: Mutation", hint: "Raises mutation chance in kittens.", primary: "m", weights: { m: 1, c: 0.1 }, target: null, minComfort: 1, maxComfort: null },
  { id: "comfort", label: "Nursery: Comfort", hint: "More breeding, bigger litters, fewer fights.", primary: "c", weights: { c: 1 }, target: null, minComfort: null, maxComfort: null },
  { id: "fight", label: "Fight club: Comfort ≤ 0", hint: "Cats fight at zero Comfort. Good place for Comfort-negative pieces.", primary: null, weights: { s: 0.05, m: 0.05, h: 0.05 }, target: null, minComfort: null, maxComfort: 0 },
  { id: "appeal", label: "Storage: Appeal only", hint: "Appeal is house-wide, so any room can hold Appeal pieces.", primary: "a", weights: {}, target: null, minComfort: null, maxComfort: null },
];

export const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

export function goalFromPreset(roomId: string, presetId: string, cats = 2): RoomGoal {
  const p = PRESET_BY_ID[presetId] ?? PRESETS[0];
  return {
    roomId,
    preset: p.id,
    weights: { ...p.weights },
    target: p.primary && p.target !== null && p.primary !== "a" ? { stat: p.primary, value: p.target } : null,
    minComfort: p.minComfort,
    maxComfort: p.maxComfort,
    cats,
  };
}

export const DEFAULT_ROOM_PRESET: Record<string, string> = {
  Floor1_Large: "breeding",
  Floor1_Small: "health",
  LargeAttic: "mutation",
  SmallAttic: "mutation",
  Floor2_Small: "comfort",
  Floor2_Large: "comfort",
  Basement0: "appeal",
  Basement1: "appeal",
  Basement2: "appeal",
  Basement3: "appeal",
  Basement4: "appeal",
};

export const STIM_BREAKPOINTS = [
  { value: 32, label: "32: first active ability always passes down" },
  { value: 95, label: "95: passive always passes down" },
  { value: 196, label: "196: second active always passes down" },
];
