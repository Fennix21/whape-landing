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

async function askAI(system, user, maxTok) {
  if (!process.env.ANTHROPIC_API_KEY) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.WHAPE_AI_MODEL || 'claude-haiku-4-5-20251001', max_tokens: maxTok || 500, system, messages: [{ role: 'user', content: user }] }),
    });
    const data = await r.json();
    if (!r.ok) { console.error('askAI', JSON.stringify(data)); return ''; }
    return ((data.content && data.content[0] && data.content[0].text) || '').trim();
  } catch (e) { console.error('askAI', e); return ''; }
}

// Radar semanal (lunes, hora Perú): la IA resume la semana del grupo y sugiere UNA acción.
async function weeklyRadar() {
  try {
    if (!REDIS_URL || !REDIS_TOKEN || !process.env.ANTHROPIC_API_KEY) return false;
    const peru = new Date(Date.now() - 5 * 3600000);
    if (peru.getUTCDay() !== 1) return false; // solo lunes
    const wkKey = peru.toISOString().slice(0, 10);
    if ((await redis(['GET', 'radar:last'])) === wkKey) return false; // ya se envió esta semana
    let groups = [];
    const raw = await redis(['GET', 'config:groups']);
    if (raw) { try { groups = JSON.parse(raw); } catch (e) {} }
    const g = (Array.isArray(groups) && groups.find((x) => x.active)) || (groups && groups[0]);
    if (!g) return false;
    const day = cohortDay(g.cohortStart);
    if (day < 2) return false; // recién hay algo que resumir desde la primera semana
    // Datos de la semana: miembros y posts del grupo
    const phones = (await redis(['SMEMBERS', 'members'])) || [];
    let joined = 0, risky = 0, grads = 0, checkinsWeek = 0;
    if (phones.length) {
      const graws = (await redis(['MGET', ...phones.map((p) => 'gstate:' + p)])) || [];
      graws.forEach((r) => {
        if (!r) return; let st; try { st = JSON.parse(r); } catch (e) { return; }
        if (st.groupId !== g.id) return;
        joined++;
        if (st.riskDay) risky++;
        if (st.graduated) grads++;
        Object.keys(st.checkins || {}).forEach((d) => { if (Number(d) > day - 8) checkinsWeek++; });
      });
    }
    if (!joined) return false;
    const ids = (await redis(['SMEMBERS', 'community:posts'])) || [];
    let postsTxt = [];
    if (ids.length) {
      const raws = (await redis(['MGET', ...ids.map((id) => 'post:' + id)])) || [];
      const weekAgo = Date.now() - 7 * 86400000;
      raws.forEach((r) => {
        if (!r) return; let p; try { p = JSON.parse(r); } catch (e) { return; }
        if (p.cat !== 'g:' + g.id || p.ts < weekAgo) return;
        postsTxt.push((p.name || 'Miembro') + ': ' + (p.title ? p.title + ' — ' : '') + (p.body || '').slice(0, 200));
      });
      postsTxt = postsTxt.slice(-30);
    }
    const sys = 'Eres el analista de una comunidad peruana de emprendedores. Español peruano neutro, directo, sin relleno.';
    const usr = 'Misión "' + (g.title || '') + '", día ' + day + ' de ' + (g.duration || 21) + '.\nMiembros en misión: ' + joined + ' · check-ins esta semana: ' + checkinsWeek + ' · en riesgo: ' + risky + ' · graduados: ' + grads + '\n\nPublicaciones de la semana:\n' + (postsTxt.length ? postsTxt.join('\n') : '(no hubo publicaciones)') + '\n\nDame un radar semanal para el dueño en máximo 10 líneas: 1) pulso del grupo en una frase, 2) obstáculos comunes que se mencionan, 3) a quién felicitar públicamente y por qué, 4) UNA acción concreta para esta semana. Sin encabezados largos, usa viñetas cortas.';
    const out = await askAI(sys, usr, 500);
    if (!out) return false;
    await notifyOwner('🧠 *Radar semanal — ' + (g.title || 'tu misión') + '*\n\n' + out);
    await redis(['SET', 'radar:last', wkKey]);
    return true;
  } catch (e) { console.error('weeklyRadar', e); return false; }
}

// Gimnasio del Copy: un reto diario al WhatsApp del dueño (rota 3 ejercicios y 10 temas).
async function dailyGym() {
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return false;
    if ((await redis(['GET', 'config:gym'])) === '0') return false;
    const peru = new Date(Date.now() - 5 * 3600000);
    const key = peru.toISOString().slice(0, 10);
    if ((await redis(['GET', 'gym:last'])) === key) return false;
    const doy = Math.floor((peru - new Date(Date.UTC(peru.getUTCFullYear(), 0, 0))) / 86400000);
    const TEMAS = [
      'el espejo: cuánto le pagas al mes a las apps con tu vida',
      'la trampa de la recompensa variable (el casino de bolsillo)',
      'por qué la fuerza de voluntad siempre pierde',
      'el bloque de 30 minutos que construye tu negocio',
      'tu celular como empleado (consumo vs creación)',
      'el valor de tu hora (dejar de cobrar por hora)',
      'la cohorte de 21 días: solo 100 cupos',
      'de consumidor a creador (cambio de identidad)',
      'lo que cambia en una persona en 21 días',
      'el entorno correcto multiplica tu energía',
    ];
    const tema = TEMAS[doy % TEMAS.length];
    const tipo = doy % 3;
    let msg;
    if (tipo === 0) msg = '🏋️ *Gimnasio del Copy — Copywork (7 min)*\n\nHoy: copia A MANO (papel y lapicero) un copy que te haya vendido algo, o tu mejor pieza propia (el hero de whape.club, la clase 1 de "Dueño de tu Atención").\n\nLa mano le enseña el ritmo al cerebro. ✍️';
    else if (tipo === 1) msg = '🏋️ *Gimnasio del Copy — 10 ganchos (7 min)*\n\nTema de hoy: *' + tema + '*\n\nEscribe 10 ganchos distintos (una línea cada uno). Los primeros 5 saldrán malos; el oro vive del 6 al 10.\n\nGuarda el mejor en tu 📂 Archivo (panel → ✍️ Copy).';
    else msg = '🏋️ *Gimnasio del Copy — Reescritura (6 min)*\n\nToma UN mensaje real que enviaste ayer (CRM, plantilla o post) y reescríbelo aplicando UNA ley: especificidad (Hopkins) o una-sola-persona (Halbert).\n\nPásalo por tu 🥊 Entrenador (panel → ✍️ Copy) y compara.';
    await notifyOwner(msg);
    await redis(['SET', 'gym:last', key]);
    return true;
  } catch (e) { console.error('dailyGym', e); return false; }
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
    const radar = await weeklyRadar();
    const gym = await dailyGym();
    return res.status(200).json({ ok: true, fired, risk, radar, gym });
  } catch (e) {
    console.error('cron error', e);
    return res.status(500).json({ error: 'Error' });
  }
};
