// Lógica de recordatorios compartida (la usan api/crm.js y api/cron.js).
// Dispara los recordatorios vencidos: avisa al WhatsApp del dueño y los quita de la cola.

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

async function sendWhatsApp(to, body) {
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function flushDueReminders() {
  if (!REDIS_URL) return 0;
  const now = Date.now();
  const due = (await redis(['ZRANGEBYSCORE', 'reminders', '0', String(now)])) || [];
  if (!due.length) return 0;
  const owner = ((await redis(['GET', 'config:ownerphone'])) || process.env.WHAPE_OWNER_PHONE || '').replace(/\D/g, '');
  let fired = 0;
  for (const phone of due) {
    const raw = await redis(['GET', 'lead:' + phone]);
    let l = { phone, name: '' };
    if (raw) { try { l = JSON.parse(raw); } catch (e) {} }
    const who = l.name || ('+' + phone);
    if (owner) {
      const note = l.remindNote ? ('\n📝 ' + l.remindNote) : '';
      try {
        await sendWhatsApp(owner, '⏰ *Recordatorio* — retoma a ' + who + ' (+' + phone + ')' + note + '\n👉 whape.club/panel');
        fired++;
      } catch (e) { console.error('reminder send error', e); }
    }
    delete l.remindAt; delete l.remindNote;
    await redis(['ZREM', 'reminders', phone]);
    await redis(['SET', 'lead:' + phone, JSON.stringify(l)]);
  }
  return fired;
}

module.exports = { flushDueReminders };
