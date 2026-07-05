// Cron diario de Vercel (7am Perú): dispara recordatorios vencidos y vigila las misiones.
// También puede llamarlo un cron externo con ?key=<CRON_SECRET>.

const { flushDueReminders } = require('./_reminders');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const GRAPH = 'https://graph.facebook.com/v21.0';

// Normaliza el formato al de WhatsApp (negrita con un solo asterisco; sin Markdown ** ni asteriscos sueltos).
function waFormat(s) {
  if (!s) return s;
  let t = String(s);
  t = t.replace(/\*\*\*([^\n]+?)\*\*\*/g, '*$1*');
  t = t.replace(/\*\*([^\n]+?)\*\*/g, '*$1*');
  t = t.replace(/__([^\n]+?)__/g, '*$1*');
  t = t.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, '*$1*');
  t = t.replace(/^(\s*)[*-]\s+/gm, '$1• ');
  t = t.split('\n').map((line) => {
    if (((line.match(/\*/g) || []).length) % 2 === 1) line = line.replace(/\*(?=[^*]*$)/, '');
    return line;
  }).join('\n');
  return t;
}

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
      body: JSON.stringify({ messaging_product: 'whatsapp', to: owner, type: 'text', text: { body: waFormat(text) } }),
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
    // guarda el historial (lo lee el puente a Obsidian)
    const rraw = await redis(['GET', 'radars']);
    let rlist = []; if (rraw) { try { rlist = JSON.parse(rraw); } catch (e) {} }
    rlist.push({ date: wkKey, title: g.title || '', text: out });
    if (rlist.length > 12) rlist = rlist.slice(-12);
    await redis(['SET', 'radars', JSON.stringify(rlist)]);
    return true;
  } catch (e) { console.error('weeklyRadar', e); return false; }
}

// 🤝 El Socio (accountability partner): apertura del día (mañana) y cierre (noche, ~10pm Perú).
async function getJ(key, dft) { const raw = await redis(['GET', key]); if (raw) { try { return JSON.parse(raw); } catch (e) {} } return dft; }
function hoyPeru() { return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10); }

async function socio() {
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return '';
    if ((await redis(['GET', 'config:socio'])) === '0') return '';
    const peruHour = new Date(Date.now() - 5 * 3600000).getUTCHours();
    const today = hoyPeru();
    if (peruHour < 12) { // APERTURA (corre con el cron de las 7am)
      if ((await redis(['GET', 'socio:am'])) === today) return '';
      const f = await getJ('foco', null);
      let streak = Number((await redis(['GET', 'foco:streak'])) || 0);
      if (f && f.date && f.date !== today) { // cierre de ayer no resuelto
        if (!f.done) {
          streak = 0; await redis(['SET', 'foco:streak', '0']);
          const tareas = await getJ('tareas', []);
          tareas.push({ id: 't' + Date.now().toString(36), text: f.task, ts: Date.now() });
          await redis(['SET', 'tareas', JSON.stringify(tareas.slice(-100))]);
        }
        await redis(['DEL', 'foco']);
      }
      const pend = (await getJ('tareas', [])).slice(0, 3);
      const pendTxt = pend.length ? ('\n\n📋 Pendientes:\n' + pend.map((t, i) => (i + 1) + ') ' + t.text).join('\n')) : '';
      await notifyOwner('🤝 *El Socio — apertura del día*\n\n🔥 Racha de foco: ' + streak + (streak === 1 ? ' día' : ' días') + '\n\n¿Cuál es LA tarea que hace avanzar WHAPE hoy?\nRespóndeme: *"hoy: [tu tarea]"*' + pendTxt);
      await redis(['SET', 'socio:am', today]);
      return 'am';
    }
    if (peruHour >= 18) { // CIERRE (corre con el cron de las 10pm)
      if ((await redis(['GET', 'socio:pm'])) === today) return '';
      const f = await getJ('foco', null);
      const streak = Number((await redis(['GET', 'foco:streak'])) || 0);
      let msg;
      if (f && f.date === today && f.done) msg = '🌙 *El Socio — cierre del día*\n\n✅ Hoy cumpliste: "' + f.task + '"\n🔥 Racha: ' + streak + '\n\n¿Qué te enseñó el día? *"aprendí: …"*\nDescansa, socio. Mañana seguimos. 🤝';
      else if (f && f.date === today) msg = '🌙 *El Socio — cierre del día*\n\nTu tarea era: *"' + f.task + '"*\n\n¿La lograste? Respóndeme *"logré: [qué pasó]"* para proteger tu racha 🔥' + streak + '\nY si el día te enseñó algo: *"aprendí: …"*';
      else msg = '🌙 *El Socio — cierre del día*\n\nHoy no declaraste tarea. Sin tarea declarada no hay foco que proteger.\nMañana a las 7am te espero: *"hoy: [tu tarea]"*. 🔥 Racha en juego: ' + streak;
      await notifyOwner(msg);
      await redis(['SET', 'socio:pm', today]);
      return 'pm';
    }
    return '';
  } catch (e) { console.error('socio', e); return ''; }
}

// 🧭 Chequeo de foco: pregunta de orientación en las horas de dispersión (3,4,5,6,9 pm Perú).
// Abre una "sesión socrática": las respuestas del dueño las atiende el coach en whatsapp.js.
const REFOCUS_HOURS = [15, 16, 17, 18, 21];
const REFOCUS_QS = [
  '¿Qué estás haciendo AHORA MISMO… y eso acerca o aleja a WHAPE?',
  'Si WHAPE fuera tu único cliente, ¿qué le estarías entregando en esta hora?',
  '¿Qué es lo ÚNICO que, si lo haces hoy, hará que el día haya valido la pena?',
  'Del 1 al 10, ¿qué tan enfocado estás en este momento? ¿Qué te robó la atención?',
  '¿Tu yo de dentro de 1 año está orgulloso de lo que estás haciendo justo ahora?',
  '¿Qué harías en esta hora si supieras que la cohorte depende SOLO de ella?',
  'Para 10 segundos: ¿cuál era tu tarea de hoy y qué le falta para estar cumplida?',
  'En este momento, ¿estás creando o consumiendo?',
  '¿Qué pendiente pequeño de WHAPE cabe en los próximos 25 minutos?',
  '¿Qué te diría tu Socio si viera tu pantalla ahora mismo?',
];
async function refocusPing() {
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return false;
    if ((await redis(['GET', 'config:refocus'])) === '0') return false;
    const peru = new Date(Date.now() - 5 * 3600000);
    const h = peru.getUTCHours();
    if (REFOCUS_HOURS.indexOf(h) < 0) return false;
    const slot = peru.toISOString().slice(0, 10) + 'T' + h;
    if ((await redis(['GET', 'refocus:ping'])) === slot) return false; // ya se envió este slot
    const doy = Math.floor((peru - new Date(Date.UTC(peru.getUTCFullYear(), 0, 0))) / 86400000);
    const q = REFOCUS_QS[(doy + h) % REFOCUS_QS.length];
    const f = await getJ('foco', null);
    const taskTxt = (f && f.date === hoyPeru() && !f.done) ? ('\n\n🎯 Tu tarea de hoy sigue en juego: "' + f.task + '"') : '';
    await notifyOwner('🧭 *Chequeo de foco — ' + (h > 12 ? (h - 12) + ' pm' : h + ' am') + '*\n\n' + q + taskTxt + '\n\nRespóndeme con honestidad, socio. (Para cortar: "listo")');
    await redis(['SET', 'refocus:ping', slot]);
    await redis(['SET', 'refocus', JSON.stringify({ slot, active: true, startedAt: Date.now(), turns: [{ role: 'socio', t: q }] })]);
    return true;
  } catch (e) { console.error('refocusPing', e); return false; }
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
    else if (tipo === 1) msg = '🏋️ *Gimnasio del Copy — 10 ganchos (7 min)*\n\nTema de hoy: *' + tema + '*\n\nEscribe 10 ganchos distintos (una línea cada uno). Los primeros 5 saldrán malos; el oro vive del 6 al 10.\n\nRespóndeme aquí: "maestro: mis 10 ganchos…" y te los corrijo. 🎓';
    else msg = '🏋️ *Gimnasio del Copy — Reescritura (6 min)*\n\nToma UN mensaje real que enviaste ayer (CRM, plantilla o post) y reescríbelo aplicando UNA ley: especificidad (Hopkins) o una-sola-persona (Halbert).\n\nRespóndeme aquí: "copy: [tu versión]" y te la evalúo. 🥊';
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
    const socioR = await socio();
    const refocus = await refocusPing();
    return res.status(200).json({ ok: true, fired, risk, radar, gym, socio: socioR, refocus });
  } catch (e) {
    console.error('cron error', e);
    return res.status(500).json({ error: 'Error' });
  }
};
