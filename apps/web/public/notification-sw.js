self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windowClients) => {
      const appClient = windowClients.find((client) => new URL(client.url).origin === self.location.origin);
      if (appClient) {
        await appClient.focus();
        return;
      }
      await self.clients.openWindow(event.notification.data?.url ?? "/");
    }),
  );
});
