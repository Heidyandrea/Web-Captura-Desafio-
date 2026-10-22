// API de conversiones de Meta — recibe PageView y Lead desde la landing y los reenvía desde el servidor.
// Requiere en Vercel la variable de entorno META_CAPI_TOKEN (y opcional META_TEST_CODE para "Probar eventos").
const PIXEL_ID = '1490857044727030';
const ALLOWED = ['PageView', 'Lead'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return res.status(204).end();

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  if (!ALLOWED.includes(b.event_name) || !b.event_id) return res.status(400).end();

  let host = '';
  try { host = new URL(b.event_source_url).hostname; } catch (e) {}
  if (!host.endsWith('englishwithheidy.com')) return res.status(403).end();

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const user_data = { client_ip_address: ip, client_user_agent: req.headers['user-agent'] || '' };
  if (b.fbp) user_data.fbp = String(b.fbp);
  if (b.fbc) user_data.fbc = String(b.fbc);

  const payload = {
    data: [{
      event_name: b.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: String(b.event_id),
      action_source: 'website',
      event_source_url: b.event_source_url,
      user_data,
      custom_data: (b.custom_data && typeof b.custom_data === 'object') ? b.custom_data : {}
    }]
  };
  if (process.env.META_TEST_CODE) payload.test_event_code = process.env.META_TEST_CODE;

  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!r.ok) console.error('CAPI', r.status, await r.text());
  } catch (e) { console.error('CAPI error', e); }
  return res.status(200).json({ ok: true });
};
