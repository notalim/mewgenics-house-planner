import { optimize, type OptimizeInput, type RoomGoal } from "./optimizer";
import { goalFromPreset, rolesFor } from "./presets";

export interface AutoCandidate {
  goals: RoomGoal[];
  score: number;
}
export interface AutoResult {
  best: RoomGoal[];
  candidates: AutoCandidate[];
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  const seen = new Set<string>();
  arr.forEach((x, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) {
      const p = [x, ...rest];
      const k = JSON.stringify(p);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(p);
      }
    }
  });
  return out;
}

/**
 * Tries every way of handing the standard roles (elite breeding, feeder nursery, holding, ...) to the
 * unlocked rooms, runs a short optimization for each, and keeps the assignment with the best total score.
 * All candidates share the same set of goals, so their scores are directly comparable.
 */
export function autoStrategy(
  input: Omit<OptimizeInput, "goals" | "warm">,
  roomIds: string[],
  catsByRole: Record<string, number> = {},
): AutoResult {
  const roles = rolesFor(roomIds.length);
  let perms = permutations(roles);
  if (perms.length > 24) {
    // too many rooms to try all: biggest rooms get the most furniture-hungry roles
    const bySize = [...roomIds].sort((a, b) => input.rooms[b].free - input.rooms[a].free);
    const hungry = ["nursery", "breeding", "holding", "mutation", "health", "comfort", "appeal"];
    const sortedRoles = [...roles].sort((a, b) => hungry.indexOf(a) - hungry.indexOf(b));
    const assign: Record<string, string> = {};
    bySize.forEach((r, i) => (assign[r] = sortedRoles[i]));
    perms = [roomIds.map((r) => assign[r])];
  }
  const each = Math.max(150, Math.min(600, Math.floor(2400 / perms.length)));
  const candidates: AutoCandidate[] = perms.map((p, i) => {
    const goals = roomIds.map((r, j) => goalFromPreset(r, p[j], catsByRole[p[j]]));
    const res = optimize({ ...input, goals, warm: null, effort: each, seed: 7 + i });
    return { goals, score: res.totalScore };
  });
  candidates.sort((a, b) => b.score - a.score);
  return { best: candidates[0].goals, candidates };
}
