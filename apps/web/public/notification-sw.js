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
