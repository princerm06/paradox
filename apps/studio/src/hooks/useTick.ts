import { useEffect, useState } from "react";

/** Counter that increments every `ms` milliseconds; `0` pauses it. */
export function useTick(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ms) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return tick;
}
