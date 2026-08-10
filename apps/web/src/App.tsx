import { useSessionClient } from "@omp-remote/session-client";
import { Dashboard } from "@omp-remote/sessions/components";
import { useCallback, useState } from "react";
import { useSessionNotifications } from "./session-notifications.js";
import { StartupSplash } from "./startup-splash.js";

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
  const notifications = useSessionNotifications(client.sessions, client.askRequests);
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
    <>
      <Dashboard
        sessions={client.sessions}
        askRequests={client.askRequests}
        savedWorkingDirectories={client.savedWorkingDirectories}
        sessionsReady={client.sessionsReady}
        historyLoading={client.historyLoading}
        hasMoreHistory={client.hasMoreHistory}
        connection={client.connection}
        error={client.error}
        notificationState={notifications.state}
        notificationPreferences={notifications.preferences}
        notificationError={notifications.error}
        selectedSessionId={selectedSessionId}
        onSelectedSessionChange={onSelectedSessionChange}
        onToggleNotification={notifications.toggleEvent}
        onLaunch={client.launch}
        onSaveWorkingDirectory={client.saveWorkingDirectory}
        onRemoveWorkingDirectory={client.removeWorkingDirectory}
        onCommand={client.command}
        onAbort={client.abort}
        onKill={client.kill}
        onSetModel={client.setModel}
        onSetEffort={client.setEffort}
        onRespondToAsk={client.respondToAsk}
        onAskActivity={client.askActivity}
        onSearchHistory={client.searchHistory}
        onLoadMoreHistory={client.loadMoreHistory}
        onLoadTranscript={client.loadTranscript}
        onLoadCost={client.loadCost}
        onLoadSessionFileChanges={client.loadSessionFileChanges}
        onLoadSessionBranchTopology={client.loadSessionBranchTopology}
        onSwitchBranch={client.switchBranch}
      />
      <StartupSplash ready={client.sessionsReady || Boolean(client.error)} />
    </>
  );
}
