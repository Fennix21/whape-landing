// Backend del panel/CRM. Protegido con WHAPE_ADMIN_PASS.
// Acciones (POST JSON { pass, action, ... }):
//   list                       -> lista de leads (ordenados por recientes)
//   get    { phone }           -> conversación completa de un lead
//   send   { phone, text }     -> envías tú un mensaje (pausa el bot para ese lead)
//   status { phone, status }   -> cambias el estado del lead
//   pause  { phone, paused }   -> activas/pausas el bot para ese lead

const GRAPH = 'https://graph.facebook.com/v21.0';

async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'content-type': 'application/json' },
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

async function loadLead(phone) {
  const raw = await redis(['GET', 'lead:' + phone]);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return { phone, name: '', status: 'nuevo', paused: false, messages: [] };
}

async function persist(lead) {
  lead.updatedAt = Date.now();
  if (lead.messages.length > 60) lead.messages = lead.messages.slice(-60);
  await redis(['SET', 'lead:' + lead.phone, JSON.stringify(lead)]);
  await redis(['ZADD', 'leads', String(lead.updatedAt), lead.phone]);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Falta configurar Upstash (base de datos).' });

  const b = req.body || {};
  if ((b.pass || '') !== process.env.WHAPE_ADMIN_PASS) return res.status(401).json({ error: 'Contraseña incorrecta.' });

  try {
    if (b.action === 'list') {
      const phones = (await redis(['ZREVRANGE', 'leads', '0', '80'])) || [];
      const leads = [];
      for (const p of phones) {
        const raw = await redis(['GET', 'lead:' + p]);
        if (!raw) continue;
        let l; try { l = JSON.parse(raw); } catch (e) { continue; }
        const last = l.messages && l.messages.length ? l.messages[l.messages.length - 1] : null;
        leads.push({ phone: l.phone, name: l.name || '', status: l.status || 'nuevo', paused: !!l.paused, updatedAt: l.updatedAt || 0, lastText: last ? last.text : '', count: (l.messages || []).length });
      }
      return res.status(200).json({ leads });
    }

    if (b.action === 'get') {
      const raw = await redis(['GET', 'lead:' + b.phone]);
      return res.status(200).json({ lead: raw ? JSON.parse(raw) : null });
    }

    if (b.action === 'send') {
      if (!b.text || !b.phone) return res.status(400).json({ error: 'Falta texto o número.' });
      await sendWhatsApp(b.phone, b.text);
      const l = await loadLead(b.phone);
      l.messages.push({ role: 'assistant', text: b.text, ts: Date.now(), human: true });
      l.paused = true; // tomaste el control
      await persist(l);
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'status') {
      const l = await loadLead(b.phone);
      l.status = b.status;
      await redis(['SET', 'lead:' + l.phone, JSON.stringify(l)]);
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'pause') {
      const l = await loadLead(b.phone);
      l.paused = !!b.paused;
      await redis(['SET', 'lead:' + l.phone, JSON.stringify(l)]);
      return res.status(200).json({ ok: true, paused: l.paused });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    console.error('CRM error', e);
    return res.status(500).json({ error: e.message || 'Error interno.' });
  }
};
