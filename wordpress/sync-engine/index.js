'use strict';

/**
 * Smart Clover Bridge – Sync Engine
 *
 * Inbound  (Detelina → WooCommerce):
 *   PLUDATA  – upsert products & prices in WooCommerce
 *   POSSALES – reduce WooCommerce stock for in-store sales
 *
 * Outbound (WooCommerce → Detelina):
 *   New WooCommerce orders → RDELIV XML → transfer/out/
 *
 * Idempotency: every processed file is SHA-256 hashed and stored
 * in PostgreSQL so it is never imported twice.
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const http    = require('http');
const chokidar = require('chokidar');
const iconv   = require('iconv-lite');
const xml2js  = require('xml2js');
const axios   = require('axios');
const { Pool } = require('pg');

// ─── Configuration (injected via environment variables) ───────────────────────

const CONFIG = {
  db: {
    host:     process.env.DB_SYNC_HOST || 'localhost',
    user:     process.env.DB_SYNC_USER || 'sync_user',
    password: process.env.DB_SYNC_PASS || 'sync_password',
    database: process.env.DB_SYNC_NAME || 'sync_bridge',
    port:     5432,
  },
  wp: {
    apiUrl:         process.env.WP_API_URL          || 'http://wordpress/wp-json/wc/v3',
    consumerKey:    process.env.WP_CONSUMER_KEY     || '',
    consumerSecret: process.env.WP_CONSUMER_SECRET  || '',
  },
  transfer: {
    inDir:      path.resolve('./transfer/in'),
    outDir:     path.resolve('./transfer/out'),
    archiveDir: path.resolve('./transfer/archive'),
  },
  orderPollIntervalMs: parseInt(process.env.ORDER_POLL_INTERVAL_MS || '60000', 10),
  webhook: {
    port:           parseInt(process.env.WEBHOOK_PORT   || '3000', 10),
    secret:         process.env.WEBHOOK_SECRET           || '',
    // URL reachable by WordPress inside the Docker network
    deliveryUrl:    process.env.WEBHOOK_DELIVERY_URL     || 'http://sync_engine:3000/webhook/order',
  },
};

// ─── Database pool ─────────────────────────────────────────────────────────────

const pool = new Pool(CONFIG.db);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_files (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL,
      sha256      CHAR(64) NOT NULL UNIQUE,
      doc_type    TEXT,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plu_mapping (
      id            SERIAL PRIMARY KEY,
      detelina_nb   INTEGER NOT NULL UNIQUE,  -- PLUNB
      detelina_nn   TEXT,                     -- PLUNN (barcode / external code)
      wc_product_id INTEGER,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sync_errors (
      id          SERIAL PRIMARY KEY,
      filename    TEXT,
      error_msg   TEXT,
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS exported_orders (
      id            SERIAL PRIMARY KEY,
      wc_order_id   INTEGER NOT NULL UNIQUE,
      xml_filename  TEXT,
      exported_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  log('Database schema ready.');
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function log(msg, level = 'INFO') {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Read a file and auto-detect Windows-1251 vs UTF-8 encoding. */
function readXmlFile(filePath) {
  const raw = fs.readFileSync(filePath);
  // Detect encoding from the XML declaration
  const snippet = raw.slice(0, 200).toString('ascii');
  const isWin1251 = /encoding\s*=\s*["']windows-1251["']/i.test(snippet);
  return isWin1251 ? iconv.decode(raw, 'win1251') : raw.toString('utf8');
}

async function parseXml(xmlString) {
  return xml2js.parseStringPromise(xmlString, { explicitArray: false, trim: true });
}

function wcApi(method, endpoint, data = null) {
  // Use query-parameter auth instead of Basic Auth because Apache (WordPress
  // Docker image) strips the Authorization header before PHP sees it.
  // WooCommerce only accepts query-param auth over HTTPS, so we also send
  // X-Forwarded-Proto: https so WordPress treats the internal request as secure.
  const sep = endpoint.includes('?') ? '&' : '?';
  const url  = `${CONFIG.wp.apiUrl}/${endpoint}${sep}consumer_key=${encodeURIComponent(CONFIG.wp.consumerKey)}&consumer_secret=${encodeURIComponent(CONFIG.wp.consumerSecret)}`;
  return axios({ method, url, data, headers: { 'X-Forwarded-Proto': 'https' } });
}

async function logError(filename, err) {
  const msg = err && err.message ? err.message : String(err);
  log(`ERROR [${filename}]: ${msg}`, 'ERROR');
  try {
    await pool.query(
      'INSERT INTO sync_errors (filename, error_msg) VALUES ($1, $2)',
      [filename, msg]
    );
  } catch (_) { /* ignore secondary DB error */ }
}

/** Rename a bad file to .err so Detelina knows it failed. */
function markFileAsError(filePath) {
  const errPath = filePath.replace(/\.(xml|tmp)$/i, '.err');
  try { fs.renameSync(filePath, errPath); } catch (_) { }
}

/** Move a successfully processed file to the archive directory. */
function archiveFile(filePath) {
  const dest = path.join(CONFIG.transfer.archiveDir, path.basename(filePath));
  try { fs.renameSync(filePath, dest); } catch (_) { }
}

// ─── PLUDATA processor ─────────────────────────────────────────────────────────

/**
 * Detect WooCommerce category ID for a Detelina group name.
 * Lazily creates the category if it does not exist yet.
 */
const _catCache = {};
async function ensureWcCategory(name) {
  if (!name) return null;
  if (_catCache[name]) return _catCache[name];
  // Try to find existing
  const res = await wcApi('get', `products/categories?search=${encodeURIComponent(name)}&per_page=10`);
  const match = (res.data || []).find(c => c.name === name);
  if (match) {
    _catCache[name] = match.id;
    return match.id;
  }
  // Create it
  const created = await wcApi('post', 'products/categories', { name });
  _catCache[name] = created.data.id;
  return created.data.id;
}

async function processPludata(parsed, filename) {
  const items = parsed.PLUDATA && parsed.PLUDATA.PLU;
  if (!items) { log(`No PLU entries in ${filename}`, 'WARN'); return; }
  const list = Array.isArray(items) ? items : [items];

  for (const plu of list) {
    const plunb  = parseInt(plu.PLUNB, 10);
    const plunm  = plu.PLUNM || '';
    const price  = parseFloat(plu.SLPRC || '0').toFixed(2);
    const deleted = plu.DELETED === '1';

    // Resolve deepest group name for WC category
    let grp = plu.GRP;
    while (grp && grp.GRP) grp = grp.GRP;
    const categoryName = grp && grp.GNМ ? grp.GNМ : null;
    const categoryId   = categoryName ? await ensureWcCategory(categoryName) : null;

    // Look up existing WC product via our mapping table
    const mapRow = await pool.query(
      'SELECT wc_product_id FROM plu_mapping WHERE detelina_nb = $1', [plunb]
    );
    const wcId = mapRow.rows[0] ? mapRow.rows[0].wc_product_id : null;

    const productData = {
      name:       plunm,
      regular_price: price,
      status:     deleted ? 'trash' : 'publish',
      sku:        String(plu.PLUNN || plunb),
      ...(categoryId ? { categories: [{ id: categoryId }] } : {}),
    };

    if (wcId) {
      // Update existing product
      await wcApi('put', `products/${wcId}`, productData);
      log(`Updated WC product #${wcId} for PLU ${plunb}`);
    } else {
      // Create new product and record mapping
      const created = await wcApi('post', 'products', productData);
      const newWcId = created.data.id;
      await pool.query(
        `INSERT INTO plu_mapping (detelina_nb, detelina_nn, wc_product_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (detelina_nb) DO UPDATE
           SET detelina_nn   = EXCLUDED.detelina_nn,
               wc_product_id = EXCLUDED.wc_product_id,
               updated_at    = NOW()`,
        [plunb, plu.PLUNN || null, newWcId]
      );
      log(`Created WC product #${newWcId} for PLU ${plunb}`);
    }
  }
}

// ─── POSSALES processor ────────────────────────────────────────────────────────

async function processPossales(parsed, filename) {
  const receipts = parsed.POSSALES && parsed.POSSALES.RECEIPT;
  if (!receipts) { log(`No RECEIPT entries in ${filename}`, 'WARN'); return; }
  const list = Array.isArray(receipts) ? receipts : [receipts];

  for (const receipt of list) {
    if (receipt.DEL === '1') continue; // voided receipt
    const items = receipt.PLU ? (Array.isArray(receipt.PLU) ? receipt.PLU : [receipt.PLU]) : [];

    for (const plu of items) {
      const plunb = parseInt(plu.PLUNB, 10);
      const qty   = parseFloat(plu.QTY || '0');
      if (qty <= 0) continue;

      const mapRow = await pool.query(
        'SELECT wc_product_id FROM plu_mapping WHERE detelina_nb = $1', [plunb]
      );
      if (!mapRow.rows[0]) continue; // product not yet synced – skip stock update

      const wcId = mapRow.rows[0].wc_product_id;
      // Fetch current stock
      const prodRes = await wcApi('get', `products/${wcId}`);
      const currentStock = prodRes.data.stock_quantity;
      if (currentStock === null || currentStock === undefined) continue; // stock not managed

      const newStock = Math.max(0, currentStock - qty);
      await wcApi('put', `products/${wcId}`, { stock_quantity: newStock });
      log(`Stock update WC #${wcId} PLU ${plunb}: ${currentStock} → ${newStock}`);
    }
  }
}

// ─── Inbound file dispatcher ───────────────────────────────────────────────────

async function handleInboundFile(filePath) {
  if (!/\.xml$/i.test(filePath)) return; // ignore .err / .proc / .tmp

  const filename = path.basename(filePath);
  log(`Processing inbound: ${filename}`);

  let rawBuffer;
  try {
    rawBuffer = fs.readFileSync(filePath);
  } catch (err) {
    await logError(filename, err);
    return;
  }

  // Idempotency check
  const hash = sha256(rawBuffer);
  const existing = await pool.query(
    'SELECT id FROM processed_files WHERE sha256 = $1', [hash]
  );
  if (existing.rows.length > 0) {
    log(`Skipping duplicate file: ${filename}`);
    archiveFile(filePath);
    return;
  }

  let xmlString, parsed, docType;
  try {
    xmlString = rawBuffer.toString('ascii').includes('windows-1251')
      ? iconv.decode(rawBuffer, 'win1251')
      : rawBuffer.toString('utf8');
    parsed = await parseXml(xmlString);
    docType = Object.keys(parsed)[0].toUpperCase();
  } catch (err) {
    await logError(filename, err);
    markFileAsError(filePath);
    return;
  }

  try {
    if (docType === 'PLUDATA') {
      await processPludata(parsed, filename);
    } else if (docType === 'POSSALES') {
      await processPossales(parsed, filename);
    } else {
      log(`Unknown document type "${docType}" in ${filename} – skipping.`, 'WARN');
    }

    // Record as processed
    await pool.query(
      'INSERT INTO processed_files (filename, sha256, doc_type) VALUES ($1, $2, $3)',
      [filename, hash, docType]
    );
    archiveFile(filePath);
    log(`Done: ${filename}`);
  } catch (err) {
    await logError(filename, err);
    markFileAsError(filePath);
  }
}

// ─── Outbound: WooCommerce orders → RDELIV XML ─────────────────────────────────

function zeroPad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function formatDate(d) {
  return `${d.getFullYear()}${zeroPad(d.getMonth() + 1)}${zeroPad(d.getDate())}`;
}

function formatTime(d) {
  return `${zeroPad(d.getHours())}${zeroPad(d.getMinutes())}${zeroPad(d.getSeconds())}`;
}

/**
 * Build a RDELIV XML string (windows-1251 declared, but stored as UTF-8 bytes
 * – iconv-lite encodes before writing).
 */
function buildRdelivXml(order) {
  const now = new Date();
  const items = (order.line_items || []).map(li => {
    const plunb = li.meta_data
      ? (li.meta_data.find(m => m.key === '_detelina_nb') || {}).value || '0'
      : '0';
    return `
    <PLU>
      <PLUNB>${plunb}</PLUNB>
      <PLUNN>${li.sku || ''}</PLUNN>
      <QTY>${parseFloat(li.quantity).toFixed(3)}</QTY>
      <PRC>${parseFloat(li.price).toFixed(2)}</PRC>
      <CURR>BGN</CURR>
      <PCMNT></PCMNT>
    </PLU>`;
  }).join('');

  const billing = order.billing || {};
  const eik     = (order.meta_data || []).find(m => m.key === '_billing_eik');
  const seik    = eik ? eik.value : (billing.company || '0');

  return `<?xml version="1.0" encoding="WINDOWS-1251"?>\n<RDELIV>\n  <REQD>\n    <TYP>1</TYP>\n    <SEIK>${seik}</SEIK>\n    <DNMB>${order.id}</DNMB>\n    <CMNT>WooCommerce order #${order.id} – ${billing.first_name || ''} ${billing.last_name || ''}</CMNT>\n    <DDATE>${formatDate(now)}</DDATE>\n    <DTIME>${formatTime(now)}</DTIME>\n    <STORG>1</STORG>\n    <PLUES>${items}\n    </PLUES>\n  </REQD>\n</RDELIV>`;
}

/**
 * Core export: builds RDELIV XML for a single WooCommerce order and drops
 * it into transfer/out/ for Detelina to pick up over FTP.
 * Idempotent – silently skips orders that have already been exported.
 */
async function exportOrder(order) {
  const row = await pool.query(
    'SELECT id FROM exported_orders WHERE wc_order_id = $1', [order.id]
  );
  if (row.rows.length > 0) {
    log(`Order #${order.id} already exported – skipping.`);
    return;
  }

  if (!order.line_items || order.line_items.length === 0) {
    log(`Order #${order.id} has no line items – skipping.`, 'WARN');
    return;
  }

  const xmlContent = buildRdelivXml(order);
  const encoded    = iconv.encode(xmlContent, 'win1251');

  const ts      = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15);
  const tmpName = `EboIn_Order${order.id}_${ts}.tmp`;
  const xmlName = `EboIn_Order${order.id}_${ts}.xml`;
  const tmpPath = path.join(CONFIG.transfer.outDir, tmpName);
  const xmlPath = path.join(CONFIG.transfer.outDir, xmlName);

  // Write as .tmp first, then atomically rename to .xml
  // so Detelina never sees a partial file.
  fs.writeFileSync(tmpPath, encoded);
  fs.renameSync(tmpPath, xmlPath);

  await pool.query(
    'INSERT INTO exported_orders (wc_order_id, xml_filename) VALUES ($1, $2)',
    [order.id, xmlName]
  );

  // Move the WooCommerce order to "on-hold" so it is not re-exported
  // by the polling fallback.
  await wcApi('put', `orders/${order.id}`, { status: 'on-hold' });

  log(`Exported order #${order.id} → ${xmlName}`);
}

/** Polling fallback – catches any orders missed by the webhook (e.g. downtime). */
async function exportPendingOrders() {
  let ordersRes;
  try {
    ordersRes = await wcApi('get', 'orders?status=processing&per_page=50');
  } catch (err) {
    log(`Failed to fetch WooCommerce orders: ${err.message}`, 'WARN');
    return;
  }

  for (const order of ordersRes.data || []) {
    try {
      await exportOrder(order);
    } catch (err) {
      await logError(`order_${order.id}`, err);
    }
  }
}

// ─── Webhook receiver ──────────────────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature that WooCommerce attaches to every webhook
 * request.  Returns true when no secret is configured (development mode).
 */
function isValidWcSignature(rawBody, signatureHeader) {
  if (!CONFIG.webhook.secret) return true; // dev mode – skip verification
  if (!signatureHeader)       return false;
  const expected = crypto
    .createHmac('sha256', CONFIG.webhook.secret)
    .update(rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader)
  );
}

function startWebhookServer() {
  const server = http.createServer((req, res) => {
    // Only accept POST /webhook/order
    if (req.method !== 'POST' || req.url !== '/webhook/order') {
      res.writeHead(404).end();
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);

      // Verify signature
      if (!isValidWcSignature(rawBody, req.headers['x-wc-webhook-signature'])) {
        log('Webhook: invalid signature – request rejected.', 'WARN');
        res.writeHead(401).end();
        return;
      }

      let order;
      try {
        order = JSON.parse(rawBody.toString('utf8'));
      } catch (e) {
        log(`Webhook: failed to parse JSON – ${e.message}`, 'WARN');
        res.writeHead(400).end();
        return;
      }

      // Respond immediately so WooCommerce doesn't time out waiting for us
      res.writeHead(200).end('OK');

      // Process asynchronously after the response is sent
      if (order.status === 'processing') {
        log(`Webhook: received paid order #${order.id}`);
        exportOrder(order).catch(err =>
          logError(`webhook_order_${order.id}`, err)
        );
      }
    });

    req.on('error', err => log(`Webhook request error: ${err.message}`, 'ERROR'));
  });

  server.listen(CONFIG.webhook.port, () =>
    log(`Webhook server listening on :${CONFIG.webhook.port}`)
  );
}

/**
 * Auto-register a WooCommerce webhook for order.updated so that payments
 * trigger an immediate export.  Safe to call on every startup – skips
 * registration when the hook already exists.
 */
async function ensureWebhookRegistered() {
  if (!CONFIG.wp.consumerKey) {
    log('WP_CONSUMER_KEY not set – skipping webhook registration.', 'WARN');
    return;
  }

  try {
    const existing = await wcApi('get', 'webhooks?per_page=100');
    const alreadyExists = (existing.data || []).some(
      wh => wh.delivery_url === CONFIG.webhook.deliveryUrl && wh.status === 'active'
    );

    if (alreadyExists) {
      log('WooCommerce webhook already registered.');
      return;
    }

    await wcApi('post', 'webhooks', {
      name:         'Smart Clover Order Export',
      topic:        'order.updated',
      delivery_url: CONFIG.webhook.deliveryUrl,
      secret:       CONFIG.webhook.secret,
      status:       'active',
    });
    log(`WooCommerce webhook registered → ${CONFIG.webhook.deliveryUrl}`);
  } catch (err) {
    log(
      `Could not auto-register webhook: ${err.message}. Polling will serve as fallback.`,
      'WARN'
    );
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('Smart Clover Bridge – Sync Engine starting...');

  // Ensure output directories exist
  [CONFIG.transfer.outDir, CONFIG.transfer.archiveDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // Wait for PostgreSQL to be accessible (Docker healthcheck should handle this,
  // but we add a short retry loop as belt-and-suspenders).
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      log(`DB not ready (attempt ${attempt}/10): ${err.message}`, 'WARN');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await initDb();

  // Watch inbound FTP directory
  const watcher = chokidar.watch(CONFIG.transfer.inDir, {
    ignored:    /(^|[\/\\])\../, // hidden files
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000, // wait 2 s after last write before processing
      pollInterval:       500,
    },
  });

  watcher
    .on('add',   filePath => handleInboundFile(filePath).catch(() => {}))
    .on('error', err      => log(`Watcher error: ${err}`, 'ERROR'));

  log(`Watching ${CONFIG.transfer.inDir} for inbound XML files.`);

  // Start the webhook receiver so WooCommerce can push paid orders in real-time
  startWebhookServer();

  // Register the WooCommerce webhook (idempotent – skips if already present)
  await ensureWebhookRegistered();

  // Polling fallback – catches any orders the webhook may have missed
  async function orderPollLoop() {
    await exportPendingOrders().catch(err =>
      log(`Order export cycle error: ${err.message}`, 'ERROR')
    );
    setTimeout(orderPollLoop, CONFIG.orderPollIntervalMs);
  }
  orderPollLoop();

  log(`Order export poll interval: ${CONFIG.orderPollIntervalMs / 1000}s`);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
