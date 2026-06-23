// Webhook del bot de WhatsApp de WHAPE.
// - GET  : verificación del webhook con Meta.
// - POST : recibe mensajes, guarda el lead (si hay Upstash), responde con Claude
//          (con memoria de la conversación) y envía la respuesta por WhatsApp.
//          Si el lead está "pausado" (tú tomaste el control), NO responde solo.
//
// Variables de entorno:
//   WHATSAPP_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, ANTHROPIC_API_KEY
//   WHAPE_BOT_MODEL   (opcional; por defecto claude-opus-4-8)
//   WHAPE_BOT_PROMPT  (opcional; sobreescribe el "cerebro" del bot sin tocar código)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (opcional; activan el CRM/memoria)

const MODEL = process.env.WHAPE_BOT_MODEL || 'claude-opus-4-8';
const GRAPH = 'https://graph.facebook.com/v21.0';

const { DEFAULT_PROMPT } = require('./_prompt');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);

async function redis(cmd) {
  if (!HAS_REDIS) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

async function getLead(phone) {
  const raw = await redis(['GET', 'lead:' + phone]);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return { phone, name: '', status: 'nuevo', paused: false, messages: [] };
}

async function saveLead(lead) {
  lead.updatedAt = Date.now();
  if (lead.messages.length > 60) lead.messages = lead.messages.slice(-60);
  await redis(['SET', 'lead:' + lead.phone, JSON.stringify(lead)]);
  await redis(['ZADD', 'leads', String(lead.updatedAt), lead.phone]);
}

// El "cerebro" del bot: lo editas desde /panel → ⚙️ Bot (se guarda en la base).
// Prioridad: lo guardado en la base > variable de entorno > respaldo del código.
async function getPrompt() {
  if (HAS_REDIS) {
    const custom = await redis(['GET', 'config:prompt']);
    if (custom) return custom;
  }
  return process.env.WHAPE_BOT_PROMPT || DEFAULT_PROMPT;
}

// Detecta el "Código de equipo" (ANDROID_ID = 16 hex, con o sin guiones/espacios).
function detectDeviceCode(text) {
  if (!text) return null;
  const m = text.match(/[0-9a-f]{4}[\s-]?[0-9a-f]{4}[\s-]?[0-9a-f]{4}[\s-]?[0-9a-f]{4}/i)
    || text.match(/\b[0-9a-f]{16}\b/i);
  return m ? m[0].trim() : null;
}

// Clasificación automática del lead (solo avanza; nunca retrocede ni pisa lo confirmado a mano).
const STATUS_ORDER = { nuevo: 0, interesado: 1, pago_pendiente: 2, pagado: 3, activado: 4 };
function autoStatus(current, text, isAttachment) {
  current = current || 'nuevo';
  if (current === 'pagado' || current === 'activado' || current === 'descartado') return current;
  const t = (text || '').toLowerCase();
  const pago = /(comprobante|constancia|captura|ya\s*(te|le)?\s*(pagu|yape|yapi|deposit|transfer)|yape[ée]|yapie|ya\s*pagu[eé]|aqu[ií]\s*(est[aá]|va)\s*(el\s*)?(pago|comprobante)|te\s*envi[eé]\s*(el\s*)?(pago|comprobante|yape))/i;
  const interes = /(cu[aá]nto|precio|cuesta|vale|comprar|lo\s*quiero|me\s*interesa|c[oó]mo\s*(lo\s*)?(instalo|compro|pago|descargo|consigo)|quiero\s*(la\s*app|whape|comprar))/i;
  let target = current;
  if (isAttachment || pago.test(t)) target = 'pago_pendiente';
  else if (interes.test(t)) target = 'interesado';
  return STATUS_ORDER[target] > STATUS_ORDER[current] ? target : current;
}

async function askClaude(messages, systemPrompt) {
  // messages: [{role:'user'|'assistant', content:'...'}], empezando por user
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: systemPrompt, messages }),
  });
  const data = await r.json();
  if (!r.ok) { console.error('Claude error', JSON.stringify(data)); return 'Disculpa, tuve un problema. ¿Puedes repetirlo? 🙏'; }
  const block = (data.content || []).find((b) => b.type === 'text');
  return (block && block.text) || 'Disculpa, ¿puedes repetir tu mensaje?';
}

async function sendWhatsApp(to, body) {
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) console.error('WhatsApp send error', await r.text());
}

module.exports = async (req, res) => {
  // Verificación del webhook
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('Forbidden');
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).send('ok');

    const from = msg.from;
    const profileName = value?.contacts?.[0]?.profile?.name || '';
    const text = msg.type === 'text' ? msg.text.body : null;
    const deviceCode = detectDeviceCode(text); // ¿mandó su código de equipo?
    // Adjunto (el comprobante de pago suele venir como imagen)
    let media = null, caption = '';
    if (msg.type === 'image') { media = { id: msg.image?.id, type: 'image' }; caption = msg.image?.caption || ''; }
    else if (msg.type === 'document') { media = { id: msg.document?.id, type: 'document' }; caption = msg.document?.caption || ''; }

    let lead = null;
    if (HAS_REDIS) {
      lead = await getLead(from);
      if (profileName && !lead.name) lead.name = profileName; // no pisar el nombre puesto a mano
      const entry = { role: 'user', text: text || caption || '[adjunto: ' + msg.type + ']', ts: Date.now() };
      if (media && media.id) entry.media = media;
      lead.messages.push(entry);
      lead.status = autoStatus(lead.status, text, text === null); // clasifica solo (solo avanza)
      if (deviceCode) lead.deviceCode = deviceCode; // guarda el código de equipo si lo mandó
    }

    // Mensaje que no es texto (imagen/audio/etc.) — suele ser el comprobante de pago
    if (text === null) {
      if (!lead || !lead.paused) {
        const isImg = msg.type === 'image' || msg.type === 'document';
        const ack = isImg
          ? '¡Gracias! 🙌 Recibí tu comprobante. Lo estoy verificando y en un momento te confirmo y te envío tu clave de activación. 🔑'
          : '¡Gracias! 🙂 Escríbeme tu consulta por texto y te ayudo al toque.';
        await sendWhatsApp(from, ack);
        if (HAS_REDIS) lead.messages.push({ role: 'assistant', text: ack, ts: Date.now() }); // guardar también en el CRM
      }
      if (HAS_REDIS) await saveLead(lead);
      return res.status(200).send('ok');
    }

    // Si tú tomaste el control, el bot NO responde (solo guarda el mensaje)
    if (HAS_REDIS && lead.paused) {
      await saveLead(lead);
      return res.status(200).send('ok');
    }

    // Si mandó su CÓDIGO DE EQUIPO: respuesta FIJA (la IA NUNCA debe inventar/validar/recitar códigos).
    if (deviceCode) {
      const ack = '¡Recibí tu código de equipo! ✅ Lo verifico junto con tu pago y te envío tu clave de activación en breve. 🔑';
      await sendWhatsApp(from, ack);
      if (HAS_REDIS) { lead.messages.push({ role: 'assistant', text: ack, ts: Date.now() }); await saveLead(lead); }
      return res.status(200).send('ok');
    }

    // Memoria: últimas ~12 entradas de la conversación
    let history;
    if (HAS_REDIS) {
      history = lead.messages.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
    } else {
      history = [{ role: 'user', content: text }];
    }

    const reply = await askClaude(history, await getPrompt());
    await sendWhatsApp(from, reply);

    if (HAS_REDIS) {
      lead.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
      await saveLead(lead);
    }
  } catch (e) {
    console.error('Webhook error', e);
  }

  return res.status(200).send('ok');
};
