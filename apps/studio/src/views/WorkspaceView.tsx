import { TimelineExplorer } from "../graph/TimelineExplorer.tsx";
import { FutureInspector } from "../inspector/FutureInspector.tsx";
import { LiveWorkspace } from "../preview/LiveWorkspace.tsx";

export function WorkspaceView() {
  return (
    <div className="shell">
      <TimelineExplorer />
      <LiveWorkspace />
      <FutureInspector />
    </div>
  );
}
