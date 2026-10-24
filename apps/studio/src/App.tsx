import { WorkspaceProvider } from "./state/workspace.tsx";
import { WorkspaceView } from "./views/WorkspaceView.tsx";

export default function App() {
  return (
    <WorkspaceProvider>
      <WorkspaceView />
    </WorkspaceProvider>
  );
}
