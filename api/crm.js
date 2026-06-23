// Backend del panel/CRM. Protegido con WHAPE_ADMIN_PASS.
// Acciones (POST JSON { pass, action, ... }):
//   list                       -> lista de leads (ordenados por recientes)
//   get    { phone }           -> conversación completa de un lead
//   send   { phone, text }     -> envías tú un mensaje (pausa el bot para ese lead)
//   status { phone, status }   -> cambias el estado del lead
//   pause  { phone, paused }   -> activas/pausas el bot para ese lead
//   rename { phone, name }     -> renombras al lead
//   genkey { phone, code }     -> generas la clave del código y se la envías por WhatsApp

const crypto = require('crypto');
const { DEFAULT_PROMPT } = require('./_prompt');
const GRAPH = 'https://graph.facebook.com/v21.0';

// --- Generación de la clave de activación (idéntica a api/genkey.js y a la app) ---
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function base32(buf) {
  let value = 0, bits = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; value &= (1 << bits) - 1; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function makeKey(code) {
  const canonical = (code || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (canonical.length < 6) return null;
  const mac = crypto.createHmac('sha256', process.env.WHAPE_SECRET).update(canonical, 'utf8').digest();
  return base32(mac.subarray(0, 10)).match(/.{1,4}/g).join('-');
}
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
  if (lead.messages.length > 300) lead.messages = lead.messages.slice(-300);
  await redis(['SET', 'lead:' + lead.phone, JSON.stringify(lead)]);
  await redis(['ZADD', 'leads', String(lead.updatedAt), lead.phone]);
}

// Plantillas de respuesta rápida por defecto (editables desde el panel).
const DEFAULT_TEMPLATES = [
  { label: '💳 Datos para Yape', text: 'Para activar WHAPE son S/21 por Yape. Te paso el número: [PON AQUÍ TU NÚMERO DE YAPE]. Cuando pagues, mándame la captura del comprobante y te envío tu clave. 🙌' },
  { label: '📲 Guía de instalación', text: 'Aquí tienes la guía paso a paso para instalar WHAPE: whape.club/guia 📲' },
  { label: '👋 ¿Sigues ahí?', text: '¡Hola! 👋 ¿Sigues interesado en WHAPE? Cualquier duda, con gusto te ayudo.' },
  { label: '🔑 Pedir código', text: 'Para enviarte tu clave necesito tu "Código de equipo": abre WHAPE → pantalla de activación → cópiame el código que aparece (ej. A7F3-9KQ2-1MBW-ZX08).' },
];

const { flushDueReminders } = require('./_reminders');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Falta configurar Upstash (base de datos).' });

  const b = req.body || {};
  if ((b.pass || '') !== process.env.WHAPE_ADMIN_PASS) return res.status(401).json({ error: 'Contraseña incorrecta.' });

  try {
    if (b.action === 'list') {
      const phones = (await redis(['ZREVRANGE', 'leads', '0', '300'])) || [];
      const leads = [];
      for (const p of phones) {
        const raw = await redis(['GET', 'lead:' + p]);
        if (!raw) continue;
        let l; try { l = JSON.parse(raw); } catch (e) { continue; }
        const msgs = l.messages || [];
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        leads.push({
          phone: l.phone, name: l.name || '', status: l.status || 'nuevo', paused: !!l.paused,
          updatedAt: l.updatedAt || 0, lastText: last ? last.text : '', count: msgs.length,
          lastRole: last ? (last.human ? 'human' : last.role) : '',
          hasMedia: msgs.some((m) => m.media && m.media.id),
          hasNote: !!(l.note && l.note.trim()),
          tags: l.tags || [], source: l.source || '', remindAt: l.remindAt || 0,
        });
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

    if (b.action === 'genkey') {
      if (!process.env.WHAPE_SECRET) return res.status(500).json({ error: 'Falta WHAPE_SECRET en Vercel.' });
      const key = makeKey(b.code);
      if (!key) return res.status(400).json({ error: 'Código de equipo inválido. Pídele al cliente el código completo (ej. A7F3-9KQ2-1MBW-ZX08).' });
      const cuerpo =
        '🎉 ¡Pago confirmado! Aquí está tu *clave de activación* de WHAPE:\n\n' +
        '🔑 *' + key + '*\n\n' +
        'Para activar:\n' +
        '1) Abre WHAPE en tu celular.\n' +
        '2) En la pantalla de activación, escribe o pega esta clave.\n' +
        '3) Toca "Activar". ¡Listo! 🎊\n\n' +
        '📲 Guía completa: whape.club/guia\n' +
        '¡Gracias por tu compra! 🙌';
      await sendWhatsApp(b.phone, cuerpo);
      const l = await loadLead(b.phone);
      l.deviceCode = b.code;
      l.key = key;
      l.status = 'activado';
      l.messages.push({ role: 'assistant', text: cuerpo, ts: Date.now(), human: true });
      await persist(l);
      return res.status(200).json({ ok: true, key });
    }

    if (b.action === 'rename') {
      const l = await loadLead(b.phone);
      l.name = (b.name || '').slice(0, 60);
      await redis(['SET', 'lead:' + l.phone, JSON.stringify(l)]);
      return res.status(200).json({ ok: true, name: l.name });
    }

    // Nota privada del lead (el cliente NO la ve).
    if (b.action === 'note') {
      const l = await loadLead(b.phone);
      l.note = (b.note || '').toString().slice(0, 1000);
      await redis(['SET', 'lead:' + l.phone, JSON.stringify(l)]);
      return res.status(200).json({ ok: true });
    }

    // Etiquetas libres del lead.
    if (b.action === 'tags') {
      const l = await loadLead(b.phone);
      const tags = (Array.isArray(b.tags) ? b.tags : [])
        .map((t) => (t || '').toString().trim().slice(0, 24)).filter(Boolean).slice(0, 12);
      l.tags = Array.from(new Set(tags));
      await redis(['SET', 'lead:' + l.phone, JSON.stringify(l)]);
      return res.status(200).json({ ok: true, tags: l.tags });
    }

    // Recordatorio: avisa a tu WhatsApp en X minutos para retomar al lead.
    if (b.action === 'remind') {
      const l = await loadLead(b.phone);
      const mins = Number(b.minutes) || 0;
      if (mins <= 0) { // cancelar
        delete l.remindAt; delete l.remindNote;
        await redis(['ZREM', 'reminders', l.phone]);
      } else {
        l.remindAt = Date.now() + mins * 60000;
        l.remindNote = (b.note || '').toString().slice(0, 120);
        await redis(['ZADD', 'reminders', String(l.remindAt), l.phone]);
      }
      await redis(['SET', 'lead:' + l.phone, JSON.stringify(l)]);
      return res.status(200).json({ ok: true, remindAt: l.remindAt || 0 });
    }

    // Dispara los recordatorios vencidos (lo llama el panel y el cron).
    if (b.action === 'flushreminders') {
      const fired = await flushDueReminders();
      return res.status(200).json({ ok: true, fired });
    }

    // Plantillas de respuesta rápida (lista de {label, text}).
    if (b.action === 'gettemplates') {
      const raw = await redis(['GET', 'config:templates']);
      let tpl = [];
      if (raw) { try { tpl = JSON.parse(raw); } catch (e) {} }
      if (!tpl.length) tpl = DEFAULT_TEMPLATES;
      return res.status(200).json({ templates: tpl });
    }
    if (b.action === 'settemplates') {
      const tpl = (Array.isArray(b.templates) ? b.templates : [])
        .map((t) => ({ label: (t.label || '').toString().slice(0, 30), text: (t.text || '').toString().slice(0, 1000) }))
        .filter((t) => t.label && t.text).slice(0, 12);
      await redis(['SET', 'config:templates', JSON.stringify(tpl)]);
      return res.status(200).json({ ok: true, templates: tpl });
    }

    if (b.action === 'pause') {
      const l = await loadLead(b.phone);
      l.paused = !!b.paused;
      await redis(['SET', 'lead:' + l.phone, JSON.stringify(l)]);
      return res.status(200).json({ ok: true, paused: l.paused });
    }

    // Vacía la conversación pero MANTIENE el contacto (lo deja como nuevo).
    if (b.action === 'clearchat') {
      const l = await loadLead(b.phone);
      l.messages = [];
      l.status = 'nuevo';
      l.paused = false;
      delete l.deviceCode;
      delete l.key;
      await persist(l);
      return res.status(200).json({ ok: true });
    }

    // Elimina el contacto Y todos sus registros (desaparece del panel).
    if (b.action === 'delete') {
      await redis(['DEL', 'lead:' + b.phone]);
      await redis(['ZREM', 'leads', b.phone]);
      return res.status(200).json({ ok: true });
    }

    // --- "Cerebro" del bot (system prompt) editable desde el panel ---
    if (b.action === 'getprompt') {
      const custom = await redis(['GET', 'config:prompt']);
      const ownerPhone = await redis(['GET', 'config:ownerphone']);
      const notify = await redis(['GET', 'config:notify']);
      return res.status(200).json({
        prompt: custom || DEFAULT_PROMPT,
        isCustom: !!custom,
        default: DEFAULT_PROMPT,
        ownerPhone: ownerPhone || '',
        notify: notify !== '0', // por defecto activado
      });
    }

    if (b.action === 'stats') {
      const events = (await redis(['SMEMBERS', 'stat:events'])) || [];
      const evTotals = {};
      if (events.length) {
        const vals = await redis(['MGET', ...events.map((e) => 'stat:' + e)]);
        events.forEach((e, i) => { evTotals[e] = Number((vals && vals[i]) || 0); });
      }
      const pages = (await redis(['SMEMBERS', 'stat:pages'])) || [];
      const pageCounts = {};
      if (pages.length) {
        const vals = await redis(['MGET', ...pages.map((p) => 'stat:page:' + p)]);
        pages.forEach((p, i) => { pageCounts[p] = Number((vals && vals[i]) || 0); });
      }
      const refs = (await redis(['SMEMBERS', 'stat:refs'])) || [];
      const refCounts = {};
      if (refs.length) {
        const vals = await redis(['MGET', ...refs.map((r) => 'stat:ref:' + r)]);
        refs.forEach((r, i) => { refCounts[r] = Number((vals && vals[i]) || 0); });
      }
      // Desglose por página de cada evento (ej. clics a WhatsApp por página).
      const evByPage = {};
      for (const e of events) {
        const ps = (await redis(['SMEMBERS', 'stat:evpages:' + e])) || [];
        if (!ps.length) continue;
        const vals = await redis(['MGET', ...ps.map((p) => 'stat:evp:' + e + ':' + p)]);
        const obj = {};
        ps.forEach((p, i) => { obj[p] = Number((vals && vals[i]) || 0); });
        evByPage[e] = obj;
      }
      const days = [];
      for (let i = 6; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
      const pvVals = await redis(['MGET', ...days.map((d) => 'stat:pageview:' + d)]);
      const daily = days.map((d, i) => ({ day: d, n: Number((pvVals && pvVals[i]) || 0) }));
      return res.status(200).json({ events: evTotals, pages: pageCounts, refs: refCounts, daily, evByPage });
    }

    if (b.action === 'setnotify') {
      const ownerPhone = (b.ownerPhone || '').toString().replace(/\D/g, '').slice(0, 15);
      await redis(['SET', 'config:ownerphone', ownerPhone]);
      await redis(['SET', 'config:notify', b.notify ? '1' : '0']);
      return res.status(200).json({ ok: true, ownerPhone });
    }

    if (b.action === 'setprompt') {
      const p = (b.prompt || '').toString();
      if (p.trim().length < 20) return res.status(400).json({ error: 'El prompt es muy corto. Escribe las instrucciones del bot.' });
      await redis(['SET', 'config:prompt', p]);
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'resetprompt') {
      await redis(['DEL', 'config:prompt']);
      return res.status(200).json({ ok: true, prompt: DEFAULT_PROMPT });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    console.error('CRM error', e);
    return res.status(500).json({ error: e.message || 'Error interno.' });
  }
};
