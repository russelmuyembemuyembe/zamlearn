require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Cloudinary config ──────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'YOUR_CLOUD_NAME',
  api_key:    process.env.CLOUDINARY_API_KEY    || 'YOUR_API_KEY',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'YOUR_API_SECRET',
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Multer: store file in memory so we can stream to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// Parse Cloudinary's context field defensively — handles every shape we've
// seen in the wild: nested under .custom, a flat object, or a raw
// "key=value|key=value" string (legacy resources from before this fix).
function parseContext(rawContext) {
  if (!rawContext) return {};
  if (typeof rawContext === 'string') {
    const out = {};
    rawContext.split('|').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx > -1) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });
    return out;
  }
  if (rawContext.custom) return rawContext.custom;
  return rawContext;
}

// Upload a buffer to Cloudinary via stream
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

// Update context on an EXISTING resource.
// IMPORTANT: cloudinary.uploader.explicit() does NOT reliably persist context
// updates for already-uploaded resources (it's designed for eager
// transformations). The correct, documented way to update context on an
// existing asset is the Admin API's `update` method: cloudinary.api.update().
// Source: https://cloudinary.com/documentation/admin_api#update_details_of_an_existing_resource
function updateResourceContext(publicId, resourceType, contextObj, tags) {
  return new Promise((resolve, reject) => {
    cloudinary.api.update(
      publicId,
      {
        resource_type: resourceType, // 'raw'
        type: 'upload',
        context: contextObj,          // plain object — Admin API handles key=value encoding
        tags: tags || undefined,      // pass the real array — toArray() only wraps non-arrays, doesn't split strings
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
  });
}

// Fetch ALL resources matching a prefix, following Cloudinary's pagination
// cursor until exhausted. Cloudinary caps each request at max_results:500,
// so without this, anything beyond the first 500 uploads would be silently
// missing from lists/searches/filters.
async function fetchAllResources(prefix) {
  let allResources = [];
  let cursor = undefined;
  let page = 0;
  const MAX_PAGES = 50; // safety cap: 50 × 500 = 25,000 resources max

  do {
    const opts = {
      resource_type: 'raw',
      type: 'upload',
      prefix,
      max_results: 500,
      context: true,
      tags: true,
    };
    if (cursor) opts.next_cursor = cursor;

    const result = await cloudinary.api.resources(opts);
    allResources = allResources.concat(result.resources);
    cursor = result.next_cursor;
    page++;
  } while (cursor && page < MAX_PAGES);

  return allResources;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PAST PAPERS
// ═══════════════════════════════════════════════════════════════════════════

// Upload a past paper
app.post('/api/pastpapers/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const { grade, subject, year } = req.body;
    if (!grade || !subject || !year)
      return res.status(400).json({ error: 'grade, subject, and year are required' });

    const safeGrade   = String(grade).replace(/\s+/g, '_');
    const safeSubject = String(subject).replace(/\s+/g, '_');
    const publicId     = `zamlearn/pastpapers/${safeGrade}/${year}/${safeSubject}_${Date.now()}`;

    const contextObj = { grade: String(grade), subject: String(subject), year: String(year) };
    const tags = ['pastpaper', `grade_${grade}`, `year_${year}`, String(subject).toLowerCase()];

    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'raw',
      public_id: publicId,
      format: 'pdf',
      access_mode: 'public',
      context: contextObj,
      tags,
    });


    res.json({
      success: true,
      message: 'Past paper uploaded successfully',
      data: {
        public_id: result.public_id,
        url: result.secure_url,
        grade: String(grade),
        subject: String(subject),
        year: String(year),
        bytes: result.bytes,
      },
    });
  } catch (err) {
    console.error('[UPLOAD paper] error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// List past papers (with optional filters)
app.get('/api/pastpapers', async (req, res) => {
  try {
    const { grade, subject, year } = req.query;

    const resources = await fetchAllResources('zamlearn/pastpapers/');

    let papers = resources.map(r => {
      const ctx = parseContext(r.context);
      const signedUrl = cloudinary.url(r.public_id, {
        resource_type: 'raw',
        type: 'upload',
        secure: true,
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      return {
        public_id:  r.public_id,
        url:        signedUrl,
        grade:      ctx.grade   || '',
        subject:    ctx.subject || '',
        year:       ctx.year    || '',
        bytes:      r.bytes,
        created_at: r.created_at,
      };
    });

    if (grade)   papers = papers.filter(p => p.grade === String(grade));
    if (year)    papers = papers.filter(p => p.year  === String(year));
    if (subject) papers = papers.filter(p => p.subject.toLowerCase() === String(subject).toLowerCase());

    res.json({ success: true, count: papers.length, data: papers });
  } catch (err) {
    console.error('[LIST papers] error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch past papers' });
  }
});

// Update a past paper's metadata
app.put('/api/pastpapers/update', async (req, res) => {
  try {
    const { publicId, grade, subject, year } = req.body;
    if (!publicId || !grade || !subject || !year)
      return res.status(400).json({ error: 'publicId, grade, subject, and year are required' });

    const contextObj = { grade: String(grade), subject: String(subject), year: String(year) };
    const tags = ['pastpaper', `grade_${grade}`, `year_${year}`, String(subject).toLowerCase()];

    await updateResourceContext(publicId, 'raw', contextObj, tags);

    // Self-verify: read the resource back immediately to confirm context stuck
    const check = await cloudinary.api.resource(publicId, { resource_type: 'raw', type: 'upload', context: true });
    const verifiedCtx = parseContext(check.context);
    console.log(`[UPDATE paper] ${publicId} wrote →`, JSON.stringify(contextObj), 'readback →', JSON.stringify(verifiedCtx));

    const ok = verifiedCtx.grade === String(grade) && verifiedCtx.subject === String(subject) && verifiedCtx.year === String(year);
    if (!ok) {
      return res.status(500).json({
        error: 'Update sent but Cloudinary did not persist it. Readback: ' + JSON.stringify(verifiedCtx),
      });
    }

    res.json({ success: true, message: 'Past paper updated', verified: verifiedCtx });
  } catch (err) {
    console.error('[UPDATE paper] error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
});

// Delete a past paper
app.delete('/api/pastpapers/:publicId(*)', async (req, res) => {
  try {
    const publicId = req.params.publicId;
    await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    res.json({ success: true, message: 'Past paper deleted' });
  } catch (err) {
    console.error('[DELETE paper] error:', err);
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BOOKS
// ═══════════════════════════════════════════════════════════════════════════

// Upload a book
app.post('/api/books/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const { grade, title, category, price } = req.body;

    if (!grade || !title)
      return res.status(400).json({ error: 'grade and title are required' });

    const safeGrade = String(grade).replace(/\s+/g, '_');
    const safeTitle = String(title).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const publicId  = `zamlearn/books/${safeGrade}/${safeTitle}_${Date.now()}`;

    const contextObj = { grade: String(grade), title: String(title) };
    if (category) contextObj.category = String(category);
    const parsedPrice = parseFloat(price || 0);
    if (parsedPrice > 0) contextObj.price = String(parsedPrice.toFixed(2));

    const tags = ['book', `grade_${grade}`];
    if (category) tags.push(String(category).toLowerCase().replace(/\s+/g, '_'));
    if (parsedPrice > 0) tags.push('paid');

    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'raw',
      public_id: publicId,
      format: 'pdf',
      access_mode: 'public',
      context: contextObj,
      tags,
    });


    res.json({
      success: true,
      message: 'Book uploaded successfully',
      data: {
        public_id: result.public_id,
        url: result.secure_url,
        grade: String(grade),
        title: String(title),
        category: category ? String(category) : '',
        price: parsedPrice > 0 ? String(parsedPrice.toFixed(2)) : '0',
        bytes: result.bytes,
      },
    });
  } catch (err) {
    console.error('[UPLOAD book] error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// List books
app.get('/api/books', async (req, res) => {
  try {
    const { grade, category } = req.query;

    const resources = await fetchAllResources('zamlearn/books/');

    let books = resources.map(r => {
      const ctx = parseContext(r.context);
      const signedUrl = cloudinary.url(r.public_id, {
        resource_type: 'raw',
        type: 'upload',
        secure: true,
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      return {
        public_id:  r.public_id,
        url:        signedUrl,
        grade:      ctx.grade    || '',
        title:      ctx.title    || '',
        category:   ctx.category || '',
        price:      ctx.price    || '0',
        bytes:      r.bytes,
        created_at: r.created_at,
      };
    });

    if (grade)    books = books.filter(b => b.grade === String(grade));
    if (category) books = books.filter(b => (b.category || '').toLowerCase() === String(category).toLowerCase());

    res.json({ success: true, count: books.length, data: books });
  } catch (err) {
    console.error('[LIST books] error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch books' });
  }
});

// Update a book's metadata
app.put('/api/books/update', async (req, res) => {
  try {
    const { publicId, grade, title, category, price } = req.body;

    if (!publicId || !grade || !title)
      return res.status(400).json({ error: 'publicId, grade, and title are required' });

    const categoryProvided = typeof category === 'string' && category.trim().length > 0;
    const cleanCategory = categoryProvided ? category.trim() : '';
    const parsedPrice = parseFloat(price || 0);

    const contextObj = { grade: String(grade), title: String(title) };
    if (categoryProvided) contextObj.category = cleanCategory;
    if (parsedPrice > 0) contextObj.price = String(parsedPrice.toFixed(2));

    const tags = ['book', `grade_${grade}`];
    if (categoryProvided) tags.push(cleanCategory.toLowerCase().replace(/\s+/g, '_'));
    if (parsedPrice > 0) tags.push('paid');


    await updateResourceContext(publicId, 'raw', contextObj, tags);

    // Self-verify: read the resource back immediately to confirm context stuck.
    // This check is now STRICT — if a category was provided but didn't come
    // back, this reports failure honestly instead of silently passing.
    const check = await cloudinary.api.resource(publicId, { resource_type: 'raw', type: 'upload', context: true });
    const verifiedCtx = parseContext(check.context);
    console.log(`[UPDATE book] ${publicId} wrote →`, JSON.stringify(contextObj), 'readback →', JSON.stringify(verifiedCtx));

    const gradeOk    = verifiedCtx.grade === String(grade);
    const titleOk    = verifiedCtx.title === String(title);
    const categoryOk = categoryProvided ? (verifiedCtx.category === cleanCategory) : true;
    const priceOk    = parsedPrice > 0 ? (verifiedCtx.price === String(parsedPrice.toFixed(2))) : true;

    if (!gradeOk || !titleOk || !categoryOk || !priceOk) {
      return res.status(500).json({
        error: `Update did not fully persist. grade_ok=${gradeOk} title_ok=${titleOk} category_ok=${categoryOk} price_ok=${priceOk}. ` +
               `Sent: ${JSON.stringify(contextObj)} — Cloudinary has: ${JSON.stringify(verifiedCtx)}`,
      });
    }

    res.json({ success: true, message: 'Book updated', verified: verifiedCtx });
  } catch (err) {
    console.error('[UPDATE book] error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
});

// Delete a book
app.delete('/api/books/:publicId(*)', async (req, res) => {
  try {
    const publicId = req.params.publicId;
    await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    res.json({ success: true, message: 'Book deleted' });
  } catch (err) {
    console.error('[DELETE book] error:', err);
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PESAPAL PAYMENT
// ═══════════════════════════════════════════════════════════════════════════

const PESAPAL_ENV     = process.env.PESAPAL_ENV || 'sandbox'; // 'sandbox' or 'live'
const PESAPAL_BASE    = PESAPAL_ENV === 'live'
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';
const PESAPAL_KEY     = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_SECRET  = process.env.PESAPAL_CONSUMER_SECRET;
const PESAPAL_IPN_URL = process.env.PESAPAL_IPN_URL || `${process.env.SERVER_URL || 'http://localhost:3000'}/api/payment/ipn`;
const SERVER_URL      = process.env.SERVER_URL || 'http://localhost:3000';

// In-memory order store — maps merchant_reference → { url, title, status }
// In production you would persist this to a database, but for a lightweight
// deployment this survives server restarts for the duration of a payment session.
const _pendingOrders = new Map();

// Step 1 — get a short-lived Pesapal OAuth token
async function pesapalToken() {
  const r = await fetch(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ consumer_key: PESAPAL_KEY, consumer_secret: PESAPAL_SECRET }),
  });
  const d = await r.json();
  if (!d.token) throw new Error('Pesapal auth failed: ' + JSON.stringify(d));
  return d.token;
}

// Step 2 — register our IPN url with Pesapal (returns ipn_id, cache it)
let _cachedIpnId = null;
async function getIpnId(token) {
  if (_cachedIpnId) return _cachedIpnId;
  const r = await fetch(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: PESAPAL_IPN_URL, ipn_notification_type: 'GET' }),
  });
  const d = await r.json();
  if (!d.ipn_id) throw new Error('Pesapal IPN registration failed: ' + JSON.stringify(d));
  _cachedIpnId = d.ipn_id;
  return _cachedIpnId;
}

// Initiate a payment — called from the public app when user clicks "Pay & Download"
app.post('/api/payment/initiate', async (req, res) => {
  try {
    const { bookTitle, bookUrl, amount, phoneNumber, name, network } = req.body;
    if (!bookTitle || !bookUrl || !amount || !phoneNumber || !name || !network)
      return res.status(400).json({ error: 'Missing required payment fields' });

    const token   = await pesapalToken();
    const ipn_id  = await getIpnId(token);

    // Build a unique merchant reference for this transaction
    const reference = `ZL-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    // Store pending order so we can verify it after Pesapal redirects back
    _pendingOrders.set(reference, { url: bookUrl, title: bookTitle, status: 'PENDING' });

    // Map network selection to Pesapal mobile money type
    const mobileType = network === 'MTN' ? 'MTN' : 'AIRTEL';

    const payload = {
      id: reference,
      currency: 'ZMW',
      amount: parseFloat(amount),
      description: `ZamLearn: ${bookTitle}`,
      callback_url: `${SERVER_URL}/api/payment/callback?ref=${reference}`,
      notification_id: ipn_id,
      billing_address: {
        phone_number: phoneNumber,
        first_name: name.split(' ')[0] || name,
        last_name: name.split(' ').slice(1).join(' ') || '',
        country_code: 'ZM',
      },
    };

    const r2 = await fetch(`${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const d2 = await r2.json();
    if (!d2.order_tracking_id) throw new Error('Pesapal order failed: ' + JSON.stringify(d2));

    // Update our store with the Pesapal tracking id
    _pendingOrders.set(reference, { url: bookUrl, title: bookTitle, status: 'PENDING', tracking_id: d2.order_tracking_id });

    res.json({
      success: true,
      redirect_url: d2.redirect_url,
      order_tracking_id: d2.order_tracking_id,
      merchant_reference: reference,
    });
  } catch (err) {
    console.error('[PAYMENT initiate] error:', err.message);
    res.status(500).json({ error: err.message || 'Payment initiation failed' });
  }
});

// Pesapal IPN — Pesapal calls this URL to notify us of status changes
app.get('/api/payment/ipn', async (req, res) => {
  try {
    const { orderTrackingId, orderMerchantReference } = req.query;
    if (!orderTrackingId || !orderMerchantReference) return res.status(400).send('Missing params');

    const token = await pesapalToken();
    const r = await fetch(`${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
    const d = await r.json();

    const order = _pendingOrders.get(orderMerchantReference);
    if (order) {
      order.status = d.payment_status_description || 'UNKNOWN';
      _pendingOrders.set(orderMerchantReference, order);
    }
    res.json({ orderNotificationType: 'IPNCHANGE', orderTrackingId, orderMerchantReference, status: 200 });
  } catch (err) {
    console.error('[PAYMENT ipn] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Poll payment status — called by the public app every few seconds after redirect
app.get('/api/payment/status', async (req, res) => {
  try {
    const { ref } = req.query;
    if (!ref) return res.status(400).json({ error: 'ref required' });

    const order = _pendingOrders.get(ref);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Always fetch live status from Pesapal — never trust only our in-memory store
    const token = await pesapalToken();
    const r = await fetch(`${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${order.tracking_id}`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
    const d = await r.json();

    const paid = d.payment_status_description === 'Completed';
    order.status = d.payment_status_description || order.status;
    _pendingOrders.set(ref, order);

    res.json({
      success: true,
      paid,
      status: order.status,
      // Only return the download URL if the payment is confirmed
      download_url: paid ? order.url : null,
    });
  } catch (err) {
    console.error('[PAYMENT status] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Pesapal callback — user is redirected here after completing payment on Pesapal
// We just send a script that posts the result to the parent window (our app).
app.get('/api/payment/callback', (req, res) => {
  const { ref } = req.query;
  res.send(`<!DOCTYPE html><html><body>
    <script>
      if(window.opener){ window.opener.postMessage({ type:'PESAPAL_CALLBACK', ref:'${ref}' }, '*'); }
      window.close();
    </script>
    <p>Processing payment… you can close this window.</p>
  </body></html>`);
});

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🟢 ZamLearn server running at http://localhost:${PORT}`);
});
