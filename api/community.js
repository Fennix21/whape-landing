// Academia/Comunidad WHAPE: miembros + estructura de curso (módulos → clases) + progreso.
// Stack: función serverless de Vercel + Upstash Redis.
//
// Datos en Redis:
//   member:<phone>     -> {name, phone, salt, hash, createdAt}
//   members            -> SET de phones
//   academy:modules    -> [{id,title,desc,image, lessons:[{id,title,body,video,image}]}]
//   progress:<phone>   -> {done:{lessonId:true}, last:lessonId, updatedAt}
//
// Acciones (POST { action }):
//   signup / login / me                 (miembro)
//   academy {token}                     -> módulos + progreso del miembro
//   complete {token, lessonId, done}    -> marca/desmarca clase completada
//   seen {token, lessonId}              -> recuerda la última clase vista
//   admin {pass, sub}                   -> gestión (WHAPE_ADMIN_PASS)
//       sub: tree | savemod{mod} | delmod{id} | savelesson{moduleId,lesson} | dellesson{moduleId,lessonId}

const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const SECRET = process.env.WHAPE_SECRET || 'whape-dev-secret';
const DEFAULT_WA_TEXT = '¡Hola! 🎓 Vengo de la Comunidad WHAPE y quiero recibir novedades y soporte por aquí. (academia)';
const GRAPH = 'https://graph.facebook.com/v21.0';
const FB_TYPES = ['pregunta', 'duda', 'comentario', 'sugerencia', 'interes'];
const DEFAULT_FB_LABELS = { pregunta: '❓ Pregunta', duda: '🤔 Duda', comentario: '💬 Comentario', sugerencia: '💡 Sugerencia', interes: '🛒 Quiero comprar' };
const DEFAULT_EMAIL_PROMPT = '📧 Déjanos tu correo para poder recuperar tu contraseña si la olvidas, y recibir accesos y bonos especiales antes que nadie. ¡Es opcional pero muy recomendado!';
// Comunidad estilo Skool: umbrales de puntos por nivel (1-9) y categorías por defecto.
const COMMUNITY_LEVELS = [0, 5, 20, 65, 155, 515, 2015, 8015, 33015];
const DEFAULT_CATS = [
  { id: 'general', label: '💬 General' },
  { id: 'presentate', label: '👋 Preséntate' },
  { id: 'preguntas', label: '❓ Preguntas' },
  { id: 'logros', label: '🏆 Logros' },
  { id: 'recursos', label: '📚 Recursos' },
];

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

function normPhone(p) {
  let d = (p || '').replace(/\D/g, '');
  if (d.length === 9 && d[0] === '9') d = '51' + d;
  return d;
}
function hashPw(pw, salt) { return crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex'); }
function makeToken(phone) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const sig = crypto.createHmac('sha256', SECRET).update('tok:' + phone + ':' + exp).digest('hex').slice(0, 32);
  return phone + '.' + exp + '.' + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const phone = parts[0], exp = parts[1], sig = parts[2];
  if (Number(exp) < Date.now()) return null;
  const good = crypto.createHmac('sha256', SECRET).update('tok:' + phone + ':' + exp).digest('hex').slice(0, 32);
  return good === sig ? phone : null;
}
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// --- Comunidad (feed estilo Skool) ---
function levelFromPoints(pts) {
  let lvl = 1;
  for (let i = 0; i < COMMUNITY_LEVELS.length; i++) { if ((pts || 0) >= COMMUNITY_LEVELS[i]) lvl = i + 1; }
  return lvl;
}
async function getCats() {
  const raw = await redis(['GET', 'config:community_cats']);
  if (raw) { try { const c = JSON.parse(raw); if (Array.isArray(c) && c.length) return c; } catch (e) {} }
  return DEFAULT_CATS;
}
async function getPosts() {
  const ids = (await redis(['SMEMBERS', 'community:posts'])) || [];
  if (!ids.length) return [];
  const raws = (await redis(['MGET', ...ids.map((id) => 'post:' + id)])) || [];
  const out = [];
  raws.forEach((r) => { if (r) { try { out.push(JSON.parse(r)); } catch (e) {} } });
  return out;
}
async function loadPost(id) {
  const raw = await redis(['GET', 'post:' + id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function savePost(p) { await redis(['SET', 'post:' + p.id, JSON.stringify(p)]); }
async function bumpPoints(phone, delta) {
  const raw = await redis(['GET', 'member:' + phone]);
  if (!raw) return;
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  m.points = Math.max(0, (m.points || 0) + delta);
  await redis(['SET', 'member:' + phone, JSON.stringify(m)]);
}
function publicPost(p, phone, levelMap) {
  levelMap = levelMap || {};
  return {
    id: p.id, name: p.name, avatar: p.avatar || '',
    authorLevel: levelFromPoints(levelMap[p.phone] || 0),
    cat: p.cat || 'general', title: p.title || '', body: p.body || '',
    ts: p.ts, pinned: !!p.pinned,
    likeCount: (p.likedBy || []).length,
    liked: (p.likedBy || []).indexOf(phone) >= 0,
    comments: (p.comments || []).map((c) => ({ id: c.id, name: c.name, avatar: c.avatar || '', body: c.body, ts: c.ts, level: levelFromPoints(levelMap[c.phone] || 0), mine: c.phone === phone })),
    commentCount: (p.comments || []).length,
    mine: p.phone === phone,
    pending: !p.approved,
  };
}

async function getModules() {
  const raw = await redis(['GET', 'academy:modules']);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return [];
}
async function saveModules(mods) { await redis(['SET', 'academy:modules', JSON.stringify(mods)]); }
async function getProgress(phone) {
  const raw = await redis(['GET', 'progress:' + phone]);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return { done: {}, last: '' };
}
async function getComments(lessonId) {
  const raw = await redis(['GET', 'comments:' + lessonId]);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return [];
}
async function getRating(lessonId) {
  const raw = await redis(['GET', 'rating:' + lessonId]);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return { votes: {} };
}
function ratingSummary(r, phone) {
  const votes = (r && r.votes) || {};
  const vals = Object.keys(votes).map((k) => Number(votes[k]));
  const count = vals.length;
  const sum = vals.reduce((a, b) => a + b, 0);
  return { mine: votes[phone] || 0, avg: count ? Math.round((sum / count) * 10) / 10 : 0, count };
}

async function upsertLead(phone, name) {
  try {
    const raw = await redis(['GET', 'lead:' + phone]);
    let l = null;
    if (raw) { try { l = JSON.parse(raw); } catch (e) {} }
    if (!l) {
      l = { phone, name: name || '', status: 'interesado', paused: false, source: 'comunidad',
        messages: [{ role: 'system', text: '🎉 Se registró en la Comunidad WHAPE (desde la web, no por WhatsApp).', ts: Date.now() }], tags: ['comunidad'] };
    } else {
      if (name && !l.name) l.name = name;
      if (!l.tags) l.tags = [];
      if (l.tags.indexOf('comunidad') < 0) l.tags.push('comunidad');
    }
    l.updatedAt = Date.now();
    await redis(['SET', 'lead:' + phone, JSON.stringify(l)]);
    await redis(['ZADD', 'leads', String(l.updatedAt), phone]);
  } catch (e) { console.error('upsertLead', e); }
}

// Aviso al WhatsApp personal del dueño (mismo criterio que los avisos de leads).
async function notifyOwner(text, fromPhone) {
  try {
    if ((await redis(['GET', 'config:notify'])) === '0') return;
    const owner = ((await redis(['GET', 'config:ownerphone'])) || process.env.WHAPE_OWNER_PHONE || '').replace(/\D/g, '');
    if (!owner) return;
    if (fromPhone && fromPhone.replace(/\D/g, '') === owner) return;
    await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: owner, type: 'text', text: { body: text } }),
    });
  } catch (e) { console.error('notifyOwner', e); }
}
async function getFbLabels() {
  const raw = await redis(['GET', 'config:fblabels']);
  let l = {}; if (raw) { try { l = JSON.parse(raw); } catch (e) {} }
  return Object.assign({}, DEFAULT_FB_LABELS, l);
}
// Envía el correo con el código de recuperación usando Resend (necesita RESEND_API_KEY + RESEND_FROM en Vercel).
async function sendResetEmail(to, code, name) {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) { console.error('Falta RESEND_API_KEY'); return false; }
    const from = process.env.RESEND_FROM || 'Comunidad WHAPE <onboarding@resend.dev>';
    const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1b1430">'
      + '<h2 style="margin:0 0 12px">Recuperar contraseña</h2>'
      + '<p>Hola ' + (name || '') + ',</p>'
      + '<p>Tu código para cambiar la contraseña de la <b>Comunidad WHAPE</b> es:</p>'
      + '<div style="font-size:30px;font-weight:bold;letter-spacing:6px;background:#f3f0fb;padding:16px;text-align:center;border-radius:10px;margin:14px 0">' + code + '</div>'
      + '<p style="color:#777;font-size:13px">Válido por 30 minutos. Si no fuiste tú, ignora este correo.</p></div>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: 'Tu código para recuperar tu contraseña 🔑', html }),
    });
    if (!r.ok) console.error('Resend error', await r.text());
    return r.ok;
  } catch (e) { console.error('sendResetEmail', e); return false; }
}

// Limpia un módulo/clase recibidos del panel (evita basura).
function cleanLesson(p) {
  return {
    id: p.id || newId('l'),
    title: (p.title || '').toString().slice(0, 160),
    body: (p.body || '').toString().slice(0, 8000),
    video: (p.video || '').toString().slice(0, 300),
    image: (p.image || '').toString().slice(0, 300),
  };
}
function cleanModule(p) {
  return {
    id: p.id || newId('m'),
    title: (p.title || '').toString().slice(0, 120),
    desc: (p.desc || '').toString().slice(0, 400),
    image: (p.image || '').toString().slice(0, 300),
    lockDays: Math.max(0, parseInt(p.lockDays, 10) || 0),
    lockWa: !!p.lockWa,
    lessons: Array.isArray(p.lessons) ? p.lessons.map(cleanLesson) : [],
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!HAS_REDIS) return res.status(500).json({ error: 'Falta configurar la base de datos (Redis).' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  try {
    // ---------- AUTH ----------
    if (b.action === 'signup') {
      const name = (b.name || '').toString().trim().slice(0, 60);
      const phone = normPhone(b.phone);
      const pw = (b.password || '').toString();
      if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre.' });
      if (phone.length < 9) return res.status(400).json({ error: 'Escribe un número de WhatsApp válido.' });
      if (pw.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
      if (await redis(['GET', 'member:' + phone])) return res.status(400).json({ error: 'Ese número ya está registrado. Inicia sesión. 🙂' });
      const salt = crypto.randomBytes(12).toString('hex');
      await redis(['SET', 'member:' + phone, JSON.stringify({ name, phone, salt, hash: hashPw(pw, salt), createdAt: Date.now() })]);
      await redis(['SADD', 'members', phone]);
      await upsertLead(phone, name);
      return res.status(200).json({ ok: true, token: makeToken(phone), name });
    }

    if (b.action === 'login') {
      const phone = normPhone(b.phone);
      const pw = (b.password || '').toString();
      const raw = await redis(['GET', 'member:' + phone]);
      if (!raw) return res.status(401).json({ error: 'No encontramos ese número. ¿Ya te registraste?' });
      let m; try { m = JSON.parse(raw); } catch (e) { return res.status(500).json({ error: 'Error de datos.' }); }
      if (hashPw(pw, m.salt) !== m.hash) return res.status(401).json({ error: 'Contraseña incorrecta.' });
      return res.status(200).json({ ok: true, token: makeToken(phone), name: m.name });
    }

    if (b.action === 'resetpw') {
      let phone = '';
      if (b.email) { phone = (await redis(['GET', 'memberemail:' + (b.email || '').toString().trim().toLowerCase()])) || ''; }
      else { phone = normPhone(b.phone); }
      if (!phone) return res.status(400).json({ error: 'No encontramos una cuenta con esos datos.' });
      const code = (b.code || '').toString().trim();
      const pw = (b.password || '').toString();
      if (pw.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
      const rraw = await redis(['GET', 'reset:' + phone]);
      if (!rraw) return res.status(400).json({ error: 'No hay un código pendiente para ese número. Pide uno nuevo por WhatsApp.' });
      let rd; try { rd = JSON.parse(rraw); } catch (e) { return res.status(400).json({ error: 'Error con el código.' }); }
      if (!rd.exp || rd.exp < Date.now()) { await redis(['DEL', 'reset:' + phone]); return res.status(400).json({ error: 'El código venció. Pide uno nuevo.' }); }
      if (String(rd.code) !== code) return res.status(400).json({ error: 'Código incorrecto.' });
      const mraw = await redis(['GET', 'member:' + phone]);
      if (!mraw) return res.status(400).json({ error: 'No existe una cuenta con ese número.' });
      let m; try { m = JSON.parse(mraw); } catch (e) { return res.status(500).json({ error: 'Error de datos.' }); }
      const salt = crypto.randomBytes(12).toString('hex');
      m.salt = salt; m.hash = hashPw(pw, salt);
      await redis(['SET', 'member:' + phone, JSON.stringify(m)]);
      await redis(['DEL', 'reset:' + phone]);
      return res.status(200).json({ ok: true, token: makeToken(phone), name: m.name || '' });
    }

    if (b.action === 'forgotemail') {
      const email = (b.email || '').toString().trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Pon un correo válido.' });
      const phone = await redis(['GET', 'memberemail:' + email]);
      if (phone) {
        const mraw = await redis(['GET', 'member:' + phone]);
        if (mraw) {
          let nm = ''; try { nm = JSON.parse(mraw).name || ''; } catch (e) {}
          const code = String(Math.floor(100000 + Math.random() * 900000));
          await redis(['SET', 'reset:' + phone, JSON.stringify({ code, exp: Date.now() + 30 * 60 * 1000 })]);
          await sendResetEmail(email, code, nm);
        }
      }
      return res.status(200).json({ ok: true }); // no revelamos si el correo existe (seguridad)
    }

    if (b.action === 'me') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo. 🙏' });
      const raw = await redis(['GET', 'member:' + phone]);
      let m = null; if (raw) { try { m = JSON.parse(raw); } catch (e) {} }
      return res.status(200).json({ ok: true, name: m ? m.name : '', phone, email: m ? (m.email || '') : '', avatar: m ? (m.avatar || '') : '' });
    }

    // ---------- MIEMBRO: academia + progreso ----------
    if (b.action === 'academy') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo. 🙏' });
      const rawmods = await getModules();
      const progress = await getProgress(phone);
      const mraw = await redis(['GET', 'member:' + phone]);
      let name = '', joinedAt = 0, email = '', avatar = ''; if (mraw) { try { const mm = JSON.parse(mraw); name = mm.name || ''; joinedAt = mm.createdAt || 0; email = mm.email || ''; avatar = mm.avatar || ''; } catch (e) {} }
      const now = Date.now();
      const unlocked = (await redis(['SMEMBERS', 'unlocked:' + phone])) || [];
      const unlockedSet = {}; unlocked.forEach((x) => { unlockedSet[x] = true; });
      const modules = rawmods.map((m) => { // oculta el contenido de los módulos bloqueados (drip o WhatsApp)
        const lockDays = Number(m.lockDays || 0);
        const unlockAt = (lockDays > 0 && joinedAt) ? joinedAt + lockDays * 86400000 : 0;
        if (unlockAt && now < unlockAt) return { id: m.id, title: m.title, desc: m.desc, image: m.image, locked: true, lockType: 'drip', unlockAt, lessons: [] };
        if (m.lockWa && !unlockedSet[m.id]) return { id: m.id, title: m.title, desc: m.desc, image: m.image, locked: true, lockType: 'wa', unlockAt: 0, lessons: [] };
        return Object.assign({}, m, { locked: false, unlockAt: 0 });
      });
      const groupLink = (await redis(['GET', 'config:club_grouplink'])) || '';
      const waText = (await redis(['GET', 'config:club_watext'])) || DEFAULT_WA_TEXT;
      const fblabels = await getFbLabels();
      const emailPrompt = (await redis(['GET', 'config:emailpopup'])) || DEFAULT_EMAIL_PROMPT;
      let notif = 0;
      try { const ir = await redis(['GET', 'academy:inbox']); if (ir) { const ibx = JSON.parse(ir); notif = ibx.filter((x) => x.phone === phone && x.reply && !x.seenByMember).length; } } catch (e) {}
      return res.status(200).json({ ok: true, modules, progress, name, email, avatar, emailPrompt, fblabels, notif, club: { groupLink, waText, waNumber: '51983427614' } });
    }

    if (b.action === 'complete') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo.' });
      const lessonId = (b.lessonId || '').toString();
      if (!lessonId) return res.status(400).json({ error: 'Falta la clase.' });
      const p = await getProgress(phone);
      if (!p.done) p.done = {};
      if (b.done === false) delete p.done[lessonId]; else p.done[lessonId] = true;
      p.last = lessonId;
      p.updatedAt = Date.now();
      await redis(['SET', 'progress:' + phone, JSON.stringify(p)]);
      return res.status(200).json({ ok: true, progress: p });
    }

    if (b.action === 'seen') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const lessonId = (b.lessonId || '').toString();
      const p = await getProgress(phone);
      p.last = lessonId; p.updatedAt = Date.now();
      await redis(['SET', 'progress:' + phone, JSON.stringify(p)]);
      return res.status(200).json({ ok: true });
    }

    // ---------- MIEMBRO: comentarios + calificación por clase ----------
    if (b.action === 'lesson') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const lessonId = (b.lessonId || '').toString();
      const comments = await getComments(lessonId);
      const r = await getRating(lessonId);
      return res.status(200).json({ ok: true, comments, rating: ratingSummary(r, phone) });
    }
    if (b.action === 'comment') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const lessonId = (b.lessonId || '').toString();
      const text = (b.text || '').toString().trim().slice(0, 1000);
      if (!lessonId || !text) return res.status(400).json({ error: 'Escribe tu comentario.' });
      const mraw = await redis(['GET', 'member:' + phone]);
      let name = ''; if (mraw) { try { name = JSON.parse(mraw).name || ''; } catch (e) {} }
      let comments = await getComments(lessonId);
      comments.push({ id: newId('c'), phone, name, text, ts: Date.now() });
      if (comments.length > 500) comments = comments.slice(-500);
      await redis(['SET', 'comments:' + lessonId, JSON.stringify(comments)]);
      return res.status(200).json({ ok: true, comments });
    }
    if (b.action === 'delcomment') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const lessonId = (b.lessonId || '').toString();
      let comments = await getComments(lessonId);
      comments = comments.filter((c) => !(c.id === b.commentId && c.phone === phone));
      await redis(['SET', 'comments:' + lessonId, JSON.stringify(comments)]);
      return res.status(200).json({ ok: true, comments });
    }
    if (b.action === 'rate') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const lessonId = (b.lessonId || '').toString();
      const value = Math.max(1, Math.min(5, parseInt(b.value, 10) || 0));
      if (!lessonId || !value) return res.status(400).json({ error: 'Falta la valoración.' });
      const r = await getRating(lessonId);
      if (!r.votes) r.votes = {};
      r.votes[phone] = value;
      await redis(['SET', 'rating:' + lessonId, JSON.stringify(r)]);
      return res.status(200).json({ ok: true, rating: ratingSummary(r, phone) });
    }

    if (b.action === 'feedback') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo.' });
      const type = FB_TYPES.indexOf((b.type || '').toString()) >= 0 ? b.type : 'comentario';
      const text = (b.text || '').toString().trim().slice(0, 2000);
      if (!text) return res.status(400).json({ error: 'Escribe tu mensaje.' });
      const lessonId = (b.lessonId || '').toString();
      let lessonTitle = '', moduleTitle = '';
      const mods = await getModules();
      for (const m of mods) { const l = (m.lessons || []).find((x) => x.id === lessonId); if (l) { lessonTitle = l.title || ''; moduleTitle = m.title || ''; break; } }
      const mraw = await redis(['GET', 'member:' + phone]);
      let name = ''; if (mraw) { try { name = JSON.parse(mraw).name || ''; } catch (e) {} }
      const raw = await redis(['GET', 'academy:inbox']);
      let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
      inbox.unshift({ id: newId('f'), lessonId, lessonTitle, moduleTitle, phone, name, type, text, ts: Date.now(), read: false });
      if (inbox.length > 500) inbox = inbox.slice(0, 500);
      await redis(['SET', 'academy:inbox', JSON.stringify(inbox)]);
      // tag al lead para tu CRM
      try { const lr = await redis(['GET', 'lead:' + phone]); if (lr) { const ld = JSON.parse(lr); if (!ld.tags) ld.tags = []; if (ld.tags.indexOf('academia') < 0) ld.tags.push('academia'); if (type === 'interes' && ld.tags.indexOf('interés-academia') < 0) ld.tags.push('interés-academia'); await redis(['SET', 'lead:' + phone, JSON.stringify(ld)]); } } catch (e) {}
      // aviso a tu WhatsApp
      const labels = await getFbLabels();
      const label = labels[type] || type;
      await notifyOwner('📥 Nuevo *' + label + '* en tu academia\n👤 ' + (name || ('+' + phone)) + '\n📚 ' + (lessonTitle || '(clase)') + '\n💬 "' + text.slice(0, 250) + '"\n\nMíralo en tu Bandeja 👉 whape.club/panel', phone);
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'myfeedback') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const lessonId = (b.lessonId || '').toString();
      const raw = await redis(['GET', 'academy:inbox']);
      let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
      const items = inbox.filter((x) => x.phone === phone && (!lessonId || x.lessonId === lessonId))
        .map((x) => ({ id: x.id, type: x.type, text: x.text, ts: x.ts, read: !!x.read, reply: x.reply || '', repliedAt: x.repliedAt || 0 }));
      return res.status(200).json({ ok: true, items });
    }

    if (b.action === 'setemail') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const email = (b.email || '').toString().trim().toLowerCase().slice(0, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Pon un correo válido.' });
      const mraw = await redis(['GET', 'member:' + phone]);
      if (!mraw) return res.status(400).json({ error: 'No existe la cuenta.' });
      let m; try { m = JSON.parse(mraw); } catch (e) { return res.status(500).json({ error: 'Error de datos.' }); }
      m.email = email;
      await redis(['SET', 'member:' + phone, JSON.stringify(m)]);
      await redis(['SET', 'memberemail:' + email, phone]); // índice para futura recuperación por correo
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'updateprofile') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const mraw = await redis(['GET', 'member:' + phone]);
      if (!mraw) return res.status(400).json({ error: 'No existe la cuenta.' });
      let m; try { m = JSON.parse(mraw); } catch (e) { return res.status(500).json({ error: 'Error.' }); }
      const name = (b.name || '').toString().trim().slice(0, 60);
      if (name.length >= 2) m.name = name;
      if (typeof b.email === 'string') {
        const email = b.email.trim().toLowerCase().slice(0, 120);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Correo no válido.' });
        if (email !== (m.email || '')) {
          if (m.email) { try { await redis(['DEL', 'memberemail:' + m.email]); } catch (e) {} }
          m.email = email;
          if (email) await redis(['SET', 'memberemail:' + email, phone]);
        }
      }
      await redis(['SET', 'member:' + phone, JSON.stringify(m)]);
      return res.status(200).json({ ok: true, name: m.name || '', email: m.email || '' });
    }

    if (b.action === 'setavatar') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const dataUrl = (b.dataUrl || '').toString();
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) return res.status(400).json({ error: 'Imagen no válida.' });
      if (dataUrl.length > 1200000) return res.status(400).json({ error: 'La imagen pesa demasiado.' });
      const id = newId('img');
      await redis(['SET', 'img:' + id, dataUrl]);
      const url = '/api/img?id=' + id;
      const mraw = await redis(['GET', 'member:' + phone]);
      let m = {}; if (mraw) { try { m = JSON.parse(mraw); } catch (e) {} }
      m.avatar = url;
      await redis(['SET', 'member:' + phone, JSON.stringify(m)]);
      return res.status(200).json({ ok: true, avatar: url });
    }

    if (b.action === 'changepw') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const pw = (b.password || '').toString();
      if (pw.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
      const mraw = await redis(['GET', 'member:' + phone]);
      if (!mraw) return res.status(400).json({ error: 'No existe la cuenta.' });
      let m; try { m = JSON.parse(mraw); } catch (e) { return res.status(500).json({ error: 'Error.' }); }
      const salt = crypto.randomBytes(12).toString('hex');
      m.salt = salt; m.hash = hashPw(pw, salt);
      await redis(['SET', 'member:' + phone, JSON.stringify(m)]);
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'notifications') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const raw = await redis(['GET', 'academy:inbox']);
      let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
      const items = inbox.filter((x) => x.phone === phone && x.reply)
        .map((x) => ({ id: x.id, type: x.type, text: x.text, reply: x.reply, repliedAt: x.repliedAt || 0, lessonId: x.lessonId, lessonTitle: x.lessonTitle, seen: !!x.seenByMember }));
      return res.status(200).json({ ok: true, items, unseen: items.filter((x) => !x.seen).length });
    }

    if (b.action === 'marknotifseen') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const raw = await redis(['GET', 'academy:inbox']);
      let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
      let changed = false;
      inbox.forEach((x) => { if (x.phone === phone && x.reply && !x.seenByMember && (b.id === '*' || x.id === b.id)) { x.seenByMember = true; changed = true; } });
      if (changed) await redis(['SET', 'academy:inbox', JSON.stringify(inbox)]);
      return res.status(200).json({ ok: true });
    }

    // ---------- COMUNIDAD (feed estilo Skool) ----------
    if (b.action === 'feed') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo. 🙏' });
      const cats = await getCats();
      let posts = await getPosts();
      const cat = (b.cat || '').toString();
      if (cat && cat !== 'all') posts = posts.filter((p) => (p.cat || 'general') === cat);
      posts = posts.filter((p) => p.approved || p.phone === phone); // solo lo aprobado (o tus propios posts en revisión)
      const want = {}; want[phone] = 1;
      posts.forEach((p) => { want[p.phone] = 1; (p.comments || []).forEach((c) => { want[c.phone] = 1; }); });
      const plist = Object.keys(want);
      const levelMap = {};
      const mraws = (await redis(['MGET', ...plist.map((p) => 'member:' + p)])) || [];
      plist.forEach((p, i) => { let pts = 0; if (mraws[i]) { try { pts = JSON.parse(mraws[i]).points || 0; } catch (e) {} } levelMap[p] = pts; });
      const sort = (b.sort || 'recent').toString();
      posts.sort((a, c) => {
        if (!!a.pinned !== !!c.pinned) return a.pinned ? -1 : 1;
        if (sort === 'top') return ((c.likedBy || []).length - (a.likedBy || []).length) || (c.ts - a.ts);
        return c.ts - a.ts;
      });
      const out = posts.map((p) => publicPost(p, phone, levelMap));
      const myPoints = levelMap[phone] || 0;
      return res.status(200).json({ ok: true, posts: out, cats, me: { points: myPoints, level: levelFromPoints(myPoints) } });
    }

    if (b.action === 'feedpost') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo. 🙏' });
      const title = (b.title || '').toString().trim().slice(0, 140);
      const body = (b.body || '').toString().trim().slice(0, 4000);
      const cat = (b.cat || 'general').toString().slice(0, 40);
      if (!body && !title) return res.status(400).json({ error: 'Escribe algo para publicar.' });
      const mraw = await redis(['GET', 'member:' + phone]);
      let name = '', avatar = ''; if (mraw) { try { const mm = JSON.parse(mraw); name = mm.name || ''; avatar = mm.avatar || ''; } catch (e) {} }
      const p = { id: newId('p'), phone, name, avatar, cat, title, body, ts: Date.now(), pinned: false, approved: false, likedBy: [], comments: [] };
      await savePost(p);
      const ptype = await redis(['TYPE', 'community:posts']);
      if (ptype && ptype !== 'set' && ptype !== 'none') await redis(['DEL', 'community:posts']); // auto-repara si la clave quedó con tipo equivocado
      await redis(['SADD', 'community:posts', p.id]);
      await notifyOwner('📝 *Nueva publicación* en la comunidad (pendiente de aprobar)\n👤 ' + (name || ('+' + phone)) + '\n🏷️ ' + cat + (title ? ('\n📌 ' + title) : '') + '\n💬 "' + body.slice(0, 250) + '"\n\nApruébala o recházala 👉 whape.club/panel (🗣️ Feed)', phone);
      return res.status(200).json({ ok: true, id: p.id, pending: true });
    }

    if (b.action === 'feeddel') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const p = await loadPost((b.id || '').toString());
      if (!p) return res.status(404).json({ error: 'Esa publicación ya no existe.' });
      if (p.phone !== phone) return res.status(403).json({ error: 'Solo puedes borrar tus propias publicaciones.' });
      await redis(['DEL', 'post:' + p.id]);
      await redis(['SREM', 'community:posts', p.id]);
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'feedlike') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const p = await loadPost((b.id || '').toString());
      if (!p) return res.status(404).json({ error: 'Esa publicación ya no existe.' });
      p.likedBy = p.likedBy || [];
      const i = p.likedBy.indexOf(phone);
      let liked;
      if (i >= 0) { p.likedBy.splice(i, 1); liked = false; if (p.phone !== phone) await bumpPoints(p.phone, -1); }
      else { p.likedBy.push(phone); liked = true; if (p.phone !== phone) await bumpPoints(p.phone, 1); }
      await savePost(p);
      return res.status(200).json({ ok: true, liked, likeCount: p.likedBy.length });
    }

    if (b.action === 'feedcomment') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const body = (b.body || '').toString().trim().slice(0, 2000);
      if (!body) return res.status(400).json({ error: 'Escribe un comentario.' });
      const p = await loadPost((b.id || '').toString());
      if (!p) return res.status(404).json({ error: 'Esa publicación ya no existe.' });
      const mraw = await redis(['GET', 'member:' + phone]);
      let name = '', avatar = '', pts = 0; if (mraw) { try { const mm = JSON.parse(mraw); name = mm.name || ''; avatar = mm.avatar || ''; pts = mm.points || 0; } catch (e) {} }
      p.comments = p.comments || [];
      const c = { id: newId('c'), phone, name, avatar, body, ts: Date.now() };
      p.comments.push(c);
      await savePost(p);
      return res.status(200).json({ ok: true, comment: { id: c.id, name: c.name, avatar: c.avatar, body: c.body, ts: c.ts, level: levelFromPoints(pts), mine: true } });
    }

    if (b.action === 'feedcommentdel') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const p = await loadPost((b.postId || '').toString());
      if (!p) return res.status(404).json({ error: 'Esa publicación ya no existe.' });
      const cid = (b.commentId || '').toString();
      const c = (p.comments || []).find((x) => x.id === cid);
      if (!c) return res.status(404).json({ error: 'Ese comentario ya no existe.' });
      if (c.phone !== phone && p.phone !== phone) return res.status(403).json({ error: 'No puedes borrar este comentario.' });
      p.comments = (p.comments || []).filter((x) => x.id !== cid);
      await savePost(p);
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'leaderboard') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció.' });
      const phones = (await redis(['SMEMBERS', 'members'])) || [];
      const rows = [];
      if (phones.length) {
        const mraws = (await redis(['MGET', ...phones.map((p) => 'member:' + p)])) || [];
        mraws.forEach((r) => { if (r) { try { const m = JSON.parse(r); rows.push({ phone: m.phone, name: m.name || '', avatar: m.avatar || '', points: m.points || 0 }); } catch (e) {} } });
      }
      rows.sort((a, c) => c.points - a.points);
      const myRank = rows.findIndex((r) => r.phone === phone) + 1;
      const myPts = (rows.find((r) => r.phone === phone) || {}).points || 0;
      const top = rows.slice(0, 30).map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar, points: r.points, level: levelFromPoints(r.points), me: r.phone === phone }));
      return res.status(200).json({ ok: true, top, myRank, total: rows.length, me: { points: myPts, level: levelFromPoints(myPts) } });
    }

    // ---------- ADMIN ----------
    if (b.action === 'admin') {
      if ((b.pass || '') !== process.env.WHAPE_ADMIN_PASS) return res.status(401).json({ error: 'Contraseña incorrecta.' });
      const sub = b.sub;
      let mods = await getModules();

      if (sub === 'tree') {
        const members = Number((await redis(['SCARD', 'members'])) || 0);
        const groupLink = (await redis(['GET', 'config:club_grouplink'])) || '';
        const waText = (await redis(['GET', 'config:club_watext'])) || DEFAULT_WA_TEXT;
        const emailPopup = (await redis(['GET', 'config:emailpopup'])) || DEFAULT_EMAIL_PROMPT;
        return res.status(200).json({ ok: true, modules: mods, members, groupLink, waText, emailPopup });
      }
      if (sub === 'setcfg') {
        const gl = (b.groupLink || '').toString().slice(0, 300);
        const wt = (b.waText || '').toString().slice(0, 600);
        const ep = (b.emailPopup || '').toString().slice(0, 500);
        await redis(['SET', 'config:club_grouplink', gl]);
        await redis(['SET', 'config:club_watext', wt || DEFAULT_WA_TEXT]);
        await redis(['SET', 'config:emailpopup', ep || DEFAULT_EMAIL_PROMPT]);
        return res.status(200).json({ ok: true, groupLink: gl, waText: wt || DEFAULT_WA_TEXT, emailPopup: ep || DEFAULT_EMAIL_PROMPT });
      }
      if (sub === 'upload') {
        const dataUrl = (b.dataUrl || '').toString();
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) return res.status(400).json({ error: 'Formato de imagen no válido.' });
        if (dataUrl.length > 1200000) return res.status(400).json({ error: 'La imagen pesa demasiado. Usa una más liviana.' });
        const id = newId('img');
        await redis(['SET', 'img:' + id, dataUrl]);
        return res.status(200).json({ ok: true, url: '/api/img?id=' + id });
      }
      if (sub === 'comments') {
        const comments = await getComments((b.lessonId || '').toString());
        return res.status(200).json({ ok: true, comments });
      }
      if (sub === 'delcomment') {
        const lessonId = (b.lessonId || '').toString();
        let comments = await getComments(lessonId);
        comments = comments.filter((c) => c.id !== b.commentId); // el dueño borra cualquiera
        await redis(['SET', 'comments:' + lessonId, JSON.stringify(comments)]);
        return res.status(200).json({ ok: true, comments });
      }
      if (sub === 'academystats') {
        const phones = (await redis(['SMEMBERS', 'members'])) || [];
        const allLessons = [];
        mods.forEach((m) => (m.lessons || []).forEach((l) => allLessons.push(l.id)));
        const totalLessons = allLessons.length;
        const lessonCounts = {};
        const members = [];
        if (phones.length) {
          const memberRaws = (await redis(['MGET', ...phones.map((p) => 'member:' + p)])) || [];
          const progRaws = (await redis(['MGET', ...phones.map((p) => 'progress:' + p)])) || [];
          phones.forEach((phone, i) => {
            let mo = {}; try { mo = JSON.parse(memberRaws[i] || '{}') || {}; } catch (e) {}
            let prog = { done: {}, updatedAt: 0 }; try { prog = JSON.parse(progRaws[i] || 'null') || prog; } catch (e) {}
            const doneSet = prog.done || {};
            let doneCount = 0;
            allLessons.forEach((lid) => { if (doneSet[lid]) { doneCount++; lessonCounts[lid] = (lessonCounts[lid] || 0) + 1; } });
            members.push({ phone, name: mo.name || '', createdAt: mo.createdAt || 0, done: doneCount, total: totalLessons, pct: totalLessons ? Math.round(doneCount / totalLessons * 100) : 0, lastTs: prog.updatedAt || 0 });
          });
        }
        members.sort((a, b2) => b2.pct - a.pct || b2.lastTs - a.lastTs);
        const avgPct = members.length ? Math.round(members.reduce((s, m) => s + m.pct, 0) / members.length) : 0;
        return res.status(200).json({ ok: true, members, lessonCounts, totalMembers: members.length, totalLessons, avgPct, modules: mods });
      }
      if (sub === 'memberprogress') {
        const phone = (b.phone || '').toString();
        const praw = await redis(['GET', 'progress:' + phone]);
        let prog = { done: {}, last: '', updatedAt: 0 }; if (praw) { try { prog = JSON.parse(praw); } catch (e) {} }
        return res.status(200).json({ ok: true, done: prog.done || {}, last: prog.last || '', updatedAt: prog.updatedAt || 0 });
      }
      if (sub === 'inbox') {
        const raw = await redis(['GET', 'academy:inbox']);
        let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
        return res.status(200).json({ ok: true, inbox, unread: inbox.filter((x) => !x.read).length, fblabels: await getFbLabels() });
      }
      if (sub === 'inboxreply') {
        const raw = await redis(['GET', 'academy:inbox']);
        let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
        const it = inbox.find((x) => x.id === b.id);
        if (it) { it.reply = (b.reply || '').toString().slice(0, 2000); it.repliedAt = Date.now(); it.read = true; it.seenByMember = false; }
        await redis(['SET', 'academy:inbox', JSON.stringify(inbox)]);
        return res.status(200).json({ ok: true, inbox, unread: inbox.filter((x) => !x.read).length, fblabels: await getFbLabels() });
      }
      if (sub === 'setfblabels') {
        const incoming = b.labels || {};
        const labels = {};
        FB_TYPES.forEach((k) => { labels[k] = (incoming[k] || DEFAULT_FB_LABELS[k]).toString().slice(0, 40); });
        await redis(['SET', 'config:fblabels', JSON.stringify(labels)]);
        return res.status(200).json({ ok: true, fblabels: labels });
      }
      if (sub === 'inboxread') {
        const raw = await redis(['GET', 'academy:inbox']);
        let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
        if (b.id === '*') inbox.forEach((x) => { x.read = true; });
        else { const it = inbox.find((x) => x.id === b.id); if (it) it.read = b.read !== false; }
        await redis(['SET', 'academy:inbox', JSON.stringify(inbox)]);
        return res.status(200).json({ ok: true, inbox, unread: inbox.filter((x) => !x.read).length });
      }
      if (sub === 'inboxdel') {
        const raw = await redis(['GET', 'academy:inbox']);
        let inbox = []; if (raw) { try { inbox = JSON.parse(raw); } catch (e) {} }
        inbox = inbox.filter((x) => x.id !== b.id);
        await redis(['SET', 'academy:inbox', JSON.stringify(inbox)]);
        return res.status(200).json({ ok: true, inbox, unread: inbox.filter((x) => !x.read).length });
      }
      if (sub === 'savemod') {
        const incoming = b.mod || {};
        if (incoming.id) {
          const idx = mods.findIndex((m) => m.id === incoming.id);
          if (idx >= 0) { // editar (conserva las clases existentes)
            mods[idx].title = (incoming.title || '').toString().slice(0, 120);
            mods[idx].desc = (incoming.desc || '').toString().slice(0, 400);
            mods[idx].image = (incoming.image || '').toString().slice(0, 300);
            mods[idx].lockDays = Math.max(0, parseInt(incoming.lockDays, 10) || 0);
            mods[idx].lockWa = !!incoming.lockWa;
          }
        } else {
          mods.push(cleanModule(incoming));
        }
        await saveModules(mods);
        return res.status(200).json({ ok: true, modules: mods });
      }
      if (sub === 'delmod') {
        mods = mods.filter((m) => m.id !== b.id);
        await saveModules(mods);
        return res.status(200).json({ ok: true, modules: mods });
      }
      if (sub === 'savelesson') {
        const mod = mods.find((m) => m.id === b.moduleId);
        if (!mod) return res.status(400).json({ error: 'Módulo no encontrado.' });
        if (!Array.isArray(mod.lessons)) mod.lessons = [];
        const lesson = cleanLesson(b.lesson || {});
        if (!lesson.title && !lesson.video && !lesson.body) return res.status(400).json({ error: 'La clase necesita al menos título o video.' });
        const idx = mod.lessons.findIndex((l) => l.id === lesson.id);
        if (idx >= 0) mod.lessons[idx] = lesson; else mod.lessons.push(lesson);
        await saveModules(mods);
        return res.status(200).json({ ok: true, modules: mods });
      }
      if (sub === 'dellesson') {
        const mod = mods.find((m) => m.id === b.moduleId);
        if (mod && Array.isArray(mod.lessons)) mod.lessons = mod.lessons.filter((l) => l.id !== b.lessonId);
        await saveModules(mods);
        return res.status(200).json({ ok: true, modules: mods });
      }
      if (sub === 'feedlist') {
        const posts = await getPosts();
        posts.sort((a, c) => { if (!!a.approved !== !!c.approved) return a.approved ? 1 : -1; if (!!a.pinned !== !!c.pinned) return a.pinned ? -1 : 1; return c.ts - a.ts; });
        return res.status(200).json({ ok: true, cats: await getCats(), posts: posts.map((p) => ({ id: p.id, name: p.name, cat: p.cat, title: p.title, body: (p.body || ''), ts: p.ts, pinned: !!p.pinned, approved: !!p.approved, likes: (p.likedBy || []).length, comments: (p.comments || []).length })) });
      }
      if (sub === 'feeddel') {
        const id = (b.id || '').toString();
        await redis(['DEL', 'post:' + id]);
        await redis(['SREM', 'community:posts', id]);
        return res.status(200).json({ ok: true });
      }
      if (sub === 'feedpin') {
        const p = await loadPost((b.id || '').toString());
        if (!p) return res.status(404).json({ error: 'Esa publicación ya no existe.' });
        p.pinned = !p.pinned;
        await savePost(p);
        return res.status(200).json({ ok: true, pinned: p.pinned });
      }
      if (sub === 'feedapprove') {
        const p = await loadPost((b.id || '').toString());
        if (!p) return res.status(404).json({ error: 'Esa publicación ya no existe.' });
        p.approved = true;
        await savePost(p);
        return res.status(200).json({ ok: true });
      }
      if (sub === 'setcats') {
        let cats = b.cats;
        if (!Array.isArray(cats)) return res.status(400).json({ error: 'Categorías inválidas.' });
        cats = cats.filter((c) => c && c.id && c.label).slice(0, 20);
        await redis(['SET', 'config:community_cats', JSON.stringify(cats)]);
        return res.status(200).json({ ok: true, cats });
      }
      return res.status(400).json({ error: 'Sub-acción no válida.' });
    }

    return res.status(400).json({ error: 'Acción no válida.' });
  } catch (e) {
    console.error('community error', e);
    return res.status(500).json({ error: 'Error del servidor.' });
  }
};
