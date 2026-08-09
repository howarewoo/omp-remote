import { type Session } from "@omp-remote/protocol";
import { type FormEventHandler } from "react";
import { Button } from "../ui/button.js";
import { Textarea } from "../ui/textarea.js";
import { cn } from "../ui/utils.js";
import { DashboardIcon } from "./icon.js";

const SKILL_SUGGESTION_LIST_ID = "composer-skill-suggestions";

export interface SessionComposerProps {
  message: string;
  skillSuggestions: Session["skillCommands"];
  activeSkillIndex: number;
  composerAction: "abort" | "steer" | null;
  sending: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onMessageChange(message: string): void;
  onMoveActiveSkill(direction: 1 | -1): void;
  onSelectSkill(commandName: string): void;
  onDismissAutocomplete(message: string): void;
}

export function SessionComposer({
  message,
  skillSuggestions,
  activeSkillIndex,
  composerAction,
  sending,
  onSubmit,
  onMessageChange,
  onMoveActiveSkill,
  onSelectSkill,
  onDismissAutocomplete,
}: SessionComposerProps) {
  const activeSkillSuggestion = skillSuggestions[activeSkillIndex] ?? skillSuggestions[0];
  return (
    <form className="composer" onSubmit={onSubmit}>
      <div className="composer-field">
        <label className="sr-only" htmlFor="composer-message">
          Steer current run
        </label>
        {skillSuggestions.length > 0 ? (
          <div
            className="skill-suggestions"
            id={SKILL_SUGGESTION_LIST_ID}
            role="listbox"
            aria-label="Available skills"
          >
            {skillSuggestions.map((skill, index) => (
              <button
                type="button"
                className={cn("skill-suggestion", index === activeSkillIndex && "active")}
                id={`${SKILL_SUGGESTION_LIST_ID}-${index}`}
                role="option"
                aria-selected={index === activeSkillIndex}
                key={skill.name}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  onSelectSkill(skill.name);
                  event.currentTarget.form?.querySelector("textarea")?.focus();
                }}
              >
                <code>/{skill.name}</code>
                {skill.description ? <span>{skill.description}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <Textarea
          id="composer-message"
          value={message}
          aria-autocomplete="list"
          aria-controls={skillSuggestions.length > 0 ? SKILL_SUGGESTION_LIST_ID : undefined}
          aria-expanded={skillSuggestions.length > 0}
          aria-activedescendant={
            activeSkillSuggestion
              ? `${SKILL_SUGGESTION_LIST_ID}-${skillSuggestions.indexOf(activeSkillSuggestion)}`
              : undefined
          }
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder="Redirect the current run…"
          rows={1}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && event.shiftKey) return;
            if (skillSuggestions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                onMoveActiveSkill(event.key === "ArrowDown" ? 1 : -1);
              } else if (
                (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
                event.key === "Tab"
              ) {
                event.preventDefault();
                if (activeSkillSuggestion) onSelectSkill(activeSkillSuggestion.name);
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
