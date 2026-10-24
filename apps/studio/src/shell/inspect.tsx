import { createContext, useContext, type ReactNode } from "react";

const InspectContext = createContext<() => void>(() => {});

export function InspectProvider({ ask, children }: { ask: () => void; children: ReactNode }) {
  return <InspectContext.Provider value={ask}>{children}</InspectContext.Provider>;
}

export function useAskInspect(): () => void {
  return useContext(InspectContext);
}
