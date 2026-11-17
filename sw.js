/* 通知用の service worker。
   ページを閉じていても通知を受け取るために常駐する。
   キャッシュは行わない（更新をすぐ反映させるため）。 */

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* サーバーから通知が届いたとき */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const n = d.notification || d;
  e.waitUntil(self.registration.showNotification(n.title || 'お知らせ', {
    body:  n.body || '',
    icon:  'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag:   n.tag || 'app',
    data:  { url: (d.data && d.data.url) || n.click_action || './' }
  }));
});

/* 通知をタップしたとき。開いているタブがあればそれを前面に出す */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
