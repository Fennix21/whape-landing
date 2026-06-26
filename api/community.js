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

    if (b.action === 'me') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo. 🙏' });
      const raw = await redis(['GET', 'member:' + phone]);
      let m = null; if (raw) { try { m = JSON.parse(raw); } catch (e) {} }
      return res.status(200).json({ ok: true, name: m ? m.name : '', phone });
    }

    // ---------- MIEMBRO: academia + progreso ----------
    if (b.action === 'academy') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo. 🙏' });
      const rawmods = await getModules();
      const progress = await getProgress(phone);
      const mraw = await redis(['GET', 'member:' + phone]);
      let name = '', joinedAt = 0; if (mraw) { try { const mm = JSON.parse(mraw); name = mm.name || ''; joinedAt = mm.createdAt || 0; } catch (e) {} }
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
      return res.status(200).json({ ok: true, modules, progress, name, club: { groupLink, waText, waNumber: '51983427614' } });
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

    // ---------- ADMIN ----------
    if (b.action === 'admin') {
      if ((b.pass || '') !== process.env.WHAPE_ADMIN_PASS) return res.status(401).json({ error: 'Contraseña incorrecta.' });
      const sub = b.sub;
      let mods = await getModules();

      if (sub === 'tree') {
        const members = Number((await redis(['SCARD', 'members'])) || 0);
        const groupLink = (await redis(['GET', 'config:club_grouplink'])) || '';
        const waText = (await redis(['GET', 'config:club_watext'])) || DEFAULT_WA_TEXT;
        return res.status(200).json({ ok: true, modules: mods, members, groupLink, waText });
      }
      if (sub === 'setcfg') {
        const gl = (b.groupLink || '').toString().slice(0, 300);
        const wt = (b.waText || '').toString().slice(0, 600);
        await redis(['SET', 'config:club_grouplink', gl]);
        await redis(['SET', 'config:club_watext', wt || DEFAULT_WA_TEXT]);
        return res.status(200).json({ ok: true, groupLink: gl, waText: wt || DEFAULT_WA_TEXT });
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
      return res.status(400).json({ error: 'Sub-acción no válida.' });
    }

    return res.status(400).json({ error: 'Acción no válida.' });
  } catch (e) {
    console.error('community error', e);
    return res.status(500).json({ error: 'Error del servidor.' });
  }
};
