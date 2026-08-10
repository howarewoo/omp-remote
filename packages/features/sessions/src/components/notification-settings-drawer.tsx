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
    description: "A main session is waiting for user input, including rich or legacy Ask requests.",
  },
  {
    key: "sessionIdle",
    label: "Session idle",
    description: "A running main session became idle.",
  },
];

function stateDescription(state: NotificationSettingsState, error: string | null): string {
  if (state === "blocked") {
    return "Notifications are blocked. Allow them in your browser settings to turn these alerts on.";
  }
  if (state === "unsupported") return "This browser does not support notifications.";
  if (state === "error") return error ?? "Notifications could not be enabled. Try again.";
  if (state === "prompt") return "Choose an alert to request notification permission on this device.";
  return "Choose which session events can alert you on this device.";
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
            <DrawerDescription>{stateDescription(state, error)}</DrawerDescription>
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
                  <p>{event.description}</p>
                </div>
                <Switch
                  aria-label={`${event.label} notifications`}
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
