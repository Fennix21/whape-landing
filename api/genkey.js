// Función serverless de Vercel: genera la clave de activación de WHAPE.
// El SECRETO vive en variables de entorno (NUNCA en el navegador):
//   WHAPE_SECRET      -> el mismo secreto del app (LicenseManager.kt)
//   WHAPE_ADMIN_PASS  -> contraseña que solo tú conoces
// Debe producir la MISMA clave que la app: HMAC-SHA256(secret, codigoCanonico)
// -> primeros 10 bytes -> Base32 (alfabeto Crockford) -> 16 caracteres.

const crypto = require('crypto');
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

module.exports = (req, res) => {
  const secret = process.env.WHAPE_SECRET;
  const adminPass = process.env.WHAPE_ADMIN_PASS;
  if (!secret || !adminPass) {
    res.status(500).json({ error: 'Falta configurar WHAPE_SECRET o WHAPE_ADMIN_PASS en Vercel.' });
    return;
  }

  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const pass = (src.pass || '').toString();
  const code = (src.code || '').toString();

  if (pass !== adminPass) {
    res.status(401).json({ error: 'Contraseña incorrecta.' });
    return;
  }

  const canonical = code.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (canonical.length < 6) {
    res.status(400).json({ error: 'Código de equipo inválido.' });
    return;
  }

  const mac = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest();
  const key = base32(mac.subarray(0, 10));
  const pretty = key.match(/.{1,4}/g).join('-');
  res.status(200).json({ key: pretty });
};
