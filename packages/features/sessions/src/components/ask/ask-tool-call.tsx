import type { AskRequest, AskResponse } from "@omp-remote/protocol";
import { Badge } from "../ui/badge.js";
import { tokenizeSafeHttpUrls } from "../transcript/inline-markup.js";
import {
  renderSafeHttpLinkSiblings,
  renderSafeHttpTextWithoutLinks,
} from "../transcript/inline-transcript.js";
import { LegacyAskToolCall } from "./legacy-ask-tool-call.js";
import { RichAskToolCall } from "./rich-ask-tool-call.js";

export interface AskToolCallProps {
  request: AskRequest;
  connection: "connecting" | "connected" | "disconnected";
  onRespond(response: AskResponse): Promise<void>;
  onActivity(): void;
}

export function AskToolCall(props: AskToolCallProps) {
  return props.request.kind === "rich" ? (
    <RichAskToolCall
      request={props.request}
      connection={props.connection}
      onRespond={props.onRespond}
      onActivity={props.onActivity}
    />
  ) : (
    <LegacyAskToolCall request={props.request} connection={props.connection} onRespond={props.onRespond} />
  );
}

export function askOptionHasLinks(texts: readonly (string | undefined)[]): boolean {
  return texts.some((text) => text && tokenizeSafeHttpUrls(text).some((token) => token.kind === "link"));
}

export function renderAskOptionControlCopy({
  description,
  label,
  preview,
  keyPrefix,
  recommended,
}: {
  description?: string;
  label: string;
  preview?: string;
  keyPrefix: string;
  recommended?: boolean;
}) {
  return (
    <span className="ask-option-copy">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">
        {renderSafeHttpTextWithoutLinks(label, `${keyPrefix}:label`)}
        {recommended ? <Badge>Recommended</Badge> : null}
      </span>
      {description ? (
        <span className="ask-option-description">
          {renderSafeHttpTextWithoutLinks(description, `${keyPrefix}:description`)}
        </span>
      ) : null}
      {preview ? (
        <span className="ask-option-preview">
          {renderSafeHttpTextWithoutLinks(preview, `${keyPrefix}:preview`)}
        </span>
      ) : null}
    </span>
  );
}

export function renderAskOptionLinkContainer(texts: readonly (string | undefined)[], keyPrefix: string) {
  return (
    <span className="ask-option-links">
      {texts.flatMap((text, textIndex) =>
        text ? renderSafeHttpLinkSiblings(text, `${keyPrefix}:${textIndex}`) : [],
      )}
    </span>
  );
}
