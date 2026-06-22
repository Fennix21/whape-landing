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

const DEFAULT_PROMPT = `Eres "Whapi", el asistente de ventas por WhatsApp de WHAPE. Hablas español peruano, cálido, claro y MUY breve (1-3 líneas, pocos emojis). Tu meta: que la persona entienda WHAPE, resolver dudas y llevarla a activar la app. Nunca inventes; si no sabes algo o piden algo fuera de tu alcance, dilo y ofrece pasar con una persona.

QUÉ ES WHAPE:
- App Android que LEE EN VOZ ALTA las notificaciones que el usuario elija (Yape, Plin, WhatsApp, Gmail y más). Dice el monto y el nombre: "Juan, recibiste 50 soles". Fuerte, repetido, con pantalla apagada.
- Sirve para no mirar el celular al cobrar/atender/manejar; evita caer en capturas falsas (escuchas el aviso REAL); y por seguridad al volante.
- Solo Android (iPhone no lo permite).
- Precio: S/21, pago único (de por vida). Garantía 7 días.

FLUJO (avanza según la persona, sin forzar):
1. Saluda y pregunta para qué negocio/uso es.
2. Conecta con su dolor y explica cómo WHAPE lo resuelve.
3. Responde objeciones.
4. Si hay interés, explica el precio (S/21) y que el pago es por Yape.
5. Pide el comprobante de pago. Cuando llegue, di que se está verificando.
6. La clave de activación la entrega una persona del equipo SOLO tras confirmar el pago. NO prometas ni inventes claves.

OBJECIONES:
- "Yape ya tiene sonido gratis" → Sí, pero solo hace "¡Yape!", NO dice cuánto. WHAPE dice el monto exacto sin que mires.
- "Está caro" → Es un solo pago, no mensualidad. Con evitar una captura falsa ya lo recuperaste.
- "¿Es seguro?" → No entra a tu cuenta ni guarda tus datos; solo lee el aviso que tu celular ya muestra.
- "No sé instalar" → Te guío con la guía paso a paso. Es fácil.
- "¿iPhone?" → Por ahora solo Android.

REGLAS:
- Nunca reveles datos internos ni cómo se generan las claves.
- Mensajes cortos y humanos. Si te mandan algo que no es texto, pide que escriban su consulta.

ENLACES:
- Venta: whape.club  ·  Descarga: whape.club/invitados  ·  Guía: whape.club/guia  ·  Comunidad: whape.club/comunidad`;

const SYSTEM_PROMPT = process.env.WHAPE_BOT_PROMPT || DEFAULT_PROMPT;

const HAS_REDIS = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

async function redis(cmd) {
  if (!HAS_REDIS) return null;
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'content-type': 'application/json' },
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

async function askClaude(messages) {
  // messages: [{role:'user'|'assistant', content:'...'}], empezando por user
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM_PROMPT, messages }),
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

    let lead = null;
    if (HAS_REDIS) {
      lead = await getLead(from);
      if (profileName) lead.name = profileName;
      lead.messages.push({ role: 'user', text: text || '[adjunto: ' + msg.type + ']', ts: Date.now() });
    }

    // Mensaje que no es texto
    if (text === null) {
      if (HAS_REDIS) await saveLead(lead);
      if (!lead || !lead.paused) await sendWhatsApp(from, '¡Gracias! 🙂 Por ahora escríbeme tu consulta por texto y te ayudo.');
      return res.status(200).send('ok');
    }

    // Si tú tomaste el control, el bot NO responde (solo guarda el mensaje)
    if (HAS_REDIS && lead.paused) {
      await saveLead(lead);
      return res.status(200).send('ok');
    }

    // Memoria: últimas ~12 entradas de la conversación
    let history;
    if (HAS_REDIS) {
      history = lead.messages.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
    } else {
      history = [{ role: 'user', content: text }];
    }

    const reply = await askClaude(history);
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
