// Cron diario de Vercel (7am Perú): dispara recordatorios vencidos y vigila las misiones.
// También puede llamarlo un cron externo con ?key=<CRON_SECRET>.

const { flushDueReminders } = require('./_reminders');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const GRAPH = 'https://graph.facebook.com/v21.0';

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

// Día de la cohorte en hora Perú (UTC-5): día 1 = fecha de inicio.
function cohortDay(startStr) {
  if (!startStr) return 0;
  const start = Date.parse(startStr + 'T00:00:00-05:00');
  if (isNaN(start)) return 0;
  return Math.floor((Date.now() - start) / 86400000) + 1;
}

async function notifyOwner(text) {
  try {
    if ((await redis(['GET', 'config:notify'])) === '0') return;
    const owner = ((await redis(['GET', 'config:ownerphone'])) || process.env.WHAPE_OWNER_PHONE || '').replace(/\D/g, '');
    if (!owner) return;
    await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: owner, type: 'text', text: { body: text } }),
    });
  } catch (e) { console.error('cron notifyOwner', e); }
}

// Vigila la misión activa: 3+ días sin check-in = en riesgo (se avisa UNA vez por caída).
async function scanGroupRisk() {
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return 0;
    let groups = [];
    const raw = await redis(['GET', 'config:groups']);
    if (raw) { try { groups = JSON.parse(raw); } catch (e) {} }
    if (!Array.isArray(groups) || !groups.length) groups = [{ id: 'valorhora', title: 'El Valor de tu Hora', cohortStart: '2026-07-06', duration: 21, active: true }];
    const g = groups.find((x) => x.active) || groups[0];
    if (!g) return 0;
    const dur = Number(g.duration || 21);
    const day = cohortDay(g.cohortStart);
    if (day < 3 || day > dur) return 0; // el riesgo recién existe desde el día 3
    const phones = (await redis(['SMEMBERS', 'members'])) || [];
    if (!phones.length) return 0;
    const graws = (await redis(['MGET', ...phones.map((p) => 'gstate:' + p)])) || [];
    const mraws = (await redis(['MGET', ...phones.map((p) => 'member:' + p)])) || [];
    const risky = [];
    for (let i = 0; i < phones.length; i++) {
      if (!graws[i]) continue;
      let st; try { st = JSON.parse(graws[i]); } catch (e) { continue; }
      if (st.groupId !== g.id) continue;
      const gap = day - (st.lastCheckinDay || 0);
      if (gap >= 3 && !st.riskDay) {
        st.riskDay = day;
        await redis(['SET', 'gstate:' + phones[i], JSON.stringify(st)]);
        let name = ''; if (mraws[i]) { try { name = JSON.parse(mraws[i]).name || ''; } catch (e) {} }
        risky.push({ phone: phones[i], name, gap: Math.min(gap, day) });
      }
    }
    if (risky.length) {
      const lines = risky.map((r) => '• ' + (r.name || ('+' + r.phone)) + ' — ' + r.gap + ' días sin check-in → https://wa.me/' + r.phone).join('\n');
      await notifyOwner('⚠️ *Misión "' + (g.title || '') + '"* (día ' + Math.min(day, dur) + '): miembros en riesgo\n\n' + lines + '\n\nUn mensaje tuyo a tiempo los rescata. 💪');
    }
    return risky.length;
  } catch (e) { console.error('scanGroupRisk', e); return 0; }
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const key = (req.query && req.query.key) || '';
    if (auth !== 'Bearer ' + secret && key !== secret) return res.status(401).send('No autorizado');
  }
  try {
    const fired = await flushDueReminders();
    const risk = await scanGroupRisk();
    return res.status(200).json({ ok: true, fired, risk });
  } catch (e) {
    console.error('cron error', e);
    return res.status(500).json({ error: 'Error' });
  }
};
