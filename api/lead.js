// /api/lead — recibe el correo (y opcionalmente el WhatsApp) del formulario de la landing:
//   1) crea (o encuentra) el contacto en systeme.io y le pone la(s) etiqueta(s)
//   2) envía el evento Lead a Meta (API de Conversiones) con el correo cifrado (SHA-256)
//   3) NUEVO: manda correo + WhatsApp + permiso a n8n (base de recordatorios de NeuroFluency)
// Variables de entorno en Vercel (NUNCA en el código ni en el chat):
//   SYSTEMIO_API_KEY  → clave de la API pública de systeme.io (obligatoria para guardar el correo)
//   SYSTEMIO_TAGS     → etiquetas separadas por coma (por defecto "General EWH,Landing Desafio EWH")
//                       · General EWH: ya está incluida en las 25 newsletters del desafío → reciben todo
//                       · Landing Desafio EWH: marca a quien se registró por la página (para medir y bienvenida)
//   SYSTEMIO_SRC_TAGS → "si" para añadir además el origen: Landing Ads EWH o Landing Organico EWH
//   META_CAPI_TOKEN   → el mismo token que ya usa /api/event
//   NF_WEBHOOK_URL    → NUEVO: https://n8n-qnqc.srv2125445.hstgr.cloud/webhook/nf-registro
//   NF_WEBHOOK_SECRET → NUEVO: el secreto de registro (tabla nf_settings, clave registro_secret)
const crypto = require('crypto');
const PIXEL_ID = '1490857044727030';
const SIO = 'https://api.systeme.io/api';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function sio(method, path, key, body) {
  const r = await fetch(SIO + path, {
    method,
    headers: Object.assign({ 'X-API-Key': key, Accept: 'application/json' },
      body ? { 'Content-Type': 'application/json' } : {}),
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
  if (!t) {
    const c = await sio('POST', '/tags', key, { name });
    t = c.data;
  }
  if (t && t.id) tagCache[name] = t.id;
  return tagCache[name];
}

async function saveToSystemeio(email, tags) {
  const key = process.env.SYSTEMIO_API_KEY;
  if (!key) return 'sin_api_key';
  let c = await sio('POST', '/contacts', key, { email, locale: 'es' });
  let id = c.ok && c.data && c.data.id;
  if (!id) { // ya existía → lo buscamos por correo
    const f = await sio('GET', '/contacts?email=' + encodeURIComponent(email), key);
    const items = (f.data && f.data.items) || [];
    id = items[0] && items[0].id;
  }
  if (!id) { console.error('systeme.io contacto', c.status, JSON.stringify(c.data)); return 'error_contacto'; }
  for (const name of tags) {
    const tid = await tagId(name, key);
    if (!tid) { console.error('systeme.io etiqueta no encontrada/creada', name); continue; }
    const a = await sio('POST', `/contacts/${id}/tags`, key, { tagId: tid });
    if (!a.ok && a.status !== 422) console.error('systeme.io etiqueta', name, a.status, JSON.stringify(a.data));
  }
  return 'ok';
}

// NUEVO: copia el registro a la base de recordatorios de WhatsApp (n8n → Supabase).
// Nunca bloquea: si n8n no responde en 2,5 s, la persona sigue igual al grupo.
async function sendToNF(email, phone, waOk, paid) {
  const url = process.env.NF_WEBHOOK_URL, secret = process.env.NF_WEBHOOK_SECRET;
  if (!url || !secret) return 'sin_config';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ secret, email, phone, consent: waOk ? 'true' : 'false',
        source: paid ? 'landing_ads' : 'landing_organico' })
    });
    return r.ok ? 'ok' : 'error_' + r.status;
  } catch (e) { console.error('NF webhook', e && e.name); return 'error'; }
  finally { clearTimeout(t); }
}

async function sendCapi(b, email, req) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token || !b.event_id) return;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const user_data = { em: [sha256(email)], client_ip_address: ip, client_user_agent: req.headers['user-agent'] || '' };
  const ph = String(b.phone || '').replace(/\D/g, '');
  if (ph.length >= 8) user_data.ph = [sha256(ph)]; // mejora la coincidencia en Meta
  if (b.fbp) user_data.fbp = String(b.fbp);
  if (b.fbc) user_data.fbc = String(b.fbc);
  const payload = {
    data: [{
      event_name: 'Lead',
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
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ ok: false, error: 'email' });

  let host = '';
  try { host = new URL(b.event_source_url).hostname; } catch (e) {}
  if (!host.endsWith('englishwithheidy.com')) return res.status(403).end();

  // WhatsApp opcional: solo dígitos y "+", 8 a 15 dígitos
  const rawPhone = String(b.phone || '').trim().slice(0, 22);
  const phDigits = rawPhone.replace(/\D/g, '');
  const phone = (phDigits.length >= 8 && phDigits.length <= 15) ? (rawPhone.startsWith('+') ? '+' + phDigits : phDigits) : '';
  const waOk = !!phone && (b.wa_ok === true || b.wa_ok === 'true');

  const tags = String(process.env.SYSTEMIO_TAGS || 'General EWH,Landing Desafio EWH')
    .split(',').map(t => t.trim()).filter(Boolean);
  if (String(process.env.SYSTEMIO_SRC_TAGS || '').toLowerCase() === 'si') {
    tags.push(b.paid ? 'Landing Ads EWH' : 'Landing Organico EWH');
  }

  const [sioResult, , nfResult] = await Promise.all([
    saveToSystemeio(email, tags).catch(e => { console.error('systeme.io error', e); return 'error'; }),
    sendCapi(Object.assign({}, b, { phone }), email, req),
    sendToNF(email, phone, waOk, b.paid)
  ]);
  return res.status(200).json({ ok: true, crm: sioResult, wa: nfResult });
};
