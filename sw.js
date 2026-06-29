// sw.js — the service worker needed to show push notifications even when the
// tab or browser is closed. Must live next to index.html (same folder) and be
// registered with a RELATIVE path ('sw.js', not '/sw.js') — GitHub Pages
// project sites are served from /your-repo-name/, not the domain root, and an
// absolute path would silently point at the wrong place.

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'Sinyal', body: 'You have a new notification.' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // Relative paths too — only matters if you add real icon files later.
      icon: 'icon-192.png',
      badge: 'icon-72.png',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  // self.registration.scope is the actual folder this service worker controls
  // (e.g. https://you.github.io/sinyal/) — correct regardless of subpath.
  event.waitUntil(clients.openWindow(self.registration.scope));
});
