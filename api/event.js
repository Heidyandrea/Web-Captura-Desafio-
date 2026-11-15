// /api/event — eventos del navegador → Meta (API de Conversiones) + registro de visitantes en Supabase.
// Lo usan TODAS las páginas del desafío (captura, VIP, inscripción). Es compatible con las llamadas anteriores.
//
// Variables de entorno en Vercel:
//   META_CAPI_TOKEN  → token de la API de conversiones (ya existe)
//   META_TEST_CODE   → (opcional) código de "Probar eventos" en el Administrador de eventos
//   NF_API_KEY       → clave de la API de Supabase NeuroFluency (la misma "p_key" que usa n8n). Sin ella no se registran visitantes.
//   NF_SUPABASE_URL  → (opcional) por defecto https://nzqkqgfdisrnohiyluzj.supabase.co
//   NF_SUPABASE_ANON → (opcional) clave publicable de Supabase (por defecto la del proyecto NeuroFluency-WhatsApp)
const crypto = require('crypto');
const PIXEL_ID = '1490857044727030';
const SB_URL = process.env.NF_SUPABASE_URL || 'https://nzqkqgfdisrnohiyluzj.supabase.co';
const SB_ANON = process.env.NF_SUPABASE_ANON || 'sb_publishable_WNcuZo1C522GYYdtPZcTYQ_GwzDtdBF';

// Eventos que se envían a Meta
const CAPI_EVENTS = ['PageView', 'Lead', 'ViewContent', 'Contact', 'VioClase3',
  'InitiateCheckout', 'VioOferta', 'VioVideoVenta', 'VioTestimonios', 'VioUpsell'];
// Eventos que SOLO se guardan en Supabase (no van a Meta)
const LOG_ONLY = ['Scroll', 'VideoProgreso'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

async function sendCapi(b, req, ident) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token || !CAPI_EVENTS.includes(b.event_name)) return;
  const user_data = { client_ip_address: ident.ip, client_user_agent: ident.ua };
  if (b.fbp) user_data.fbp = String(b.fbp);
  if (b.fbc) user_data.fbc = String(b.fbc);
  if (ident.vid) user_data.external_id = [sha256(ident.vid)];
  if (ident.email) user_data.em = [sha256(ident.email)];
  if (ident.phone) user_data.ph = [sha256(ident.phone)];
  if (ident.fn) user_data.fn = [sha256(ident.fn)];
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) console.error('CAPI', r.status, await r.text());
  } catch (e) { console.error('CAPI error', e.message); }
}

async function logVisita(b, ident) {
  const key = process.env.NF_API_KEY;
  if (!key || !ident.vid) return;
  const t = (b.track && typeof b.track === 'object') ? b.track : {};
  let pagina = '';
  try { pagina = new URL(b.event_source_url).pathname; } catch (e) {}
  const p = {
    vid: ident.vid, evento: b.event_name, pagina,
    email: ident.email, phone: ident.phone, name: clip(ident.name, 80),
    utm_source: clip(t.utm_source, 120), utm_medium: clip(t.utm_medium, 120), utm_campaign: clip(t.utm_campaign, 160),
    utm_content: clip(t.utm_content, 160), utm_term: clip(t.utm_term, 120), fbclid: clip(t.fbclid, 300),
    referrer: clip(t.referrer, 300), fbp: clip(b.fbp, 120), fbc: clip(b.fbc, 300),
    ip: ident.ip, ua: clip(ident.ua, 300),
    scroll: Number.isFinite(+t.scroll) ? Math.min(100, Math.max(0, Math.round(+t.scroll))) : 0,
    video: Number.isFinite(+t.video) ? Math.min(100, Math.max(0, Math.round(+t.video))) : 0,
    boton: clip(t.boton, 40)
  };
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/nf_api_visita', {
      method: 'POST',
      headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key, p }),
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) console.error('Supabase visita', r.status, await r.text());
  } catch (e) { console.error('Supabase visita error', e.message); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  const known = CAPI_EVENTS.includes(b.event_name) || LOG_ONLY.includes(b.event_name);
  if (!known || !b.event_id) return res.status(400).end();

  let host = '';
  try { host = new URL(b.event_source_url).hostname; } catch (e) {}
  if (!host.endsWith('englishwithheidy.com')) return res.status(403).end();

  // Identidad (solo existe si la persona ya nos dio sus datos: VIP, enlace de correo/WhatsApp, etc.)
  const u = (b.user && typeof b.user === 'object') ? b.user : {};
  const email = String(u.email || '').trim().toLowerCase();
  const phone = String(u.phone || '').replace(/\D/g, '');
  const name = String(u.name || '').trim();
  const ident = {
    vid: /^v[a-z0-9]{8,24}$/.test(String(b.vid || '')) ? String(b.vid) : '',
    email: EMAIL_RE.test(email) && email.length <= 254 ? email : '',
    phone: phone.length >= 8 && phone.length <= 15 ? phone : '',
    name, fn: name ? name.split(/\s+/)[0].toLowerCase() : '',
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
    ua: req.headers['user-agent'] || ''
  };

  await Promise.all([sendCapi(b, req, ident), logVisita(b, ident)]);
  return res.status(200).json({ ok: true });
};
