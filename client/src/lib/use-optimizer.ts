import { useEffect, useRef, useState } from "react";
import { optimize, type OptimizeInput, type OptimizeResult } from "./optimizer";
import { FURNITURE_BY_ID, ROOMS } from "./data";
import { autoStrategy, type AutoResult } from "./auto";

type Req = Omit<OptimizeInput, "items" | "rooms" | "onProgress" | "progressEvery">;

/** Search effort levels (LNS iterations). Deterministic, so the same effort gives the same layout everywhere. */
export const EFFORTS = [
  { id: "quick", label: "Quick", effort: 500, hint: "about 1 second" },
  { id: "normal", label: "Thorough", effort: 1500, hint: "a few seconds" },
  { id: "deep", label: "Deep", effort: 5000, hint: "10 to 20 seconds" },
  { id: "max", label: "Exhaustive", effort: 15000, hint: "up to a minute" },
] as const;
export type EffortId = (typeof EFFORTS)[number]["id"];
export const effortFor = (id: string) => EFFORTS.find((e) => e.id === id)?.effort ?? 1500;

/** Runs the optimizer in a Web Worker when available, otherwise on the main thread. Streams progress. */
export function useOptimizer(req: Req | null, deps: unknown[]) {
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const workerOk = useRef(true);
  const answered = useRef(new Set<number>());
  const busy = useRef(false);

  const spawn = () => {
    try {
      const w = new Worker(new URL("./optimizer.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        if (e.data.id !== reqId.current) return;
        if (e.data.partial) {
          answered.current.add(e.data.id);
          setResult(e.data.partial);
          return;
        }
        answered.current.add(e.data.id);
        busy.current = false;
        setRunning(false);
        if (e.data.error) setError(e.data.error);
        else {
          setError(null);
          setResult(e.data.res);
        }
      };
      w.onerror = () => {
        workerOk.current = false;
      };
      workerRef.current = w;
    } catch {
      workerOk.current = false;
    }
  };

  useEffect(() => {
    spawn();
    return () => workerRef.current?.terminate();
  }, []);

  useEffect(() => {
    if (!req) return;
    const id = ++reqId.current;
    setRunning(true);
    const runMain = () => {
      try {
        const res = optimize({ ...req, items: FURNITURE_BY_ID, rooms: ROOMS, effort: Math.min(req.effort ?? 1500, 1500) });
        if (reqId.current === id) {
          setError(null);
          setResult(res);
          setRunning(false);
        }
      } catch (err: any) {
        setError(String(err?.message ?? err));
        setRunning(false);
      }
    };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const t = setTimeout(() => {
      if (workerRef.current && workerOk.current) {
        // a request is superseded: kill the busy worker so the new one starts at once
        if (busy.current) {
          workerRef.current.terminate();
          spawn();
        }
        busy.current = true;
        workerRef.current!.postMessage({ id, input: req });
        // if the worker never answers (some sandboxes block workers), fall back to the main thread
        watchdog = setTimeout(() => {
          if (reqId.current === id && !answered.current.has(id)) {
            workerOk.current = false;
            runMain();
          }
        }, 5000);
      } else runMain();
    }, 250);
    return () => {
      clearTimeout(t);
      if (watchdog) clearTimeout(watchdog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { result, running, error };
}

/** One-off auto strategy search in its own worker (falls back to the main thread). */
export function runAutoStrategy(
  input: { owned: OptimizeInput["owned"]; appealWeight: number },
  roomIds: string[],
  catsByRole: Record<string, number>,
): Promise<AutoResult> {
  const main = () => autoStrategy({ ...input, items: FURNITURE_BY_ID, rooms: ROOMS }, roomIds, catsByRole);
  return new Promise((resolve, reject) => {
    let w: Worker | null = null;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      w?.terminate();
      fn();
    };
    const fallback = () => finish(() => {
      try {
        resolve(main());
      } catch (e) {
        reject(e);
      }
    });
    try {
      w = new Worker(new URL("./optimizer.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => finish(() => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.res)));
      w.onerror = fallback;
      w.postMessage({ id: 1, kind: "auto", input, roomIds, catsByRole });
      setTimeout(fallback, 12000);
    } catch {
      fallback();
    }
  });
}
