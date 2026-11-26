// /api/waitlist — lista de espera de Black Friday (desafio.englishwithheidy.com/blackfriday)
//   Recibe nombre, correo y WhatsApp y:
//   1) lo guarda en Supabase (tabla nf_waitlist, función nf_api_waitlist) → lista completa para WhatsApp
//   2) crea o actualiza el contacto en systeme.io (nombre + teléfono) y le pone las etiquetas
//      "Waitlist Black Friday EWH" y "General EWH" (o las de SYSTEMIO_WAITLIST_TAGS)
//   3) manda el evento Lead a Meta (API de Conversiones) con correo, teléfono y nombre cifrados (SHA-256)
// Variables de entorno (las mismas que ya existen en Vercel): SYSTEMIO_API_KEY, META_CAPI_TOKEN, NF_API_KEY
//   SYSTEMIO_WAITLIST_TAGS → (opcional) etiquetas separadas por coma
const crypto = require('crypto');
const PIXEL_ID = '1490857044727030';
const SIO = 'https://api.systeme.io/api';
const SB_URL = process.env.NF_SUPABASE_URL || 'https://nzqkqgfdisrnohiyluzj.supabase.co';
const SB_ANON = process.env.NF_SUPABASE_ANON || 'sb_publishable_WNcuZo1C522GYYdtPZcTYQ_GwzDtdBF';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LISTA = 'bf2026';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function sio(method, path, key, body, ctype) {
  const r = await fetch(SIO + path, {
    method,
    headers: Object.assign({ 'X-API-Key': key, Accept: 'application/json' },
      body ? { 'Content-Type': ctype || 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000)
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
  if (!t) { const c = await sio('POST', '/tags', key, { name }); t = c.data; }
  if (t && t.id) tagCache[name] = t.id;
  return tagCache[name];
}

async function saveToSystemeio(email, nombre, phone) {
  const key = process.env.SYSTEMIO_API_KEY;
  if (!key) return 'sin_api_key';
  const fields = [];
  if (nombre) fields.push({ slug: 'first_name', value: nombre });
  if (phone) fields.push({ slug: 'phone_number', value: phone });
  let c = await sio('POST', '/contacts', key, { email, locale: 'es', fields });
  let id = c.ok && c.data && c.data.id;
  if (!id) {
    const f = await sio('GET', '/contacts?email=' + encodeURIComponent(email), key);
    const items = (f.data && f.data.items) || [];
    id = items[0] && items[0].id;
    if (id && fields.length) {
      const u = await sio('PATCH', '/contacts/' + id, key, { fields }, 'application/merge-patch+json');
      if (!u.ok) console.error('systeme.io actualizar', u.status, JSON.stringify(u.data));
    }
  }
  if (!id) { console.error('systeme.io contacto', c.status, JSON.stringify(c.data)); return 'error_contacto'; }
  const tags = String(process.env.SYSTEMIO_WAITLIST_TAGS || 'Waitlist Black Friday EWH,General EWH')
    .split(',').map(t => t.trim()).filter(Boolean);
  for (const name of tags) {
    const tid = await tagId(name, key);
    if (!tid) continue;
    const a = await sio('POST', `/contacts/${id}/tags`, key, { tagId: tid });
    if (!a.ok && a.status !== 422) console.error('systeme.io etiqueta', name, a.status, JSON.stringify(a.data));
  }
  return 'ok';
}

async function saveToSupabase(p) {
  const key = process.env.NF_API_KEY;
  if (!key) return 'sin_api_key';
  const r = await fetch(SB_URL + '/rest/v1/rpc/nf_api_waitlist', {
    method: 'POST',
    headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_key: key, p }),
    signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) { console.error('Supabase waitlist', r.status, await r.text()); return 'error'; }
  const d = await r.json().catch(() => ({}));
  return d && d.nuevo === false ? 'repetido' : 'ok';
}

async function sendCapi(b, email, phone, nombre, req) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token || !b.event_id) return;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const user_data = { em: [sha256(email)], client_ip_address: ip, client_user_agent: req.headers['user-agent'] || '' };
  if (phone) user_data.ph = [sha256(phone.replace(/\D/g, ''))];
  const fn = norm(nombre).split(/\s+/)[0];
  if (fn) user_data.fn = [sha256(fn)];
  if (b.fbp) user_data.fbp = clip(b.fbp, 120);
  if (b.fbc) user_data.fbc = clip(b.fbc, 300);
  const payload = { data: [{
    event_name: 'Lead', event_time: Math.floor(Date.now() / 1000), event_id: clip(b.event_id, 80),
    action_source: 'website', event_source_url: clip(b.event_source_url, 500), user_data,
    custom_data: { content_name: 'BF2026_WAITLIST' }
  }] };
  if (process.env.META_TEST_CODE) payload.test_event_code = process.env.META_TEST_CODE;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) console.error('CAPI', r.status, await r.text());
  } catch (e) { console.error('CAPI error', e.message); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  let host = '';
  try { host = new URL(b.event_source_url).hostname; } catch (e) {}
  if (!host.endsWith('englishwithheidy.com')) return res.status(403).end();

  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ ok: false, error: 'email' });
  const nombre = clip(String(b.nombre || '').replace(/\s+/g, ' ').trim(), 80);
  if (nombre.length < 2) return res.status(400).json({ ok: false, error: 'nombre' });
  const d = String(b.phone || '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 15) return res.status(400).json({ ok: false, error: 'phone' });
  const phone = '+' + d;

  const t = (b.track && typeof b.track === 'object') ? b.track : {};
  const sb = {
    lista: LISTA, nombre, email, phone, pais: clip(b.pais, 40),
    utm_source: clip(t.utm_source, 120), utm_medium: clip(t.utm_medium, 120), utm_campaign: clip(t.utm_campaign, 160),
    utm_content: clip(t.utm_content, 160), utm_term: clip(t.utm_term, 160), fbclid: clip(t.fbclid, 300),
    pagado: !!b.paid, vid: clip(b.vid, 40),
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(), user_agent: clip(req.headers['user-agent'], 300)
  };

  const [db, crm] = await Promise.all([
    saveToSupabase(sb).catch(e => { console.error('Supabase', e.message); return 'error'; }),
    saveToSystemeio(email, nombre, phone).catch(e => { console.error('systeme.io', e.message); return 'error'; }),
    sendCapi(b, email, phone, nombre, req)
  ]);
  return res.status(200).json({ ok: true, db, crm });
};
