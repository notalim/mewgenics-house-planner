import { optimize } from "./optimizer";
import { FURNITURE_BY_ID, ROOMS } from "./data";

self.onmessage = (e: MessageEvent) => {
  const { id, input } = e.data;
  try {
    const res = optimize({ ...input, items: FURNITURE_BY_ID, rooms: ROOMS });
    (self as any).postMessage({ id, res });
  } catch (err: any) {
    (self as any).postMessage({ id, error: String(err?.message ?? err) });
  }
};
