import { Button } from "../ui/button.js";
import { Dialog } from "../ui/dialog.js";

export interface AbortSessionDialogProps {
  open: boolean;
  sending: boolean;
  onOpenChange(open: boolean): void;
  onAbort(): void;
  onKeepRunning(): void;
}

export function AbortSessionDialog({
  open,
  sending,
  onOpenChange,
  onAbort,
  onKeepRunning,
}: AbortSessionDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Abort this run?"
      description="OMP will stop the active run. The session and transcript stay available."
    >
      <footer className="dialog-actions">
        <Button type="button" variant="ghost" onClick={onKeepRunning}>
          Keep running
        </Button>
        <Button type="button" variant="destructive" disabled={sending} onClick={onAbort}>
          Abort run
        </Button>
      </footer>
    </Dialog>
  );
}

export interface KillSessionDialogProps {
  open: boolean;
  sending: boolean;
  commandError: string | null;
  onOpenChange(open: boolean): void;
  onKill(): void;
  onKeepSession(): void;
}

export function KillSessionDialog({
  open,
  sending,
  commandError,
  onOpenChange,
  onKill,
  onKeepSession,
}: KillSessionDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!sending}
      title="Kill this session?"
      description="This ends the OMP process and its active run. The transcript stays available as a saved session."
    >
      {commandError ? (
        <p className="inline-error" role="alert">
          {commandError}
        </p>
      ) : null}
      <footer className="dialog-actions kill-dialog-actions">
        <Button type="button" variant="ghost" disabled={sending} onClick={onKeepSession}>
          Keep session
        </Button>
        <Button type="button" variant="destructive" disabled={sending} aria-busy={sending} onClick={onKill}>
          {sending ? "Killing…" : "Kill session"}
        </Button>
      </footer>
    </Dialog>
  );
}
