import { optimize } from "./optimizer";
import { autoStrategy } from "./auto";
import { FURNITURE_BY_ID, ROOMS } from "./data";

self.onmessage = (e: MessageEvent) => {
  const { id, input, kind, roomIds, catsByRole } = e.data;
  try {
    const base = { ...input, items: FURNITURE_BY_ID, rooms: ROOMS };
    if (kind === "auto") {
      (self as any).postMessage({ id, res: autoStrategy(base, roomIds, catsByRole) });
      return;
    }
    const res = optimize({
      ...base,
      onProgress: (partial) => (self as any).postMessage({ id, partial }),
      progressEvery: 150,
    });
    (self as any).postMessage({ id, res });
  } catch (err: any) {
    (self as any).postMessage({ id, error: String(err?.message ?? err) });
  }
};
