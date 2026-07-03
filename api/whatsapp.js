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
const { flushDueReminders } = require('./_reminders');

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
  if (lead.messages.length > 300) lead.messages = lead.messages.slice(-300);
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

// (Detección del "código de equipo" de la app: archivada en ../OYE-app-archivo para OYE)

// Detecta de dónde viene el lead por una marca en su primer mensaje (la pone el enlace).
function detectSource(text) {
  const t = (text || '').toLowerCase();
  if (t.indexOf('(instagram)') >= 0) return 'instagram';
  if (t.indexOf('(invitado)') >= 0) return 'invitado';
  if (t.indexOf('(facebook)') >= 0) return 'facebook';
  if (t.indexOf('(tiktok)') >= 0) return 'tiktok';
  if (t.indexOf('(web)') >= 0) return 'web';
  if (t.indexOf('(academia)') >= 0) return 'academia';
  return 'directo';
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

// Aviso al WhatsApp personal del dueño (config en /panel → ⚙️). No se avisa a sí mismo.
async function notifyOwner(text, from) {
  try {
    if (!HAS_REDIS) return;
    if ((await redis(['GET', 'config:notify'])) === '0') return; // avisos apagados
    const owner = ((await redis(['GET', 'config:ownerphone'])) || process.env.WHAPE_OWNER_PHONE || '').replace(/\D/g, '');
    if (!owner) return;
    if (from && from.replace(/\D/g, '') === owner) return; // no avisarte de tus propios mensajes
    await sendWhatsApp(owner, text);
  } catch (e) { console.error('notifyOwner error', e); }
}

// IA cruda para clasificar (Haiku). Devuelve '' si falla: la captura nunca se rompe por la IA.
async function askAIRaw(system, user, maxTok) {
  if (!process.env.ANTHROPIC_API_KEY) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.WHAPE_AI_MODEL || 'claude-haiku-4-5-20251001', max_tokens: maxTok || 300, system, messages: [{ role: 'user', content: user }] }),
    });
    const data = await r.json();
    if (!r.ok) return '';
    return ((data.content && data.content[0] && data.content[0].text) || '').trim();
  } catch (e) { return ''; }
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
    flushDueReminders().catch(() => {}); // aprovecha la actividad para disparar recordatorios vencidos

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).send('ok');

    const from = msg.from;
    const profileName = value?.contacts?.[0]?.profile?.name || '';
    const text = msg.type === 'text' ? msg.text.body : null;
    const deviceCode = null; // (código de equipo de la app desactivado; archivado en OYE-app-archivo)
    // Adjunto (el comprobante de pago suele venir como imagen)
    let media = null, caption = '';
    if (msg.type === 'image') { media = { id: msg.image?.id, type: 'image' }; caption = msg.image?.caption || ''; }
    else if (msg.type === 'document') { media = { id: msg.document?.id, type: 'document' }; caption = msg.document?.caption || ''; }

    // 💡 Captura de ideas del DUEÑO: tolera saludos y relleno antes del comando
    // ("Hola Whapi, guarda esta idea…", "buenas, anota…", "idea: …", 💡, etc.)
    const IDEA_TRIG = /^\s*(?:(?:hola|hey|oye|buenas|buenos|d[ií]as|tardes|noches|whapi|por|favor|porfa|💡)[\s,!.:]*){0,4}(?:idea\b|anota\b|apunta\b|guarda\b|💡)/i;
    if (HAS_REDIS && text && IDEA_TRIG.test(text)) {
      const owner = ((await redis(['GET', 'config:ownerphone'])) || process.env.WHAPE_OWNER_PHONE || '').replace(/\D/g, '');
      if (owner && from.replace(/\D/g, '') === owner) {
        const raw = text
          .replace(/^\s*(?:(?:hola|hey|oye|buenas|buenos|d[ií]as|tardes|noches|whapi|por|favor|porfa|💡)[\s,!.:]*){0,4}(?:(?:idea|anota|apunta|guarda)\b|💡)[\s:,.!]*/i, '')
          .replace(/^(?:esta\s+idea|una\s+idea|la\s+idea|idea|esto|lo\s+siguiente)\b[\s:,.!]*/i, '')
          .trim().slice(0, 1500);
        if (!raw) { await sendWhatsApp(from, '💡 Dime la idea después de la palabra "idea". Ej: "idea: un reto de 7 días para bodegueras".'); return res.status(200).send('ok'); }
        let title = raw.slice(0, 60), cat = 'otra', next = '';
        const out = await askAIRaw(
          'Clasificas ideas de negocio del dueño de WHAPE (plataforma peruana: comunidad + academia + CRM + bot de WhatsApp que enseña a convertir problemas en negocios). Respondes SOLO un JSON válido, sin texto extra.',
          'Idea: "' + raw + '"\n\nResponde: {"titulo":"máx 8 palabras","categoria":"contenido|producto|comunidad|ventas|copy|otra","siguiente":"el primer paso concreto para implementarla, en 1 línea"}'
        );
        if (out) {
          try {
            const j = JSON.parse(out.replace(/```json|```/g, '').trim());
            if (j.titulo) title = String(j.titulo).slice(0, 80);
            if (j.categoria) cat = String(j.categoria).toLowerCase().slice(0, 20);
            if (j.siguiente) next = String(j.siguiente).slice(0, 200);
          } catch (e) {}
        }
        const rawList = await redis(['GET', 'ideas']);
        let ideas = []; if (rawList) { try { ideas = JSON.parse(rawList); } catch (e) {} }
        ideas.push({ id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), raw, title, cat, next, ts: Date.now(), done: false });
        if (ideas.length > 500) ideas = ideas.slice(-500);
        await redis(['SET', 'ideas', JSON.stringify(ideas)]);
        await sendWhatsApp(from, '💡 *Idea guardada*\n📌 ' + title + '\n🏷️ ' + cat + (next ? '\n➡️ ' + next : '') + '\n\nLa tienes en tu panel → 💡 Ideas');
        return res.status(200).send('ok');
      }
    }

    // 🎓 Maestro de Copy del DUEÑO: "copy: <borrador>" lo evalúa; "maestro: <pregunta>" enseña.
    const copyM = text && text.match(/^\s*copy\b[:,]?\s*([\s\S]*)$/i);
    const maestroM = text && text.match(/^\s*maestro\b[:,]?\s*([\s\S]*)$/i);
    if (HAS_REDIS && (copyM || maestroM)) {
      const owner = ((await redis(['GET', 'config:ownerphone'])) || process.env.WHAPE_OWNER_PHONE || '').replace(/\D/g, '');
      if (owner && from.replace(/\D/g, '') === owner) {
        const MASTER_SYS = 'Eres el "Maestro de Copy" de WHAPE: el consejo de los más grandes copywriters de la historia respondiendo por WhatsApp — Eugene Schwartz (el deseo no se crea, se canaliza; niveles de conciencia), Gary Halbert (escribe a UNA persona; el mercado hambriento), David Ogilvy (el titular es el 80%), Claude Hopkins (especificidad y prueba), Joe Sugarman (el tobogán: cada frase vende la siguiente), Robert Collier (entra a la conversación que ya ocurre en su mente), John Caples (testear > opinar), Gary Bencivenga (prueba > promesa). Tu alumno: Martín, dueño de WHAPE (Perú), plataforma que enseña a convertir problemas en negocios que venden por WhatsApp; su audiencia: peruanos cansados que pierden horas en el celular y quieren multiplicar el valor de su hora. Español peruano NEUTRO. Formato WhatsApp: compacto (máx ~12 líneas), usa *negritas*, ejemplos aplicados a SU negocio, y cita al maestro cuando enseñes un principio. Si pide ganchos o copys, entrégalos listos para usar. Sé exigente y directo, como buen maestro. NUNCA sugieras prometer ingresos garantizados.';
        let reply = '';
        if (copyM) {
          const draft = (copyM[1] || '').trim().slice(0, 3000);
          if (!draft) reply = '🥊 Mándame tu borrador así:\n"copy: [tu texto]"\n\nY te lo devuelvo con puntaje, error #1 y 2 variantes.';
          else {
            const out = await askAIRaw(MASTER_SYS, 'BORRADOR DEL ALUMNO:\n"""\n' + draft + '\n"""\n\nEvalúalo compacto para WhatsApp:\n📊 *Puntaje 1-10*: Gancho, Una idea, Especificidad, Emoción→lógica, CTA (una línea cada uno) + a qué nivel de conciencia habla (1-5).\n🔧 *Error #1* (máx 2 líneas).\n✍️ *Variante A* (mejora directa).\n🅱️ *Variante B* (otro ángulo).\n🧠 *Lección* (1 línea, citando al maestro).', 900);
            reply = out || '😮‍💨 El maestro tuvo un problema técnico. Intenta de nuevo en un momento.';
          }
        } else {
          const q = (maestroM[1] || '').trim().slice(0, 1000);
          if (!q) reply = '🎓 *Tus comandos, socio:*\n\n✍️ Copy:\n• "maestro: [pregunta/pedido]" — te enseño\n• "copy: [borrador]" — lo evalúo con 2 variantes\n\n💡 Ideas:\n• "idea: …" / "anota: …" — la clasifico y guardo\n\n🤝 Foco:\n• "hoy: [tarea]" — declara LA tarea del día\n• "logré: …" — cierra el día (racha 🔥)\n• "aprendí: …" — guarda la lección\n• "tarea: …" — suma al backlog\n• "foco" — tu estado\n• "debería: …" — el Guardián evalúa si es dispersión';
          else {
            const out = await askAIRaw(MASTER_SYS, q, 700);
            reply = out || '😮‍💨 El maestro tuvo un problema técnico. Intenta de nuevo en un momento.';
          }
        }
        await sendWhatsApp(from, reply.slice(0, 3900));
        return res.status(200).send('ok');
      }
    }

    // 🤝 El Socio (accountability del DUEÑO): hoy / logré / aprendí / tarea / foco / debería
    const socioHoy = text && text.match(/^\s*hoy\b[:,]?\s*([\s\S]*)$/i);
    const socioLog = text && text.match(/^\s*(?:logr[eé]|cumpl[ií])\b[:,]?\s*([\s\S]*)$/i);
    const socioApr = text && text.match(/^\s*aprend[ií]\b[:,]?\s*([\s\S]*)$/i);
    const socioTar = text && text.match(/^\s*tarea\b[:,]?\s*([\s\S]*)$/i);
    const socioFoco = text && /^\s*foco\s*$/i.test(text);
    const socioDeb = text && text.match(/^\s*¿?\s*deber[ií]a\b[:,]?\s*([\s\S]*)$/i);
    if (HAS_REDIS && (socioHoy || socioLog || socioApr || socioTar || socioFoco || socioDeb)) {
      const owner = ((await redis(['GET', 'config:ownerphone'])) || process.env.WHAPE_OWNER_PHONE || '').replace(/\D/g, '');
      if (owner && from.replace(/\D/g, '') === owner) {
        const hoyPeru = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
        const getJ = async (k, d) => { const r0 = await redis(['GET', k]); if (r0) { try { return JSON.parse(r0); } catch (e) {} } return d; };
        const today = hoyPeru();
        let reply = '';
        if (socioHoy) {
          const task = (socioHoy[1] || '').trim().slice(0, 300);
          if (!task) reply = '🎯 Dime tu tarea así: "hoy: [LA tarea que hace avanzar WHAPE]". Una sola.';
          else {
            await redis(['SET', 'foco', JSON.stringify({ date: today, task, declaredAt: Date.now(), done: false })]);
            const streak = Number((await redis(['GET', 'foco:streak'])) || 0);
            reply = '🎯 *Tarea del día registrada:*\n"' + task + '"\n\n🔥 Racha en juego: ' + streak + '\nA las 10 pm te pregunto cómo te fue. Sin excusas, socio. 🤝';
          }
        } else if (socioLog) {
          const f = await getJ('foco', null);
          if (!f || f.date !== today) reply = '🤔 Hoy no declaraste tarea. Dime "hoy: [tarea]" y arrancamos.';
          else if (f.done) reply = '✅ Hoy ya cerraste, socio. 🔥 Racha: ' + Number((await redis(['GET', 'foco:streak'])) || 0) + '\nSi aprendiste algo más: "aprendí: …"';
          else {
            f.done = true; f.result = (socioLog[1] || '').trim().slice(0, 500); f.doneAt = Date.now();
            await redis(['SET', 'foco', JSON.stringify(f)]);
            const streak = Number((await redis(['GET', 'foco:streak'])) || 0) + 1;
            await redis(['SET', 'foco:streak', String(streak)]);
            const hist = await getJ('foco:hist', []);
            hist.push({ date: today, task: f.task, done: true });
            await redis(['SET', 'foco:hist', JSON.stringify(hist.slice(-90))]);
            reply = '✅ *Día cumplido.* 🔥 Racha de foco: ' + streak + (streak === 1 ? ' día' : ' días') + '\n\n¿Qué te enseñó el día? "aprendí: …"\nDescansa: mañana a las 7am definimos la siguiente. 🤝';
          }
        } else if (socioApr) {
          const v = (socioApr[1] || '').trim().slice(0, 1000);
          if (!v) reply = '🧠 Dime el aprendizaje así: "aprendí: [la lección]".';
          else {
            const apr = await getJ('aprendizajes', []);
            apr.push({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: v, ts: Date.now() });
            await redis(['SET', 'aprendizajes', JSON.stringify(apr.slice(-500))]);
            reply = '🧠 *Aprendizaje #' + apr.length + ' guardado.*\nVa a tu panel (🎯 Foco) y a Obsidian en el próximo sync.';
          }
        } else if (socioTar) {
          const v = (socioTar[1] || '').trim().slice(0, 300);
          if (!v) reply = '📋 Suma un pendiente así: "tarea: [texto]". Para ver todo: "foco".';
          else {
            const tareas = await getJ('tareas', []);
            tareas.push({ id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: v, ts: Date.now() });
            await redis(['SET', 'tareas', JSON.stringify(tareas.slice(-100))]);
            reply = '📋 Pendiente guardado (#' + tareas.length + '). Recuerda: el backlog espera; tu tarea de HOY no. 🤝';
          }
        } else if (socioFoco) {
          const f = await getJ('foco', null);
          const streak = Number((await redis(['GET', 'foco:streak'])) || 0);
          const tareas = await getJ('tareas', []);
          const tt = tareas.slice(0, 5).map((t, i) => (i + 1) + ') ' + t.text).join('\n');
          reply = '🎯 *Tu foco*\n\n' + (f && f.date === today ? ((f.done ? '✅ ' : '⏳ ') + '"' + f.task + '"') : '⚠️ Sin tarea declarada hoy → "hoy: …"')
            + '\n🔥 Racha: ' + streak + (streak === 1 ? ' día' : ' días')
            + '\n\n📋 Pendientes (' + tareas.length + '):\n' + (tt || '(vacío)');
        } else if (socioDeb) {
          const q = (socioDeb[1] || '').trim().slice(0, 800);
          if (!q) reply = '⚖️ Pregúntame así: "debería: [la nueva idea/proyecto/curso que te tienta]" y te respondo como socio.';
          else {
            const f = await getJ('foco', null);
            const GUARD_SYS = 'Eres "El Socio", el accountability partner implacable de Martín, dueño de WHAPE. Su compromiso declarado: enfocarse EXCLUSIVAMENTE en desarrollar WHAPE (comunidad + academia + CRM + bot de WhatsApp) hasta que despegue. Tu ÚNICO trabajo es proteger ese foco de la dispersión. Cuando pregunte si "debería" hacer algo, evalúa con honestidad brutal: ¿esto avanza WHAPE ESTA SEMANA o es dispersión disfrazada de oportunidad? Responde corto para WhatsApp (máx 8 líneas): VEREDICTO (✅ Avanza WHAPE / ⚠️ Puede esperar / ❌ Dispersión) + por qué en 2-3 líneas + qué hacer ahora. Si es dispersión: dile que la guarde con "idea:" y vuelva a su tarea. Directo, cálido y firme. Español peruano neutro.';
            const out = await askAIRaw(GUARD_SYS, 'Su tarea de hoy: ' + (f && f.date === today ? '"' + f.task + '"' : '(no declarada)') + '\n\nMe pregunta: ¿debería ' + q + '?', 400);
            reply = out || '😮‍💨 El Socio tuvo un problema técnico. Intenta de nuevo.';
          }
        }
        await sendWhatsApp(from, reply.slice(0, 3900));
        return res.status(200).send('ok');
      }
    }

    let lead = null;
    if (HAS_REDIS) {
      lead = await getLead(from);
      const isNewLead = !lead.messages || lead.messages.length === 0;
      const prevStatus = lead.status || 'nuevo';
      if (isNewLead && !lead.source) lead.source = detectSource(text); // de dónde vino
      if (profileName && !lead.name) lead.name = profileName; // no pisar el nombre puesto a mano
      const entry = { role: 'user', text: text || caption || '[adjunto: ' + msg.type + ']', ts: Date.now() };
      if (media && media.id) entry.media = media;
      lead.messages.push(entry);
      lead.status = autoStatus(lead.status, text, text === null); // clasifica solo (solo avanza)
      if (text && text.toLowerCase().indexOf('(academia)') >= 0) { // vino desde la academia: etiqueta
        if (!lead.tags) lead.tags = [];
        if (lead.tags.indexOf('academia') < 0) lead.tags.push('academia');
      }
      if (text) { // caminos de la landing conversacional: Premium (pago) vs Gratis
        const lt = text.toLowerCase();
        if (lt.indexOf('(premium)') >= 0) {
          if (!lead.tags) lead.tags = [];
          if (lead.tags.indexOf('premium') < 0) lead.tags.push('premium');
          if (lead.status === 'nuevo') lead.status = 'interesado'; // intención de compra: avanza el embudo
        }
        if (lt.indexOf('(gratis)') >= 0) {
          if (!lead.tags) lead.tags = [];
          if (lead.tags.indexOf('gratis') < 0) lead.tags.push('gratis');
        }
      }

      // Avisos a tu WhatsApp personal
      const who = lead.name || ('+' + from);
      if (isNewLead) {
        const preview = text || ('(envió ' + msg.type + ')');
        await notifyOwner('🆕 *Nuevo lead* en WHAPE\n👤 ' + who + ' (+' + from + ')\n💬 "' + preview + '"\n\nÉchale un vistazo 👉 whape.club/panel', from);
      } else if (lead.status === 'pago_pendiente' && prevStatus !== 'pago_pendiente') {
        await notifyOwner('💸 *' + who + '* pasó a PAGO PENDIENTE (mandó comprobante o dijo que pagó).\nVerifica el pago 👉 whape.club/panel', from);
      }
    }

    // Mensaje que no es texto (imagen/audio/etc.) — suele ser el comprobante de pago
    if (text === null) {
      if (!lead || !lead.paused) {
        const isImg = msg.type === 'image' || msg.type === 'document';
        const ack = isImg
          ? '¡Gracias! 🙌 Recibí tu archivo. Lo reviso y te confirmo en breve.'
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

    // ¿Pidió desbloquear un módulo de la academia? (botón del club) -> respuesta FIJA y desbloqueo automático.
    const unlockMatch = text && text.match(/\(unlock:([a-z0-9]+)\)/i);
    if (unlockMatch) {
      if (HAS_REDIS) {
        await redis(['SADD', 'unlocked:' + from, unlockMatch[1]]);
        if (!lead.tags) lead.tags = [];
        if (lead.tags.indexOf('academia') < 0) lead.tags.push('academia');
      }
      const ack = '¡Listo! 🔓 Desbloqueé ese módulo en tu academia. Vuelve a abrirla y ya lo verás disponible. 🎓\n\nCualquier duda, escríbeme por aquí. 🙌';
      await sendWhatsApp(from, ack);
      if (HAS_REDIS) { lead.messages.push({ role: 'assistant', text: ack, ts: Date.now() }); await saveLead(lead); }
      return res.status(200).send('ok');
    }

    // ¿Pidió recuperar su contraseña de la academia? (botón del login) -> genera y envía un código.
    if (text && /\(recuperar\)/i.test(text) && HAS_REDIS) {
      const mr = await redis(['GET', 'member:' + from]);
      let ack;
      if (!mr) {
        ack = 'No encontré una cuenta de la comunidad con este número 🤔. Si aún no te registras, hazlo en whape.club/academia.';
      } else {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await redis(['SET', 'reset:' + from, JSON.stringify({ code, exp: Date.now() + 30 * 60 * 1000 })]);
        ack = '🔑 Tu código para cambiar la contraseña es: *' + code + '*\n\nPégalo en la página (válido 30 minutos). Si no fuiste tú, ignora este mensaje.';
      }
      await sendWhatsApp(from, ack);
      lead.messages.push({ role: 'assistant', text: ack, ts: Date.now() }); await saveLead(lead);
      return res.status(200).send('ok');
    }

    // ¿Pidió desbloquear "a mano" (texto libre, sin el botón)? Identificamos el módulo y lo desbloqueamos solos.
    if (HAS_REDIS && text && /desbloqu|abrir el (nivel|m[oó]dulo)|acceso al (nivel|m[oó]dulo)|ver el (nivel|m[oó]dulo)/i.test(text)) {
      try {
        const raw = await redis(['GET', 'academy:modules']);
        let mods = []; if (raw) { try { mods = JSON.parse(raw); } catch (e) {} }
        const norm = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nmsg = norm(text);
        const numAsked = (nmsg.match(/(?:nivel|modulo)\s*(\d{1,2})/) || [])[1];
        const matches = (mods || []).filter((m) => m && m.lockWa).filter((m) => {
          const t = norm(m.title).trim();
          if (!t) return false;
          if (new RegExp('(^|[^a-z0-9])' + escRe(t) + '([^a-z0-9]|$)').test(nmsg)) return true;
          if (numAsked && new RegExp('(nivel|modulo)\\s*' + numAsked + '(\\D|$)').test(t)) return true;
          return false;
        });
        let ack;
        if (matches.length === 1) {
          const mod = matches[0];
          const has = Number((await redis(['SISMEMBER', 'unlocked:' + from, mod.id])) || 0);
          if (!has) await redis(['SADD', 'unlocked:' + from, mod.id]);
          if (!lead.tags) lead.tags = [];
          if (lead.tags.indexOf('academia') < 0) lead.tags.push('academia');
          ack = has
            ? '¡Ese módulo ya lo tienes desbloqueado! 🙂 Ábrelo en tu academia: whape.club/academia'
            : ('¡Listo! 🔓 Desbloqueé *' + (mod.title || 'el módulo') + '* en tu academia. Ábrela y ya lo verás: whape.club/academia 🎓');
        } else {
          ack = 'Para desbloquear un módulo, entra a tu academia 👉 whape.club/academia, abre el que quieres y toca el botón verde *"🔓 Desbloquear por WhatsApp"*. Eso me avisa y lo activo al toque. 🙌';
        }
        await sendWhatsApp(from, ack);
        lead.messages.push({ role: 'assistant', text: ack, ts: Date.now() });
        await saveLead(lead);
        return res.status(200).send('ok');
      } catch (e) { console.error('unlock freetext', e); }
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
