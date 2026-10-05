import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { IS_STATIC, localApi } from "./local-api";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  if (IS_STATIC) {
    const res = await localApi(method, url, data);
    await throwIfResNotOk(res);
    return res;
  }
  const binary = data instanceof Blob || data instanceof ArrayBuffer;
  // The published backend pauses when idle and takes a few seconds to wake, so the first request after a
  // quiet spell can fail or 502. Retry network errors and 5xx with backoff instead of surfacing them.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await sleep(Math.min(1000 * 2 ** (attempt - 1), 5000));
    try {
      const res = await fetch(`${API_BASE}${url}`, {
        method,
        headers: binary ? { "Content-Type": "application/octet-stream" } : data ? { "Content-Type": "application/json" } : {},
        body: binary ? (data as Blob | ArrayBuffer) : data ? JSON.stringify(data) : undefined,
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
        continue;
      }
      await throwIfResNotOk(res);
      return res;
    } catch (e) {
      if (e instanceof TypeError) {
        lastErr = e; // network failure while the server wakes up
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Could not reach the server");
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = IS_STATIC ? await localApi("GET", queryKey.join("/")) : await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      // ~40 s of retries so a paused backend has time to resume before we show an error
      retry: 10,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    },
    mutations: {
      retry: false,
    },
  },
});
