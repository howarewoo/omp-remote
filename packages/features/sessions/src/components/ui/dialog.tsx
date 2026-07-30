import { type ReactNode, useEffect, useId, useRef } from "react";

interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
  title: string;
  description?: string;
  dismissible?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  children,
  title,
  description,
  dismissible = true,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      data-slot="dialog"
      className="ui-dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onOpenChange(false);
      }}
      onClose={() => {
        if (dismissible) onOpenChange(false);
      }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) onOpenChange(false);
      }}
      onKeyDown={(event) => {
        if (dismissible && event.key === "Escape") onOpenChange(false);
      }}
    >
      <div data-slot="dialog-content" className="ui-dialog-content">
        <header data-slot="dialog-header" className="ui-dialog-header">
          <h2 data-slot="dialog-title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p data-slot="dialog-description" id={descriptionId}>
              {description}
            </p>
          ) : null}
        </header>
        {children}
      </div>
    </dialog>
  );
}
