import { useSessionClient } from "@omp-remote/session-client";
import { Dashboard } from "@omp-remote/sessions/components";

export default function App() {
  const client = useSessionClient();

  return (
    <Dashboard
      sessions={client.sessions}
      totalSessions={client.totalSessions}
      historyLoading={client.historyLoading}
      hasMoreHistory={client.hasMoreHistory}
      connection={client.connection}
      error={client.error}
      onLaunch={client.launch}
      onCommand={client.command}
      onAbort={client.abort}
      onSearchHistory={client.searchHistory}
      onLoadMoreHistory={client.loadMoreHistory}
      onLoadTranscript={client.loadTranscript}
    />
  );
}
