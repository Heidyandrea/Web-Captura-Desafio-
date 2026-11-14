// /api/vip — recibe a quien calificó en /vip (vio la clase 3 + respondió el cuestionario):
//   1) guarda el contacto en systeme.io con nombre, WhatsApp y la etiqueta "VIP Calificado EWH"
//   2) envía el evento Lead a Meta (API de Conversiones) con correo, teléfono y nombre cifrados (SHA-256)
//   3) (opcional) reenvía el lead a un webhook de n8n
//   4) devuelve el enlace del grupo VIP — el enlace NO está en el HTML, solo sale de aquí
// Variables de entorno en Vercel:
//   SYSTEMIO_API_KEY   → la misma de /api/lead
//   SYSTEMIO_VIP_TAGS  → etiquetas separadas por coma (por defecto "General EWH,VIP Calificado EWH")
//   META_CAPI_TOKEN    → el mismo token de /api/event
//   VIP_WA_LINK        → (opcional) para cambiar el enlace del grupo sin tocar el código
//   VIP_WEBHOOK_URL    → (opcional) webhook de n8n para recibir cada lead VIP
const crypto = require('crypto');
const PIXEL_ID = '1490857044727030';
const SIO = 'https://api.systeme.io/api';
const VIP_WA = process.env.VIP_WA_LINK || 'https://chat.whatsapp.com/EtlER1QVteyKXe5XstvEng';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function sio(method, path, key, body, ctype) {
  const r = await fetch(SIO + path, {
    method,
    headers: Object.assign({ 'X-API-Key': key, Accept: 'application/json' },
      body ? { 'Content-Type': ctype || 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, data };
}

const tagCache = {};
async function tagId(name, key) {
  if (tagCache[name]) return tagCache[name];
  const q = await sio('GET', '/tags?query=' + encodeURIComponent(name), key);
  const items = (q.data && (q.data.items || q.data)) || [];
  let t = Array.isArray(items) ? items.find(x => x && x.name === name) : null;
  if (!t) t = (await sio('POST', '/tags', key, { name })).data;
  if (t && t.id) tagCache[name] = t.id;
  return tagCache[name];
}

async function saveToSystemeio(lead, tags) {
  const key = process.env.SYSTEMIO_API_KEY;
  if (!key) return 'sin_api_key';
  const fields = [
    { slug: 'first_name', value: lead.nombre },
    { slug: 'phone_number', value: '+' + lead.whatsapp }
  ];
  let c = await sio('POST', '/contacts', key, { email: lead.email, locale: 'es', fields });
  let id = c.ok && c.data && c.data.id;
  if (!id) { // ya existía → lo buscamos y actualizamos nombre y teléfono
    const f = await sio('GET', '/contacts?email=' + encodeURIComponent(lead.email), key);
    const items = (f.data && f.data.items) || [];
    id = items[0] && items[0].id;
    if (id) {
      const u = await sio('PATCH', `/contacts/${id}`, key, { fields }, 'application/merge-patch+json');
      if (!u.ok) console.error('systeme.io actualizar', u.status, JSON.stringify(u.data));
    } else { // por si los campos dieron error, lo creamos solo con el correo
      c = await sio('POST', '/contacts', key, { email: lead.email, locale: 'es' });
      id = c.ok && c.data && c.data.id;
    }
  }
  if (!id) { console.error('systeme.io contacto', c.status, JSON.stringify(c.data)); return 'error_contacto'; }
  for (const name of tags) {
    const tid = await tagId(name, key);
    if (!tid) { console.error('systeme.io etiqueta', name); continue; }
    const a = await sio('POST', `/contacts/${id}/tags`, key, { tagId: tid });
    if (!a.ok && a.status !== 422) console.error('systeme.io etiqueta', name, a.status, JSON.stringify(a.data));
  }
  return 'ok';
}

async function sendCapi(b, lead, req) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token || !b.event_id) return;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const fn = lead.nombre.split(/\s+/)[0].toLowerCase();
  const user_data = {
    em: [sha256(lead.email)], ph: [sha256(lead.whatsapp)], fn: [sha256(fn)],
    client_ip_address: ip, client_user_agent: req.headers['user-agent'] || ''
  };
  if (b.fbp) user_data.fbp = String(b.fbp);
  if (b.fbc) user_data.fbc = String(b.fbc);
  const payload = { data: [{
    event_name: 'Lead', event_time: Math.floor(Date.now() / 1000), event_id: String(b.event_id),
    action_source: 'website', event_source_url: b.event_source_url, user_data,
    custom_data: { content_name: 'ACB_VIP_CALIFICADO' }
  }] };
  if (process.env.META_TEST_CODE) payload.test_event_code = process.env.META_TEST_CODE;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!r.ok) console.error('CAPI', r.status, await r.text());
  } catch (e) { console.error('CAPI error', e); }
}

async function sendWebhook(lead, respuestas) {
  const url = process.env.VIP_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ origen: 'vip', fecha: new Date().toISOString(), respuestas }, lead, { whatsapp: '+' + lead.whatsapp })) });
  } catch (e) { console.error('webhook error', e); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  let host = '';
  try { host = new URL(b.event_source_url).hostname; } catch (e) {}
  if (!host.endsWith('englishwithheidy.com')) return res.status(403).end();
  if (b.empresa) return res.status(400).json({ ok: false, error: 'bot' }); // trampa para bots

  const lead = {
    nombre: String(b.nombre || '').trim().slice(0, 80),
    whatsapp: String(b.whatsapp || '').replace(/\D/g, ''),
    email: String(b.email || '').trim().toLowerCase()
  };
  if (lead.nombre.length < 2) return res.status(400).json({ ok: false, error: 'nombre' });
  if (lead.whatsapp.length < 8 || lead.whatsapp.length > 15) return res.status(400).json({ ok: false, error: 'whatsapp' });
  if (!EMAIL_RE.test(lead.email) || lead.email.length > 254) return res.status(400).json({ ok: false, error: 'email' });
  const respuestas = Array.isArray(b.respuestas) ? b.respuestas.slice(0, 5).map(x => String(x).slice(0, 120)) : [];

  const tags = String(process.env.SYSTEMIO_VIP_TAGS || 'General EWH,VIP Calificado EWH')
    .split(',').map(t => t.trim()).filter(Boolean);

  const [crm] = await Promise.all([
    saveToSystemeio(lead, tags).catch(e => { console.error('systeme.io error', e); return 'error'; }),
    sendCapi(b, lead, req),
    sendWebhook(lead, respuestas)
  ]);
  return res.status(200).json({ ok: true, crm, wa: VIP_WA });
};
