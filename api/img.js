// Sirve las imágenes subidas a la Academia. GET /api/img?id=imgXXXX
// Lee el data URL guardado en Redis (img:<id>) y devuelve la imagen binaria.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

module.exports = async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).send('Sin base de datos');
  const id = ((req.query && req.query.id) || '').toString();
  if (!/^img[a-zA-Z0-9]+$/.test(id)) return res.status(400).send('id inválido');
  try {
    const raw = await redis(['GET', 'img:' + id]);
    if (!raw) return res.status(404).send('No encontrada');
    const m = String(raw).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (!m) return res.status(500).send('Dato corrupto');
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(buf);
  } catch (e) {
    console.error('img error', e);
    return res.status(500).send('Error');
  }
};
