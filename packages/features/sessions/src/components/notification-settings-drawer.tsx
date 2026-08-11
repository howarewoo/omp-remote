import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "./ui/drawer.js";
import { Button } from "./ui/button.js";
import { Switch } from "./ui/switch.js";

export type NotificationEventKey = "inputRequired" | "sessionIdle";
export type NotificationEventPreferences = Record<NotificationEventKey, boolean>;
export type NotificationSettingsState = "blocked" | "enabled" | "error" | "prompt" | "unsupported";

export interface NotificationSettingsDrawerProps {
  open: boolean;
  mobile: boolean;
  state: NotificationSettingsState;
  preferences: NotificationEventPreferences;
  error: string | null;
  onOpenChange(open: boolean): void;
  onToggleEvent(event: NotificationEventKey, enabled: boolean): Promise<void>;
}

const EVENTS: readonly {
  key: NotificationEventKey;
  label: string;
  description: string;
}[] = [
  {
    key: "inputRequired",
    label: "Input required",
    description: "The host reports that a main session is waiting for input, including an Ask request.",
  },
  {
    key: "sessionIdle",
    label: "Session idle",
    description: "The host reports that a running main session finished and became idle.",
  },
];

function stateDescription(state: NotificationSettingsState, error: string | null): string {
  if (state === "blocked") {
    return "Push notifications are blocked. Allow them in this browser or device settings, then reopen this panel.";
  }
  if (state === "unsupported") {
    return "Push notifications require HTTPS and a supported installed PWA. On iPhone or iPad, add OMP Remote to the Home Screen and open it there.";
  }
  if (state === "error") {
    return error ?? "The last notification change was not confirmed by the host. Try again.";
  }
  if (state === "prompt") {
    return "Turn on an alert to enable Web Push on this device. Permission is requested only after you choose.";
  }
  return "Choose which host-reported events this device receives. Preferences stay independent.";
}

export function NotificationSettingsDrawer({
  open,
  mobile,
  state,
  preferences,
  error,
  onOpenChange,
  onToggleEvent,
}: NotificationSettingsDrawerProps) {
  const disabled = state === "blocked" || state === "unsupported";

  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="notification-settings-sheet">
        <DrawerHeader className="notification-settings-header">
          <div>
            <DrawerTitle>Notification settings</DrawerTitle>
            <DrawerDescription aria-live="polite" role={state === "error" ? "alert" : undefined}>
              {stateDescription(state, error)}
            </DrawerDescription>
          </div>
          <DrawerClose
            render={
              <Button type="button" variant="ghost" size="icon" aria-label="Close notification settings" />
            }
          >
            <span aria-hidden="true">×</span>
          </DrawerClose>
        </DrawerHeader>
        <div className="notification-settings-body">
          <section className="notification-settings-list" aria-label="Session notification events">
            {EVENTS.map((event) => (
              <div className="notification-settings-row" key={event.key}>
                <div>
                  <strong>{event.label}</strong>
                  <p id={`notification-event-${event.key}-description`}>{event.description}</p>
                </div>
                <Switch
                  aria-label={`${event.label} notifications`}
                  aria-describedby={`notification-event-${event.key}-description`}
                  checked={preferences[event.key]}
                  disabled={disabled}
                  onCheckedChange={(checked) => void onToggleEvent(event.key, checked)}
                />
              </div>
            ))}
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
