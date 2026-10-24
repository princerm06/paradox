import { EngineProvider } from "./state/engine.tsx";
import { WorkspaceProvider } from "./state/workspace.tsx";
import { WorkspaceView } from "./views/WorkspaceView.tsx";

export default function App() {
  return (
    <EngineProvider>
      <WorkspaceProvider>
        <WorkspaceView />
      </WorkspaceProvider>
    </EngineProvider>
  );
}
