import { useEffect, useRef, useState } from "react";
import { optimize, type OptimizeInput, type OptimizeResult } from "./optimizer";
import { FURNITURE_BY_ID, ROOMS } from "./data";

type Req = Omit<OptimizeInput, "items" | "rooms">;

/** Runs the optimizer in a Web Worker when available, otherwise on the main thread. */
export function useOptimizer(req: Req | null, deps: unknown[]) {
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const workerOk = useRef(true);
  const answered = useRef(new Set<number>());

  useEffect(() => {
    try {
      const w = new Worker(new URL("./optimizer.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        answered.current.add(e.data.id);
        if (e.data.id !== reqId.current) return;
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
    return () => workerRef.current?.terminate();
  }, []);

  useEffect(() => {
    if (!req) return;
    const id = ++reqId.current;
    setRunning(true);
    const runMain = () => {
      try {
        const res = optimize({ ...req, items: FURNITURE_BY_ID, rooms: ROOMS, timeBudgetMs: Math.min(req.timeBudgetMs ?? 600, 600) });
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
        workerRef.current.postMessage({ id, input: req });
        // if the worker never answers (some sandboxes block workers), fall back to the main thread
        watchdog = setTimeout(() => {
          if (reqId.current === id && !answered.current.has(id)) {
            workerOk.current = false;
            runMain();
          }
        }, (req.timeBudgetMs ?? 900) + 4000);
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
