// Comunidad WHAPE: registro/login de miembros + feed de contenido de valor.
// Stack: función serverless de Vercel + Upstash Redis (sin servicios nuevos).
// Acciones (POST { action }):
//   signup {name, phone, password}  -> crea miembro + lo mete como lead al CRM
//   login  {phone, password}        -> devuelve token
//   me     {token}                  -> datos del miembro
//   feed   {token}                  -> lista de publicaciones
//   admin  {pass, sub}              -> gestión de contenido desde el panel (WHAPE_ADMIN_PASS)
//          sub: list | save {post} | del {id}

const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const SECRET = process.env.WHAPE_SECRET || 'whape-dev-secret';

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

// Normaliza el número: solo dígitos; si es un celular peruano de 9 dígitos, antepone 51.
function normPhone(p) {
  let d = (p || '').replace(/\D/g, '');
  if (d.length === 9 && d[0] === '9') d = '51' + d;
  return d;
}
function hashPw(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
}
function makeToken(phone) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000; // 30 días
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

// Sinergia con el CRM: cada miembro nuevo entra como lead "interesado" con tag comunidad.
async function upsertLead(phone, name) {
  try {
    const raw = await redis(['GET', 'lead:' + phone]);
    let l = null;
    if (raw) { try { l = JSON.parse(raw); } catch (e) {} }
    if (!l) {
      l = { phone, name: name || '', status: 'interesado', paused: false, source: 'comunidad',
        messages: [{ role: 'user', text: '(se registró en la Comunidad WHAPE 🎉)', ts: Date.now() }], tags: ['comunidad'] };
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!HAS_REDIS) return res.status(500).json({ error: 'Falta configurar la base de datos (Redis).' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  try {
    if (b.action === 'signup') {
      const name = (b.name || '').toString().trim().slice(0, 60);
      const phone = normPhone(b.phone);
      const pw = (b.password || '').toString();
      if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre.' });
      if (phone.length < 9) return res.status(400).json({ error: 'Escribe un número de WhatsApp válido.' });
      if (pw.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
      if (await redis(['GET', 'member:' + phone])) return res.status(400).json({ error: 'Ese número ya está registrado. Inicia sesión. 🙂' });
      const salt = crypto.randomBytes(12).toString('hex');
      const member = { name, phone, salt, hash: hashPw(pw, salt), createdAt: Date.now() };
      await redis(['SET', 'member:' + phone, JSON.stringify(member)]);
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

    if (b.action === 'me' || b.action === 'feed') {
      const phone = verifyToken(b.token);
      if (!phone) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo. 🙏' });
      if (b.action === 'me') {
        const raw = await redis(['GET', 'member:' + phone]);
        let m = null; if (raw) { try { m = JSON.parse(raw); } catch (e) {} }
        return res.status(200).json({ ok: true, name: m ? m.name : '', phone });
      }
      const raw = await redis(['GET', 'community:posts']);
      let posts = []; if (raw) { try { posts = JSON.parse(raw); } catch (e) {} }
      posts.sort((a, b2) => (b2.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b2.ts || 0) - (a.ts || 0));
      return res.status(200).json({ ok: true, posts });
    }

    // --- Gestión de contenido desde el panel (admin) ---
    if (b.action === 'admin') {
      if ((b.pass || '') !== process.env.WHAPE_ADMIN_PASS) return res.status(401).json({ error: 'Contraseña incorrecta.' });
      const sub = b.sub;
      const raw = await redis(['GET', 'community:posts']);
      let posts = []; if (raw) { try { posts = JSON.parse(raw); } catch (e) {} }

      if (sub === 'list') {
        const members = (await redis(['SCARD', 'members'])) || 0;
        return res.status(200).json({ ok: true, posts, members: Number(members) });
      }
      if (sub === 'save') {
        const p = b.post || {};
        const post = {
          id: p.id || ('p' + Date.now()),
          title: (p.title || '').toString().slice(0, 140),
          body: (p.body || '').toString().slice(0, 6000),
          video: (p.video || '').toString().slice(0, 300),
          image: (p.image || '').toString().slice(0, 300),
          pinned: !!p.pinned,
          ts: p.ts || Date.now(),
        };
        if (!post.title && !post.body) return res.status(400).json({ error: 'La publicación necesita título o texto.' });
        const idx = posts.findIndex((x) => x.id === post.id);
        if (idx >= 0) posts[idx] = post; else posts.unshift(post);
        await redis(['SET', 'community:posts', JSON.stringify(posts.slice(0, 200))]);
        return res.status(200).json({ ok: true, posts });
      }
      if (sub === 'del') {
        posts = posts.filter((x) => x.id !== b.id);
        await redis(['SET', 'community:posts', JSON.stringify(posts)]);
        return res.status(200).json({ ok: true, posts });
      }
      return res.status(400).json({ error: 'Sub-acción no válida.' });
    }

    return res.status(400).json({ error: 'Acción no válida.' });
  } catch (e) {
    console.error('community error', e);
    return res.status(500).json({ error: 'Error del servidor.' });
  }
};
