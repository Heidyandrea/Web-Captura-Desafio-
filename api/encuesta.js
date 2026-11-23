// /api/encuesta — encuesta de alumnos de NeuroFluency (solo compradores)
//   POST {accion:'verificar', email, phone}          → {ok, nombre, ya_respondio} si es comprador
//   POST {accion:'guardar', email, phone, nombre, respuestas} → guarda (una respuesta por correo; si repite, se actualiza)
// La verificación la hace Supabase (función nf_api_encuesta): busca el correo o los últimos 9 dígitos del
// teléfono entre las compras aprobadas del curso y la tabla nf_compradores_extra (Whop / otros métodos).
// Al guardar, también pone la etiqueta "Respondió Encuesta NF" en systeme.io para excluirlos de recordatorios.
// Variables de entorno: NF_SUPABASE_URL / NF_SUPABASE_ANON (opcionales), SYSTEMIO_API_KEY (opcional).
const SB_URL = process.env.NF_SUPABASE_URL || 'https://nzqkqgfdisrnohiyluzj.supabase.co';
const SB_ANON = process.env.NF_SUPABASE_ANON || 'sb_publishable_WNcuZo1C522GYYdtPZcTYQ_GwzDtdBF';
const SIO = 'https://api.systeme.io/api';
const TAG = 'Respondió Encuesta NF';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function rpc(payload) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/nf_api_encuesta', {
    method: 'POST',
    headers: { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: payload })
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function tagSysteme(email) {
  const key = process.env.SYSTEMIO_API_KEY;
  if (!key) return;
  const h = { 'X-API-Key': key, Accept: 'application/json', 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(SIO + p, { headers: h }); return r.ok ? r.json() : null; };
  const c = await get('/contacts?email=' + encodeURIComponent(email));
  const id = c && c.items && c.items[0] && c.items[0].id;
  if (!id) return;
  const t = await get('/tags?query=' + encodeURIComponent(TAG));
  let tag = t && (t.items || []).find((x) => x.name === TAG);
  if (!tag) {
    const r = await fetch(SIO + '/tags', { method: 'POST', headers: h, body: JSON.stringify({ name: TAG }) });
    tag = r.ok ? await r.json() : null;
  }
  if (tag && tag.id) await fetch(SIO + `/contacts/${id}/tags`, { method: 'POST', headers: h, body: JSON.stringify({ tagId: tag.id }) });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const email = String(b.email || '').trim().toLowerCase().slice(0, 160);
  const phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, motivo: 'correo_invalido' });
  const accion = b.accion === 'guardar' ? 'guardar' : 'verificar';
  const payload = { accion, email, phone };
  if (accion === 'guardar') {
    payload.nombre = String(b.nombre || '').slice(0, 120);
    payload.respuestas = b.respuestas && typeof b.respuestas === 'object' ? b.respuestas : {};
    payload.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    payload.ua = String(req.headers['user-agent'] || '');
  }
  try {
    const out = await rpc(payload);
    if (accion === 'guardar' && out && out.ok) { try { await tagSysteme(email); } catch (e) { console.error('systeme', e.message); } }
    return res.status(200).json(out);
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ ok: false, motivo: 'error' });
  }
};
