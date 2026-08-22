import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardIcon } from "./dashboard/icon.js";
import type {
  ApplicationErrorRecord,
  ApplicationErrorSeverity,
  ApplicationErrorSource,
  ApplicationErrorStorageHealth,
} from "./dashboard-props.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.js";
import { Dialog } from "./ui/dialog.js";
import { SidebarTrigger } from "./ui/sidebar.js";
import { ThemeToggle } from "./ui/theme-provider.js";
import { cn } from "./ui/utils.js";

export interface ApplicationErrorViewerProps {
  errors?: readonly ApplicationErrorRecord[];
  health?: ApplicationErrorStorageHealth | null;
  loading?: boolean;
  error?: string | null;
  onClearErrors?(): Promise<void>;
  onReloadErrors?(): Promise<void>;
  onBackToSessions?(): void;
  className?: string;
}

export function formatErrorTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ApplicationErrorViewer({
  errors = [],
  health = null,
  loading = false,
  error = null,
  onClearErrors,
  onReloadErrors,
  onBackToSessions,
  className,
}: ApplicationErrorViewerProps) {
  const [sourceFilter, setSourceFilter] = useState<"all" | ApplicationErrorSource>("all");
  const [severityFilter, setSeverityFilter] = useState<"all" | ApplicationErrorSeverity>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const sortedErrors = useMemo(() => {
    return [...errors].sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return (Number.isNaN(timeB) ? 0 : timeB) - (Number.isNaN(timeA) ? 0 : timeA);
    });
  }, [errors]);

  const filteredErrors = useMemo(() => {
    return sortedErrors.filter((record) => {
      if (sourceFilter !== "all" && record.source !== sourceFilter) return false;
      if (severityFilter !== "all" && record.severity !== severityFilter) return false;
      return true;
    });
  }, [sortedErrors, sourceFilter, severityFilter]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleConfirmClear = useCallback(async () => {
    if (!onClearErrors || clearPending) return;
    setClearPending(true);
    setClearError(null);
    try {
      await onClearErrors();
      setClearDialogOpen(false);
      toast.success("Application errors cleared");
    } catch (failure) {
      setClearError(failure instanceof Error ? failure.message : "Failed to clear application errors");
    } finally {
      setClearPending(false);
    }
  }, [clearPending, onClearErrors]);

  const isDegraded = health?.status === "degraded";
  const hasActiveFilters = sourceFilter !== "all" || severityFilter !== "all";

  return (
    <div className={cn("app-errors-workspace", className)} aria-label="Application error ledger">
      <header className="session-header app-errors-header">
        <div className="session-header-primary">
          <SidebarTrigger />
          <div>
            <h1>Application errors</h1>
            <p className="app-errors-subtitle">
              {errors.length === 1 ? "1 error recorded" : `${errors.length} errors recorded`}
              {health ? ` (${formatBytes(health.totalBytes)})` : ""}
              {isDegraded ? " • Degraded mode" : ""}
            </p>
          </div>
          {isDegraded ? (
            <Badge className="status-badge status-waiting">
              <span aria-hidden="true" />
              Degraded
            </Badge>
          ) : null}
        </div>
        <div className="session-header-actions">
          <ThemeToggle />
          {onReloadErrors ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Reload application errors"
              title="Reload application errors"
              disabled={loading}
              onClick={() => void onReloadErrors().catch(() => undefined)}
            >
              <DashboardIcon name="refresh" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="app-errors-clear-button"
            aria-label="Clear all application errors"
            title="Clear all application errors"
            disabled={errors.length === 0 || loading}
            onClick={() => {
              setClearError(null);
              setClearDialogOpen(true);
            }}
          >
            <DashboardIcon name="trash" />
            <span>Clear all</span>
          </Button>
          {onBackToSessions ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="app-errors-back-button"
              aria-label="Back to sessions"
              title="Back to sessions"
              onClick={onBackToSessions}
            >
              <DashboardIcon name="arrow-left" />
              <span>Back to sessions</span>
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="system-alert app-errors-alert" role="alert">
          <strong>Could not load application errors.</strong>
          <span>{error}</span>
          {onReloadErrors ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onReloadErrors().catch(() => undefined)}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {isDegraded ? (
        <div className="app-errors-degraded-banner" role="status">
          <DashboardIcon name="alert" />
          <div>
            <strong>Storage degraded</strong>
            <p>{health.degradedReason ?? "Application error ledger is running in degraded mode."}</p>
          </div>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="app-error-filters" role="toolbar" aria-label="Filter application errors">
          <div className="app-error-filter-group" role="group" aria-label="Filter by source">
            <span className="app-error-filter-label">Source:</span>
            <div className="app-error-filter-buttons">
              <Button
                type="button"
                size="sm"
                variant={sourceFilter === "all" ? "default" : "outline"}
                aria-pressed={sourceFilter === "all"}
                onClick={() => setSourceFilter("all")}
              >
                All
              </Button>
              <Button
                type="button"
                size="sm"
                variant={sourceFilter === "daemon" ? "default" : "outline"}
                aria-pressed={sourceFilter === "daemon"}
                onClick={() => setSourceFilter("daemon")}
              >
                Daemon
              </Button>
              <Button
                type="button"
                size="sm"
                variant={sourceFilter === "browser" ? "default" : "outline"}
                aria-pressed={sourceFilter === "browser"}
                onClick={() => setSourceFilter("browser")}
              >
                Browser
              </Button>
            </div>
          </div>

          <div className="app-error-filter-group" role="group" aria-label="Filter by severity">
            <span className="app-error-filter-label">Severity:</span>
            <div className="app-error-filter-buttons">
              <Button
                type="button"
                size="sm"
                variant={severityFilter === "all" ? "default" : "outline"}
                aria-pressed={severityFilter === "all"}
                onClick={() => setSeverityFilter("all")}
              >
                All
              </Button>
              <Button
                type="button"
                size="sm"
                variant={severityFilter === "fatal" ? "default" : "outline"}
                aria-pressed={severityFilter === "fatal"}
                onClick={() => setSeverityFilter("fatal")}
              >
                Fatal
              </Button>
              <Button
                type="button"
                size="sm"
                variant={severityFilter === "error" ? "default" : "outline"}
                aria-pressed={severityFilter === "error"}
                onClick={() => setSeverityFilter("error")}
              >
                Error
              </Button>
            </div>
          </div>

          {hasActiveFilters ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="app-error-filter-reset"
              onClick={() => {
                setSourceFilter("all");
                setSeverityFilter("all");
              }}
            >
              Reset filters
            </Button>
          ) : null}
        </div>
      ) : null}

      {error && errors.length === 0 ? null : loading && errors.length === 0 ? (
        <div className="app-errors-empty" role="status" aria-busy="true">
          <span className="status-orbit" aria-hidden="true" />
          <strong>Loading application errors…</strong>
          <p>Reading recorded errors from host ledger.</p>
        </div>
      ) : errors.length === 0 ? (
        <div className="app-errors-empty" role="status">
          <DashboardIcon name="check" />
          <strong>No application errors</strong>
          <p>No daemon or browser errors have been recorded.</p>
        </div>
      ) : filteredErrors.length === 0 ? (
        <div className="app-errors-empty" role="status">
          <DashboardIcon name="search" />
          <strong>No matching errors</strong>
          <p>
            No recorded errors match the selected source ({sourceFilter}) and severity ({severityFilter})
            filters.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setSourceFilter("all");
              setSeverityFilter("all");
            }}
          >
            Reset filters
          </Button>
        </div>
      ) : (
        <>
          <div className="app-errors-summary">
            <span>
              Showing {filteredErrors.length} of {errors.length} {errors.length === 1 ? "error" : "errors"}
            </span>
          </div>

          <div className="app-errors-list" role="feed" aria-label="Application errors list">
            {filteredErrors.map((record) => {
              const isExpanded = expandedIds.has(record.id);
              const hasContext = Boolean(record.context && Object.keys(record.context).length > 0);
              const hasDetails = Boolean(record.stack || hasContext);
              const labelId = record.errorName ? `error-title-${record.id}` : `error-message-${record.id}`;

              return (
                <article
                  className={cn("app-error-card", `app-error-card-${record.severity}`)}
                  key={record.id}
                  aria-labelledby={labelId}
                >
                  <div className="app-error-card-header">
                    <div className="app-error-card-badges">
                      <Badge className={cn("app-error-severity-badge", `severity-${record.severity}`)}>
                        {record.severity}
                      </Badge>
                      <Badge className="app-error-source-badge">{record.source}</Badge>
                    </div>
                    <time dateTime={record.timestamp} title={record.timestamp}>
                      {formatErrorTimestamp(record.timestamp)}
                    </time>
                  </div>

                  {record.errorName ? (
                    <h3 id={`error-title-${record.id}`} className="app-error-name">
                      {record.errorName}
                    </h3>
                  ) : null}

                  <p id={`error-message-${record.id}`} className="app-error-message">
                    {record.message}
                  </p>

                  {hasDetails ? (
                    <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(record.id)}>
                      <CollapsibleTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="app-error-details-toggle"
                            aria-expanded={isExpanded}
                          />
                        }
                      >
                        <DashboardIcon name={isExpanded ? "up" : "down"} />
                        <span>{isExpanded ? "Hide details" : "View details"}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="app-error-details-panel">
                        {hasContext && record.context ? (
                          <div className="app-error-details-section">
                            <h4 className="app-error-details-heading">Context</h4>
                            <dl className="app-error-context-list">
                              {Object.entries(record.context).map(([key, value]) => (
                                <div key={key} style={{ display: "contents" }}>
                                  <dt>{key}</dt>
                                  <dd>
                                    {value === null
                                      ? "null"
                                      : typeof value === "object"
                                        ? JSON.stringify(value)
                                        : String(value)}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        ) : null}

                        {record.stack ? (
                          <div className="app-error-details-section">
                            <h4 className="app-error-details-heading">Stack trace</h4>
                            <pre className="app-error-stack">
                              <code>{record.stack}</code>
                            </pre>
                          </div>
                        ) : null}
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}
                </article>
              );
            })}
          </div>
        </>
      )}

      <Dialog
        open={clearDialogOpen}
        onOpenChange={(open) => {
          if (!clearPending) {
            setClearDialogOpen(open);
            if (!open) setClearError(null);
          }
        }}
        dismissible={!clearPending}
        title="Clear application errors?"
        description="This will permanently delete all recorded daemon and browser error entries from the host ledger."
      >
        {clearError ? (
          <p className="inline-error" role="alert">
            {clearError}
          </p>
        ) : null}
        <footer className="dialog-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={clearPending}
            onClick={() => {
              setClearDialogOpen(false);
              setClearError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={clearPending}
            aria-busy={clearPending}
            onClick={() => void handleConfirmClear()}
          >
            {clearPending ? "Clearing…" : "Clear errors"}
          </Button>
        </footer>
      </Dialog>
    </div>
  );
}
