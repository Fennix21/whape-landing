// Proxy para VER los adjuntos (comprobantes) de WhatsApp dentro del panel.
// WhatsApp no manda la imagen directa: manda un "media id" y hay que pedir su URL
// y descargarla con el token (por eso no se puede poner en un <img> normal).
//   GET /api/media?id=<media_id>&pass=<WHAPE_ADMIN_PASS>
// Devuelve el binario de la imagen/archivo con su content-type.

const GRAPH = 'https://graph.facebook.com/v21.0';

module.exports = async (req, res) => {
  const id = req.query && req.query.id;
  const pass = req.query && req.query.pass;
  if (pass !== process.env.WHAPE_ADMIN_PASS) return res.status(401).send('No autorizado');
  if (!id) return res.status(400).send('Falta id');

  try {
    const token = process.env.WHATSAPP_TOKEN;
    // 1) Pedir la URL temporal del medio
    const metaRes = await fetch(`${GRAPH}/${id}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!metaRes.ok) return res.status(502).send('No se pudo obtener el medio');
    const meta = await metaRes.json();
    if (!meta.url) return res.status(404).send('Medio no disponible (puede haber expirado).');

    // 2) Descargar el binario (la URL exige el token en el header)
    const fileRes = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + token } });
    if (!fileRes.ok) return res.status(502).send('No se pudo descargar el medio');
    const buf = Buffer.from(await fileRes.arrayBuffer());

    res.setHeader('Content-Type', meta.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).send(buf);
  } catch (e) {
    console.error('media error', e);
    return res.status(500).send('Error');
  }
};
