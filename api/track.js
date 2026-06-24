// Analítica propia de OYE (sin cookies, solo conteos agregados).
// Recibe eventos desde /track.js y los suma en Upstash.
//   POST { ev, p, r }  ev=evento, p=ruta de la página, r=referrer
// No usa contraseña: solo INCREMENTA contadores (no expone datos).

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!REDIS_URL) return res.status(200).end();

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  const ev = (b.ev || '').toString().slice(0, 40).replace(/[^a-z0-9_]/gi, '');
  if (!ev) return res.status(200).end();
  const day = new Date().toISOString().slice(0, 10);
  const path = ((b.p || '/').toString().slice(0, 60).replace(/[^a-z0-9/_-]/gi, '')) || '/';

  try {
    await redis(['INCR', 'stat:' + ev]);
    await redis(['INCR', 'stat:' + ev + ':' + day]);
    await redis(['SADD', 'stat:events', ev]);

    // En qué página ocurrió el evento (sirve para saber qué botón/página convierte).
    await redis(['INCR', 'stat:evp:' + ev + ':' + path]);
    await redis(['SADD', 'stat:evpages:' + ev, path]);

    if (ev === 'pageview') {
      await redis(['INCR', 'stat:page:' + path]);
      await redis(['SADD', 'stat:pages', path]);

      // Referrer: de dónde llegó (host), o "directo".
      let host = 'directo';
      try {
        const r = (b.r || '').toString();
        if (r) { host = new URL(r).hostname.replace(/^www\./, '').slice(0, 40); }
      } catch (e) {}
      if (host.indexOf('whape.club') >= 0) return res.status(200).end(); // ignora navegación interna
      const safe = host.replace(/[^a-z0-9.-]/gi, '') || 'directo';
      await redis(['INCR', 'stat:ref:' + safe]);
      await redis(['SADD', 'stat:refs', safe]);
    }
  } catch (e) { console.error('track error', e); }

  return res.status(200).end();
};
