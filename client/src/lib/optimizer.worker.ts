import { optimize } from "./optimizer";
import { autoStrategy } from "./auto";
import { FURNITURE_BY_ID, ROOMS } from "./data";

self.onmessage = (e: MessageEvent) => {
  const { id, input, kind, roomIds, catsByRole } = e.data;
  try {
    const base = { ...input, items: FURNITURE_BY_ID, rooms: ROOMS };
    const res = kind === "auto" ? autoStrategy(base, roomIds, catsByRole) : optimize(base);
    (self as any).postMessage({ id, res });
  } catch (err: any) {
    (self as any).postMessage({ id, error: String(err?.message ?? err) });
  }
};
