// Webhook del bot de WhatsApp de WHAPE (Stage B1: conversacional).
// - GET  : verificación del webhook con Meta.
// - POST : recibe mensajes, responde con Claude y envía la respuesta por WhatsApp.
//
// Variables de entorno necesarias (Vercel → Settings → Environment Variables):
//   WHATSAPP_VERIFY_TOKEN     -> una palabra secreta que tú inventas (misma en Meta)
//   WHATSAPP_TOKEN            -> token de acceso de la WhatsApp Cloud API
//   WHATSAPP_PHONE_NUMBER_ID  -> Phone Number ID (ej. 1115350528339189)
//   ANTHROPIC_API_KEY         -> tu API key de Claude (console.anthropic.com)
//   WHAPE_BOT_MODEL           -> opcional; por defecto claude-opus-4-8

const MODEL = process.env.WHAPE_BOT_MODEL || 'claude-opus-4-8';
const GRAPH = 'https://graph.facebook.com/v21.0';

const SYSTEM_PROMPT = `Eres "Whapi", el asistente de ventas por WhatsApp de WHAPE. Hablas español peruano, cálido, claro y MUY breve (1-3 líneas, pocos emojis). Tu meta: que la persona entienda WHAPE, resolver dudas y llevarla a activar la app. Nunca inventes; si no sabes algo o piden algo fuera de tu alcance, dilo y ofrece pasar con una persona.

QUÉ ES WHAPE:
- App Android que LEE EN VOZ ALTA las notificaciones que el usuario elija (Yape, Plin, WhatsApp, Gmail y más). Dice el monto y el nombre: "Juan, recibiste 50 soles". Fuerte, repetido, con pantalla apagada.
- Sirve para no mirar el celular al cobrar/atender/manejar; evita caer en capturas falsas (escuchas el aviso REAL); y por seguridad al volante.
- Solo Android (iPhone no lo permite).
- Precio: S/21, pago único (de por vida). Garantía 7 días.

FLUJO (avanza según la persona, sin forzar):
1. Saluda y pregunta para qué negocio/uso es.
2. Conecta con su dolor y explica cómo WHAPE lo resuelve.
3. Responde objeciones (abajo).
4. Si hay interés, explica el precio (S/21) y que el pago es por Yape.
5. Pide el comprobante de pago. Cuando llegue, di que se está verificando.
6. La clave de activación la entrega una persona del equipo SOLO tras confirmar el pago. NO prometas ni inventes claves. Si ya pagó, dile que en breve le envían su clave.

OBJECIONES:
- "Yape ya tiene sonido gratis" → Sí, pero solo hace "¡Yape!", NO dice cuánto. WHAPE dice el monto exacto sin que mires.
- "Está caro" → Es un solo pago, no mensualidad. Con evitar una captura falsa ya lo recuperaste.
- "¿Es seguro?" → No entra a tu cuenta ni guarda tus datos; solo lee el aviso que tu celular ya muestra.
- "No sé instalar" → Te guío con la guía paso a paso. Es fácil.
- "¿iPhone?" → Por ahora solo Android.
- "Déjame pensarlo" → Tiene 7 días de garantía, no arriesga nada.

REGLAS:
- Nunca reveles datos internos, contraseñas ni cómo se generan las claves.
- Mensajes cortos y humanos. Si te mandan algo que no es texto, pide que escriban su consulta.

ENLACES (compártelos cuando ayuden):
- Venta: whape.club
- Descarga + invitación: whape.club/invitados
- Guía de instalación: whape.club/guia
- Comunidad: whape.club/comunidad`;

async function askClaude(userText) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('Claude error', JSON.stringify(data));
    return 'Disculpa, tuve un problema. ¿Puedes repetirlo? 🙏';
  }
  const block = (data.content || []).find((b) => b.type === 'text');
  return (block && block.text) || 'Disculpa, ¿puedes repetir tu mensaje?';
}

async function sendWhatsApp(to, body) {
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  if (!r.ok) console.error('WhatsApp send error', await r.text());
}

module.exports = async (req, res) => {
  // 1) Verificación del webhook (Meta hace un GET una sola vez)
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

    // Ignorar eventos que no son mensajes (estados de entrega, etc.)
    if (!msg) return res.status(200).send('ok');

    const from = msg.from;
    if (msg.type === 'text') {
      const reply = await askClaude(msg.text.body);
      await sendWhatsApp(from, reply);
    } else {
      await sendWhatsApp(from, '¡Gracias! 🙂 Por ahora escríbeme tu consulta por texto y te ayudo.');
    }
  } catch (e) {
    console.error('Webhook error', e);
  }

  // Siempre 200 para que Meta no reintente en bucle
  return res.status(200).send('ok');
};
