// /api/hotmart — webhook de Hotmart (API v2). ÚNICA URL que se configura en Hotmart.
//   1) Guarda TODOS los eventos en Supabase (nf_ventas_eventos) y los enlaza con el visitante de /inscripcion (vía sck)
//   2) Reenvía el webhook tal cual a n8n (flujo "NF – Webhooks de entrada": contacto, bienvenida de alumno y mensajes de carrito por WhatsApp)
//   3) Envía a Meta (API de Conversiones):  Purchase (compra aprobada)  y  CheckoutAbandonado (abandono de carrito)
//   4) Etiqueta en systeme.io:  Comprador NeuroFluency / Carrito Abandonado NF / Reembolso NF
//
// Variables de entorno en Vercel:
//   HOTMART_HOTTOK      → el "Hottok" de Hotmart (Herramientas → Webhook). Si está, se rechaza todo lo que no lo traiga.
//   HOTMART_PRODUCT_ID  → IDs de producto separados por coma. El PRIMERO es NeuroFluency (curso principal);
//                         los demás (ej. Luna AI del upsell) también generan Purchase con su propio valor y etiqueta.
//   NF_API_KEY          → la misma de /api/event (Supabase)
//   META_CAPI_TOKEN     → el mismo de /api/event
//   SYSTEMIO_API_KEY    → el mismo de /api/lead
//   NF_HOTMART_FORWARD  → (opcional) URL de n8n; por defecto la de NF – Webhooks de entrada. Escribe "no" para desactivar.
//   PRECIO_USD          → (opcional) valor en USD si Hotmart no lo trae en dólares. Por defecto 397.
const crypto = require('crypto');
const PIXEL_ID = '1490857044727030';
const SB_URL = process.env.NF_SUPABASE_URL || 'https://nzqkqgfdisrnohiyluzj.supabase.co';
const SB_ANON = process.env.NF_SUPABASE_ANON || 'sb_publishable_WNcuZo1C522GYYdtPZcTYQ_GwzDtdBF';
const N8N = process.env.NF_HOTMART_FORWARD || 'https://n8n-qnqc.srv2125445.hstgr.cloud/webhook/nf-hotmart';
const SIO = 'https://api.systeme.io/api';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const T = () => AbortSignal.timeout(7000);

const COMPRA = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'];
const IDS = String(process.env.HOTMART_PRODUCT_ID || '').split(',').map(x => x.trim()).filter(Boolean);
const esPrincipal = (id) => !IDS.length || String(id) === IDS[0];
const REEMBOLSO = ['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_CANCELED'];
const ABANDONO = 'PURCHASE_OUT_OF_SHOPPING_CART';

// ---------- leer el webhook (v2, con tolerancia a variaciones) ----------
function parse(b) {
  const d = b.data || {};
  const buyer = d.buyer || {};
  const pur = d.purchase || {};
  const prod = d.product || {};
  const price = pur.price || {};
  const orig = pur.original_offer_price || {};
  const origin = pur.origin || {};
  const pay = pur.payment || {};
  const moneda = String(price.currency_value || price.currency_code || '').toUpperCase();
  const valor = price.value != null ? Number(price.value) : null;
  let valorUsd = null;
  if (moneda === 'USD' && valor != null) valorUsd = valor;
  else if (String(orig.currency_value || '').toUpperCase() === 'USD' && orig.value != null) valorUsd = Number(orig.value);
  else if (COMPRA.includes(b.event) && esPrincipal(prod.id)) valorUsd = Number(process.env.PRECIO_USD || 397);
  const sck = String(origin.sck || d.sck || '').trim().toLowerCase();
  const name = String(buyer.name || '').trim();
  return {
    evento: String(b.event || ''),
    transaction: pur.transaction || null,
    status: pur.status || null,
    producto_id: prod.id != null ? String(prod.id) : '',
    producto: prod.name || '',
    oferta: (pur.offer && pur.offer.code) || (d.offer && d.offer.code) || '',
    email: String(buyer.email || '').trim().toLowerCase(),
    phone: String(buyer.checkout_phone || buyer.phone || '').replace(/\D/g, ''),
    name,
    pais: String((buyer.address && (buyer.address.country_iso || buyer.address.country)) ||
                 (d.checkout_country && d.checkout_country.iso) || '').toUpperCase().slice(0, 2),
    valor, moneda, valor_usd: valorUsd,
    metodo_pago: pay.type || '',
    cuotas: pay.installments_number != null ? Number(pay.installments_number) : null,
    sck, src: origin.src || '', xcod: origin.xcod || '',
    vid: /^v[a-z0-9]{8,24}$/.test(sck) ? sck : '',
    fecha_ms: Number(pur.approved_date || pur.order_date || b.creation_date || 0)
  };
}

async function rpc(fn, body) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: T()
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(fn + ' ' + r.status + ' ' + txt);
  try { return JSON.parse(txt); } catch (e) { return null; }
}

// ---------- Meta ----------
async function capi(eventName, eventId, v, vis, extra) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return false;
  const user_data = {};
  if (v.email) user_data.em = [sha256(v.email)];
  if (v.phone) user_data.ph = [sha256(v.phone)];
  if (v.name) {
    const parts = v.name.toLowerCase().split(/\s+/);
    user_data.fn = [sha256(parts[0])];
    if (parts.length > 1) user_data.ln = [sha256(parts[parts.length - 1])];
  }
  if (v.pais) user_data.country = [sha256(v.pais.toLowerCase())];
  if (vis && vis.vid) user_data.external_id = [sha256(vis.vid)];
  if (vis && vis.fbp) user_data.fbp = vis.fbp;
  if (vis && vis.fbc) user_data.fbc = vis.fbc;
  if (vis && vis.ip) user_data.client_ip_address = vis.ip;
  if (vis && vis.ua) user_data.client_user_agent = vis.ua;
  const now = Math.floor(Date.now() / 1000);
  let t = v.fecha_ms ? Math.floor(v.fecha_ms / 1000) : now;
  if (t > now || now - t > 6 * 86400) t = now;
  const ev = {
    event_name: eventName, event_time: t, event_id: eventId,
    action_source: user_data.client_user_agent ? 'website' : 'other',
    user_data, custom_data: extra || {}
  };
  if (ev.action_source === 'website') ev.event_source_url = 'https://desafio.englishwithheidy.com/inscripcion';
  const payload = { data: [ev] };
  if (process.env.META_TEST_CODE) payload.test_event_code = process.env.META_TEST_CODE;
  const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: T()
  });
  if (!r.ok) { console.error('CAPI hotmart', r.status, await r.text()); return false; }
  return true;
}

// ---------- systeme.io ----------
async function sio(method, path, key, body, ctype) {
  const r = await fetch(SIO + path, {
    method, signal: T(),
    headers: Object.assign({ 'X-API-Key': key, Accept: 'application/json' }, body ? { 'Content-Type': ctype || 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, data };
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
async function etiquetar(v, add, remove) {
  const key = process.env.SYSTEMIO_API_KEY;
  if (!key || !v.email) return;
  const fields = [];
  if (v.name) fields.push({ slug: 'first_name', value: v.name.split(/\s+/)[0] });
  if (v.phone) fields.push({ slug: 'phone_number', value: '+' + v.phone });
  let c = await sio('POST', '/contacts', key, { email: v.email, locale: 'es', fields });
  let id = c.ok && c.data && c.data.id;
  if (!id) {
    const f = await sio('GET', '/contacts?email=' + encodeURIComponent(v.email), key);
    id = f.data && f.data.items && f.data.items[0] && f.data.items[0].id;
    if (!id) { c = await sio('POST', '/contacts', key, { email: v.email, locale: 'es' }); id = c.ok && c.data && c.data.id; }
  }
  if (!id) return;
  for (const n of add) {
    const tid = await tagId(n, key);
    if (tid) await sio('POST', `/contacts/${id}/tags`, key, { tagId: tid });
  }
  for (const n of remove) {
    const tid = await tagId(n, key);
    if (tid) await sio('DELETE', `/contacts/${id}/tags/${tid}`, key);
  }
}

// ---------- n8n ----------
async function reenviar(rawBody, hottok) {
  if (!N8N || N8N === 'no') return;
  await fetch(N8N, {
    method: 'POST', signal: T(),
    headers: Object.assign({ 'Content-Type': 'application/json' }, hottok ? { 'X-HOTMART-HOTTOK': hottok } : {}),
    body: rawBody
  });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('ok'); // prueba rápida en el navegador
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  const rawBody = JSON.stringify(b);

  const hottok = String(req.headers['x-hotmart-hottok'] || b.hottok || '');
  if (process.env.HOTMART_HOTTOK && hottok !== process.env.HOTMART_HOTTOK) return res.status(401).json({ ok: false });

  const v = parse(b);
  if (!v.evento) return res.status(200).json({ ok: true, ignorado: true });
  const esNuestro = !IDS.length || IDS.includes(v.producto_id);
  const principal = esPrincipal(v.producto_id);
  const nombreProd = principal ? 'NeuroFluency English Course' : (v.producto || 'Producto ' + v.producto_id);
  const tagCompra = principal ? 'Comprador NeuroFluency' : 'Comprador ' + nombreProd;
  const salida = { ok: true, evento: v.evento };

  // 1) Supabase (sabemos si es nuevo + datos del visitante)
  let vis = null;
  const key = process.env.NF_API_KEY;
  if (key) {
    try {
      vis = await rpc('nf_api_venta', { p_key: key, p: Object.assign({}, v, { raw: b }) });
      salida.supabase = vis && vis.nuevo ? 'nuevo' : 'repetido';
    } catch (e) { console.error(e.message); salida.supabase = 'error'; }
  }
  const nuevo = !vis || vis.nuevo !== false; // si Supabase falló, igual procesamos

  // 2) n8n + 3) Meta + 4) systeme.io en paralelo
  const tareas = [reenviar(rawBody, hottok).catch(e => console.error('n8n', e.message))];

  if (esNuestro && nuevo && v.evento === 'PURCHASE_APPROVED') {
    const usd = v.valor_usd != null;
    tareas.push(capi('Purchase', 'purchase.' + (v.transaction || v.email), v, vis, {
      value: usd ? v.valor_usd : v.valor, currency: usd ? 'USD' : (v.moneda || 'USD'),
      content_name: nombreProd, content_type: 'product',
      content_ids: [v.producto_id || 'neurofluency'], upsell: principal ? undefined : true, order_id: v.transaction || undefined, num_items: 1,
      payment_type: v.metodo_pago || undefined, installments: v.cuotas || undefined
    }).then(ok => { salida.meta = ok ? 'Purchase' : 'error';
      if (ok && key && vis && vis.id) return rpc('nf_api_venta_capi', { p_key: key, p_id: vis.id }).catch(() => {}); })
      .catch(e => console.error('capi', e.message)));
    tareas.push(etiquetar(v, [tagCompra], principal ? ['Carrito Abandonado NF'] : []).catch(e => console.error('sio', e.message)));
  } else if (esNuestro && principal && v.evento === ABANDONO && v.email) {
    const dia = new Date().toISOString().slice(0, 10);
    tareas.push(capi('CheckoutAbandonado', 'abandono.' + sha256(v.email).slice(0, 16) + '.' + dia, v, vis, {
      content_name: 'NeuroFluency English Course', value: Number(process.env.PRECIO_USD || 397), currency: 'USD'
    }).then(ok => { salida.meta = ok ? 'CheckoutAbandonado' : 'error'; }).catch(e => console.error('capi', e.message)));
    tareas.push(etiquetar(v, ['Carrito Abandonado NF'], []).catch(e => console.error('sio', e.message)));
  } else if (esNuestro && nuevo && REEMBOLSO.includes(v.evento)) {
    tareas.push(etiquetar(v, ['Reembolso NF'], []).catch(e => console.error('sio', e.message)));
  }

  await Promise.all(tareas);
  return res.status(200).json(salida);
};
