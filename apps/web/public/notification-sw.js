const NOTIFICATION_TITLE_BY_EVENT = {
  inputRequired: "Input required",
  sessionIdle: "Session idle",
};
const NOTIFICATION_PAYLOAD_KEYS = ["body", "event", "tag", "title", "type", "url"];

function sameOriginPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  try {
    const target = new URL(value, self.location.origin);
    if (target.origin !== self.location.origin) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

function notificationPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== NOTIFICATION_PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== NOTIFICATION_PAYLOAD_KEYS[index])
  ) {
    return null;
  }
  if (value.type !== "notification_event") return null;
  const expectedTitle = NOTIFICATION_TITLE_BY_EVENT[value.event];
  if (!expectedTitle || value.title !== expectedTitle) return null;
  if (
    typeof value.body !== "string" ||
    value.body.trim().length === 0 ||
    value.body !== value.body.trim() ||
    value.body.length > 1000 ||
    typeof value.tag !== "string" ||
    value.tag.trim().length === 0 ||
    value.tag !== value.tag.trim() ||
    value.tag.length > 256
  ) {
    return null;
  }
  const url = sameOriginPath(value.url);
  if (!url) return null;
  return {
    title: expectedTitle,
    options: {
      body: value.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: value.tag,
      data: { url },
    },
  };
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let value;
      try {
        value = event.data?.json();
      } catch {
        return;
      }
      const notification = notificationPayload(value);
      if (!notification) return;
      await self.registration.showNotification(notification.title, notification.options);
    })(),
  );
});

function notificationTarget(data) {
  if (typeof data?.url !== "string") return "/";
  try {
    const target = new URL(data.url, self.location.origin);
    if (target.origin !== self.location.origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then(async (windowClients) => {
      const target = notificationTarget(event.notification.data);
      const appClient = windowClients.find((client) => new URL(client.url).origin === self.location.origin);
      if (appClient) {
        await appClient.navigate(target);
        await appClient.focus();
        return;
      }
      await self.clients.openWindow(target);
    }),
  );
});
