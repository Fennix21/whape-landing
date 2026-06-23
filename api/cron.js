// Endpoint que dispara los recordatorios vencidos.
// Lo llama el Cron de Vercel (respaldo) y puede llamarlo un cron externo (cron-job.org)
// con ?key=<CRON_SECRET> para mayor precisión. El panel también los dispara al refrescar.

const { flushDueReminders } = require('./_reminders');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const key = (req.query && req.query.key) || '';
    if (auth !== 'Bearer ' + secret && key !== secret) return res.status(401).send('No autorizado');
  }
  try {
    const fired = await flushDueReminders();
    return res.status(200).json({ ok: true, fired });
  } catch (e) {
    console.error('cron error', e);
    return res.status(500).json({ error: 'Error' });
  }
};
