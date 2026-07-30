import { useSessionClient } from "@omp-remote/session-client";
import { Dashboard } from "@omp-remote/sessions/components";
import { useCallback, useState } from "react";
import { useSessionNotifications } from "./session-notifications.js";

function requestedSessionId(url: string | URL): string | null {
  return new URL(url).searchParams.get("session");
}

function withRequestedSession(url: string | URL, sessionId: string): URL {
  const updatedUrl = new URL(url);
  updatedUrl.searchParams.set("session", sessionId);
  return updatedUrl;
}

export default function App() {
  const client = useSessionClient();
  const notifications = useSessionNotifications(client.sessions);
  const [selectedSessionId, setSelectedSessionId] = useState(() => requestedSessionId(window.location.href));
  const onSelectedSessionChange = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    window.history.replaceState(
      window.history.state,
      "",
      withRequestedSession(window.location.href, sessionId),
    );
  }, []);

  return (
    <Dashboard
      sessions={client.sessions}
      askRequests={client.askRequests}
      sessionsReady={client.sessionsReady}
      historyLoading={client.historyLoading}
      hasMoreHistory={client.hasMoreHistory}
      connection={client.connection}
      error={client.error}
      notificationState={notifications.state}
      selectedSessionId={selectedSessionId}
      onSelectedSessionChange={onSelectedSessionChange}
      onEnableNotifications={notifications.enable}
      onLaunch={client.launch}
      onCommand={client.command}
      onAbort={client.abort}
      onKill={client.kill}
      onSetModel={client.setModel}
      onSetEffort={client.setEffort}
      onRespondToAsk={client.respondToAsk}
      onSearchHistory={client.searchHistory}
      onLoadMoreHistory={client.loadMoreHistory}
      onLoadTranscript={client.loadTranscript}
    />
  );
}
