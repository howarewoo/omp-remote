import { type FormEventHandler } from "react";
import { Button } from "../ui/button.js";
import { Dialog } from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { DashboardIcon } from "./icon.js";

export interface SavedDirectoryPending {
  action: "save" | "remove";
  cwd: string;
}

export interface LaunchSessionDialogProps {
  open: boolean;
  cwd: string;
  savedWorkingDirectories: readonly string[];
  savedDirectoryPending: SavedDirectoryPending | null;
  savedDirectoryError: string | null;
  launchError: string | null;
  sending: boolean;
  onOpenChange(open: boolean): void;
  onCwdChange(cwd: string): void;
  onSaveWorkingDirectory(): void;
  onRemoveWorkingDirectory(cwd: string): void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onCancel(): void;
}

export function LaunchSessionDialog({
  open,
  cwd,
  savedWorkingDirectories,
  savedDirectoryPending,
  savedDirectoryError,
  launchError,
  sending,
  onOpenChange,
  onCwdChange,
  onSaveWorkingDirectory,
  onRemoveWorkingDirectory,
  onSubmit,
  onCancel,
}: LaunchSessionDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Start an OMP session"
      description="Choose a working directory. Add a saved session ID or JSONL path to resume it."
    >
      <form className="launch-form" onSubmit={onSubmit}>
        <div className="launch-field">
          <label htmlFor="launch-cwd">Working directory</label>
          <div className="launch-cwd-control">
            <Input
              id="launch-cwd"
              name="cwd"
              required
              placeholder="/Users/you/project"
              autoComplete="off"
              autoFocus
              value={cwd}
              onChange={(event) => onCwdChange(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!cwd.trim() || savedDirectoryPending !== null}
              onClick={onSaveWorkingDirectory}
            >
              {savedDirectoryPending?.action === "save" ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        {savedWorkingDirectories.length > 0 ? (
          <section className="saved-directory-list" aria-label="Saved working directories">
            {savedWorkingDirectories.map((savedCwd) => (
              <div className="saved-directory-item" key={savedCwd}>
                <Button
                  type="button"
                  variant="ghost"
                  className="saved-directory-select"
                  disabled={savedDirectoryPending !== null}
                  onClick={() => onCwdChange(savedCwd)}
                >
                  {savedCwd}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove saved working directory ${savedCwd}`}
                  disabled={savedDirectoryPending !== null}
                  onClick={() => onRemoveWorkingDirectory(savedCwd)}
                >
                  <DashboardIcon name="trash" />
                </Button>
              </div>
            ))}
          </section>
        ) : null}
        <label htmlFor="launch-resume">
          <span>
            Resume ID or path <small>Optional</small>
          </span>
          <Input
            id="launch-resume"
            name="resume"
            placeholder="Session ID or .jsonl path"
            autoComplete="off"
          />
        </label>
        {savedDirectoryError ? (
          <p className="inline-error saved-directory-error" role="alert">
            {savedDirectoryError}
          </p>
        ) : null}
        {launchError ? (
          <p className="inline-error" role="alert">
            {launchError}
          </p>
        ) : null}
        <footer className="dialog-actions">
          <Button type="button" variant="ghost" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={sending}>
            {sending ? "Starting…" : "Start session"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
