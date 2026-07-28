import { useSessionClient } from "@omp-remote/session-client";
import { Dashboard } from "@omp-remote/sessions/components";

export default function App() {
  const client = useSessionClient();

  return (
    <Dashboard
      sessions={client.sessions}
      connection={client.connection}
      error={client.error}
      onLaunch={client.launch}
      onCommand={client.command}
      onAbort={client.abort}
    />
  );
}
