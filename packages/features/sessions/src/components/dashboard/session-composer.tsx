import { type Session } from "@omp-remote/protocol";
import { type FormEventHandler } from "react";
import { Button } from "../ui/button.js";
import { Textarea } from "../ui/textarea.js";
import { cn } from "../ui/utils.js";
import { DashboardIcon } from "./icon.js";

const COMPOSER_SUGGESTION_LIST_ID = "composer-command-suggestions";

export interface SessionComposerProps {
  message: string;
  composerSuggestions: Session["composerCommands"];
  activeComposerIndex: number;
  composerAction: "abort" | "steer" | null;
  sending: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onMessageChange(message: string): void;
  onMoveActiveComposer(direction: 1 | -1): void;
  onSelectComposer(commandName: string): void;
  onDismissAutocomplete(message: string): void;
}

export function SessionComposer({
  message,
  composerSuggestions,
  activeComposerIndex,
  composerAction,
  sending,
  onSubmit,
  onMessageChange,
  onMoveActiveComposer,
  onSelectComposer,
  onDismissAutocomplete,
}: SessionComposerProps) {
  const activeComposerSuggestion = composerSuggestions[activeComposerIndex] ?? composerSuggestions[0];
  return (
    <form className="composer" onSubmit={onSubmit}>
      <div className="composer-field">
        <label className="sr-only" htmlFor="composer-message">
          Steer current run
        </label>
        {composerSuggestions.length > 0 ? (
          <div
            className="composer-suggestions"
            id={COMPOSER_SUGGESTION_LIST_ID}
            role="listbox"
            aria-label="Available commands"
          >
            {composerSuggestions.map((command, index) => (
              <button
                type="button"
                className={cn("composer-suggestion", index === activeComposerIndex && "active")}
                id={`${COMPOSER_SUGGESTION_LIST_ID}-${index}`}
                role="option"
                aria-selected={index === activeComposerIndex}
                key={command.name}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  onSelectComposer(command.name);
                  event.currentTarget.form?.querySelector("textarea")?.focus();
                }}
              >
                <code>/{command.name}</code>
                {command.description ? <span>{command.description}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <Textarea
          id="composer-message"
          value={message}
          aria-autocomplete="list"
          aria-controls={composerSuggestions.length > 0 ? COMPOSER_SUGGESTION_LIST_ID : undefined}
          aria-expanded={composerSuggestions.length > 0}
          aria-activedescendant={
            activeComposerSuggestion
              ? `${COMPOSER_SUGGESTION_LIST_ID}-${composerSuggestions.indexOf(activeComposerSuggestion)}`
              : undefined
          }
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder="Redirect the current run…"
          rows={1}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && event.shiftKey) return;
            if (composerSuggestions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                onMoveActiveComposer(event.key === "ArrowDown" ? 1 : -1);
              } else if (
                (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
                event.key === "Tab"
              ) {
                event.preventDefault();
                if (activeComposerSuggestion) onSelectComposer(activeComposerSuggestion.name);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onDismissAutocomplete(message);
              }
              return;
            }
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button
          className="send-button"
          type="submit"
          size="icon"
          variant={composerAction === "abort" ? "destructive" : "default"}
          disabled={!composerAction || sending}
          aria-label={
            sending
              ? "Sending instruction"
              : composerAction === "abort"
                ? "Abort active run"
                : composerAction === "steer"
                  ? "Steer active run"
                  : "Enter an instruction to steer"
          }
        >
          <DashboardIcon name={composerAction === "abort" ? "stop" : "send"} />
        </Button>
      </div>
    </form>
  );
}
