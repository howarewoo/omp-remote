import { useSessionClient } from "@omp-remote/session-client";
import { Dashboard } from "@omp-remote/sessions/components";
import { useSessionNotifications } from "./session-notifications.js";

export default function App() {
  const client = useSessionClient();
  const notifications = useSessionNotifications(client.sessions);

  return (
    <Dashboard
      sessions={client.sessions}
      totalSessions={client.totalSessions}
      historyLoading={client.historyLoading}
      hasMoreHistory={client.hasMoreHistory}
      connection={client.connection}
      error={client.error}
      notificationState={notifications.state}
      onEnableNotifications={notifications.enable}
      onLaunch={client.launch}
      onCommand={client.command}
      onAbort={client.abort}
      onKill={client.kill}
      onSearchHistory={client.searchHistory}
      onLoadMoreHistory={client.loadMoreHistory}
      onLoadTranscript={client.loadTranscript}
    />
  );
}
