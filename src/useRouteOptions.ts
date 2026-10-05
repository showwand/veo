import { useEffect, useState } from "react";
import { fetchRouteOptions, type Point, type Route } from "./routing";

export type RouteStatus = "idle" | "loading" | "done" | "error";

// Remembers which start/end a result belongs to. routes === null means it failed.
type Result = { start: Point; end: Point; routes: Route[] | null };

// One shared empty list, so "no routes" is always the same object
const NO_ROUTES: Route[] = [];

export function useRouteOptions(
  start: Point | null,
  end: Point | null
): { routes: Route[]; status: RouteStatus } {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!start || !end) return;

    const controller = new AbortController();

    fetchRouteOptions(start, end, controller.signal)
      .then((routes) => setResult({ start, end, routes }))
      .catch((error) => {
        // A cancelled request is intentional, not an error
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResult({ start, end, routes: null });
      });

    // If start/end change before the answer arrives, cancel the old request
    return () => controller.abort();
  }, [start, end]);

  // Work out what to show from the current inputs
  if (!start || !end) return { routes: NO_ROUTES, status: "idle" };

  // We have no answer yet for THIS start and end, so we're still waiting
  if (!result || result.start !== start || result.end !== end) {
    return { routes: NO_ROUTES, status: "loading" };
  }

  if (result.routes === null) return { routes: NO_ROUTES, status: "error" };
  return { routes: result.routes, status: "done" };
}