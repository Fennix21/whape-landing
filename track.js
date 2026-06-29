// Mini-analítica de WHAPE. Envía pageview y clics clave a /api/track.
// Sin cookies, sin datos personales: solo conteos.
(function () {
  function send(ev, extra) {
    var data = Object.assign({ ev: ev, p: location.pathname, r: document.referrer || '' }, extra || {});
    try {
      var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      if (navigator.sendBeacon && navigator.sendBeacon('/api/track', blob)) return;
    } catch (e) {}
    try {
      fetch('/api/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  send('pageview');

  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a,button') : null;
    if (!a) return;
    var ev = a.getAttribute('data-ev');
    if (!ev) {
      var href = (a.getAttribute('href') || '').toLowerCase();
      if (href.indexOf('wa.me') >= 0 || href.indexOf('api.whatsapp') >= 0 || href.indexOf('whatsapp.com') >= 0) ev = 'whatsapp_click';
      else if (href.indexOf('/registro-comunidad') >= 0) ev = 'registro_click';
      else if (href.indexOf('/comunidad') >= 0) ev = 'comunidad_click';
    }
    if (ev) send(ev);
  }, true);
})();
