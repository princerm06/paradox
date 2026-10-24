import { createContext, useContext, type ReactNode } from "react";

export type StudioMode = "explore" | "architect" | "analyze";

export type Navigation = {
  mode: StudioMode;
  go: (mode: StudioMode) => void;
  /** Select a future in Explore and open the inspector. Never activates. */
  inspectTimeline: (id: string) => void;
  inspectGeneration: (id: string) => void;
  /** Open Analyze with the given subject preselected as B (A stays as chosen). */
  compare: (subject: Subject) => void;
  /** Open Architect focused on the given subject's evidence. */
  architect: (subject: Subject) => void;
  pendingCompare: Subject | null;
  pendingArchitect: Subject | null;
};

/** A comparable/inspectable thing: a timeline or a generation attempt without a timeline. */
export type Subject = { kind: "timeline"; id: string } | { kind: "generation"; id: string };

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({ value, children }: { value: Navigation; children: ReactNode }) {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error("useNavigation must be used inside NavigationProvider");
  return value;
}
