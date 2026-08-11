import * as React from "react";
import { Questionnaire as QuestionnairePrimitive } from "@shadcn/react/questionnaire";
import { cn } from "./utils.js";

type QuestionnaireButtonProps = React.ComponentProps<typeof QuestionnairePrimitive.Previous> & {
  size?: "default" | "sm" | "icon";
  variant?: "default" | "outline" | "ghost" | "destructive";
};

function buttonClass(
  size: QuestionnaireButtonProps["size"] = "default",
  variant: QuestionnaireButtonProps["variant"] = "default",
) {
  return cn("ui-button", `ui-button-${variant}`, `ui-button-size-${size}`);
}

export function Questionnaire({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Root>) {
  return (
    <QuestionnairePrimitive.Root
      data-slot="questionnaire"
      className={cn("ask-questionnaire", className)}
      {...props}
    />
  );
}

export function QuestionnaireProgress({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Progress>) {
  return (
    <QuestionnairePrimitive.Progress
      data-slot="questionnaire-progress"
      className={cn("ask-progress", className)}
      {...props}
    />
  );
}

export function QuestionnaireItem({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Item>) {
  return (
    <QuestionnairePrimitive.Item
      data-slot="questionnaire-item"
      className={cn("ask-question", className)}
      {...props}
    />
  );
}

export function QuestionnaireTitle({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Title>) {
  return (
    <QuestionnairePrimitive.Title
      data-slot="questionnaire-title"
      className={cn("ask-question-title", className)}
      {...props}
    />
  );
}

export function QuestionnaireDescription({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Description>) {
  return (
    <QuestionnairePrimitive.Description
      data-slot="questionnaire-description"
      className={cn("ask-question-description", className)}
      {...props}
    />
  );
}

export function QuestionnaireChoices({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Choices>) {
  return (
    <QuestionnairePrimitive.Choices
      data-slot="questionnaire-choices"
      className={cn("ask-options", className)}
      {...props}
    />
  );
}

export function QuestionnaireChoice({
  children,
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Choice>) {
  return (
    <QuestionnairePrimitive.Choice
      data-slot="questionnaire-choice"
      className={cn("ask-option ask-rich-option", className)}
      {...props}
    >
      <QuestionnairePrimitive.ChoiceInput
        data-slot="questionnaire-choice-input"
        className="ask-questionnaire-choice-input"
      />
      <QuestionnairePrimitive.ChoiceLabel data-slot="questionnaire-choice-label" className="ask-option-copy">
        {children}
      </QuestionnairePrimitive.ChoiceLabel>
    </QuestionnairePrimitive.Choice>
  );
}

export function QuestionnaireChoiceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="questionnaire-choice-description"
      className={cn("ask-option-description", className)}
      {...props}
    />
  );
}

export function QuestionnaireInput({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Input>) {
  return (
    <QuestionnairePrimitive.Input
      data-slot="questionnaire-input"
      className={cn("ask-questionnaire-input", className)}
      {...props}
    />
  );
}

export function QuestionnaireError({
  className,
  ...props
}: React.ComponentProps<typeof QuestionnairePrimitive.Error>) {
  return (
    <QuestionnairePrimitive.Error
      data-slot="questionnaire-error"
      className={cn("ask-questionnaire-error", className)}
      {...props}
    />
  );
}

export function QuestionnaireActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="questionnaire-actions"
      className={cn("ask-questionnaire-actions", className)}
      {...props}
    />
  );
}

export function QuestionnairePrevious({
  children,
  className,
  size = "default",
  variant = "outline",
  ...props
}: QuestionnaireButtonProps) {
  return (
    <QuestionnairePrimitive.Previous
      data-slot="questionnaire-previous"
      className={cn(buttonClass(size, variant), "ask-questionnaire-previous", className)}
      {...props}
    >
      {children ?? "Previous"}
    </QuestionnairePrimitive.Previous>
  );
}

export function QuestionnaireNext({
  children,
  className,
  size = "default",
  variant = "default",
  ...props
}: QuestionnaireButtonProps) {
  return (
    <QuestionnairePrimitive.Next
      data-slot="questionnaire-next"
      className={cn(buttonClass(size, variant), "ask-questionnaire-next", className)}
      {...props}
    >
      {children ?? "Next"}
    </QuestionnairePrimitive.Next>
  );
}

export function QuestionnaireSubmit({
  children,
  className,
  size = "default",
  variant = "default",
  ...props
}: QuestionnaireButtonProps) {
  return (
    <QuestionnairePrimitive.Submit
      data-slot="questionnaire-submit"
      className={cn(buttonClass(size, variant), "ask-questionnaire-submit", className)}
      {...props}
    >
      {children ?? "Submit"}
    </QuestionnairePrimitive.Submit>
  );
}
