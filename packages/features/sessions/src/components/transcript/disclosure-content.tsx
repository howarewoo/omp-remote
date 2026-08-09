import { type MouseEvent as ReactMouseEvent, useState } from "react";
import { renderPlainTextWithLinks } from "./inline-transcript.js";

export type DisclosureTranscriptSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; alt: string; source: string };

const DISCLOSURE_IMAGE_PATTERN = /(?<!\\)!\[([^\]\r\n]*)\]\((https:\/\/[^)\s]+)\)/g;

export function parseDisclosureImages(text: string): DisclosureTranscriptSegment[] {
  const segments: DisclosureTranscriptSegment[] = [];
  let textStart = 0;

  for (const match of text.matchAll(DISCLOSURE_IMAGE_PATTERN)) {
    const matchStart = match.index;
    if (matchStart > textStart) segments.push({ kind: "text", text: text.slice(textStart, matchStart) });
    segments.push({ kind: "image", alt: match[1] ?? "", source: match[2] ?? "" });
    textStart = matchStart + match[0].length;
  }

  if (textStart < text.length || segments.length === 0) {
    segments.push({ kind: "text", text: text.slice(textStart) });
  }
  return segments;
}

export function renderDisclosureTranscriptText(
  text: string,
  linkify = true,
  onLinkClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
) {
  return linkify ? (
    renderPlainTextWithLinks(text, "disclosure", undefined, onLinkClick)
  ) : (
    <pre className="transcript-disclosure-text">{text}</pre>
  );
}

export function DisclosureImage({
  alt,
  fallbackLabel,
  pending = false,
  source,
  variant,
}: {
  alt: string;
  fallbackLabel: string;
  pending?: boolean;
  source: string | null | undefined;
  variant: "thumbnail" | "expanded";
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  if (pending && !source) {
    const loading = `Loading image: ${fallbackLabel}`;
    return (
      <span className="disclosure-image">
        <span className="disclosure-image-fallback" role="status">
          {loading}
        </span>
      </span>
    );
  }

  const sourceLinkLabel = alt ? `Open image source: ${alt}` : "Open image source";

  if (!source || loadFailed) {
    const fallback = `Image unavailable: ${fallbackLabel}`;
    const fallbackNode = (
      <span aria-label={fallback} className="disclosure-image-fallback" role="img">
        {fallback}
      </span>
    );
    return (
      <span className="disclosure-image">
        {source && variant === "expanded" ? (
          <a
            aria-label={sourceLinkLabel}
            className="disclosure-image-link"
            href={source}
            rel="noreferrer"
            target="_blank"
          >
            {fallbackNode}
          </a>
        ) : (
          fallbackNode
        )}
      </span>
    );
  }

  const image = (
    <img
      alt={alt}
      className="disclosure-image-media"
      decoding="async"
      loading="lazy"
      onError={() => setLoadFailed(true)}
      referrerPolicy="no-referrer"
      src={source}
    />
  );

  return (
    <span className="disclosure-image">
      {variant === "expanded" ? (
        <a
          aria-label={sourceLinkLabel}
          className="disclosure-image-link"
          href={source}
          rel="noreferrer"
          target="_blank"
        >
          {image}
        </a>
      ) : (
        image
      )}
    </span>
  );
}

export function getDisclosurePlainText(segments: readonly DisclosureTranscriptSegment[]): string {
  return segments
    .filter(
      (segment): segment is Extract<DisclosureTranscriptSegment, { kind: "text" }> => segment.kind === "text",
    )
    .map((segment) => segment.text)
    .join("");
}

type DisclosureTranscriptContentProps =
  | {
      preview: string;
      segments: readonly DisclosureTranscriptSegment[];
      variant: "thumbnail";
    }
  | {
      preview?: never;
      segments: readonly DisclosureTranscriptSegment[];
      variant: "expanded";
    };

export function renderDisclosureTranscriptContent(props: DisclosureTranscriptContentProps) {
  const { segments, variant } = props;
  const images = segments.filter(
    (segment): segment is Extract<DisclosureTranscriptSegment, { kind: "image" }> => segment.kind === "image",
  );

  return (
    <div className="transcript-disclosure-content" data-variant={variant}>
      {variant === "thumbnail" ? (
        <>
          {props.preview || images.length === 0
            ? renderDisclosureTranscriptText(props.preview, true, (event) => event.stopPropagation())
            : null}
          {images.map((image, index) => (
            <DisclosureImage
              alt={image.alt}
              fallbackLabel={image.alt || "image"}
              key={`${index}:${image.source}`}
              source={image.source}
              variant={variant}
            />
          ))}
        </>
      ) : (
        segments.map((segment, index) =>
          segment.kind === "text" ? (
            renderPlainTextWithLinks(
              segment.text,
              `disclosure:${index}`,
              "transcript-disclosure-text",
              (event) => event.stopPropagation(),
              `${index}:text`,
            )
          ) : (
            <DisclosureImage
              alt={segment.alt}
              fallbackLabel={segment.alt || "image"}
              key={`${index}:${segment.source}`}
              source={segment.source}
              variant={variant}
            />
          ),
        )
      )}
    </div>
  );
}
