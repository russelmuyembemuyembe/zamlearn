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

// Cloudinary serializes context objects into a single string as
// "key=value|key=value|...". If any VALUE contains a literal "|" or "=",
// it corrupts that string and can silently truncate/drop whatever comes
// after it (e.g. a title containing "|" can wipe out "whatsapp" since
// title is serialized before whatsapp). Strip those characters so this
// can never happen, on every value we ever put into a context object.
function sanitizeContextValue(v) {
  return String(v).replace(/[|=]/g, '').trim();
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
//
// CRITICAL: unlike the upload endpoint, the Admin API's `update` action does
// NOT reliably persist context when given a plain JS object — it silently
// no-ops on some fields. It needs a raw "key=value|key=value" STRING. Values
// are already pre-sanitized (no "|" or "=") by sanitizeContextValue, so a
// plain join is safe here.
function contextObjToString(contextObj) {
  return Object.entries(contextObj)
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

function updateResourceContext(publicId, resourceType, contextObj, tags) {
  return new Promise((resolve, reject) => {
    cloudinary.api.update(
      publicId,
      {
        resource_type: resourceType, // 'raw'
        type: 'upload',
        context: contextObjToString(contextObj), // STRING form — object form silently drops fields
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


// Files uploaded before the rename live under "zamlearn/…" in Cloudinary and
// cannot be moved by the app, so listings read BOTH folders. New uploads go
// to "betastudu/…". Nothing already uploaded disappears.
async function fetchBothPrefixes(kind) {
  const [fresh, legacy] = await Promise.all([
    fetchAllResources(`betastudu/${kind}/`),
    fetchAllResources(`zamlearn/${kind}/`).catch(() => []),
  ]);
  return fresh.concat(legacy);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PAST PAPERS
// ═══════════════════════════════════════════════════════════════════════════

// Upload a past paper
app.post('/api/pastpapers/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const { grade, subject, year, examtype } = req.body;
    if (!grade || !subject || !year)
      return res.status(400).json({ error: 'grade, subject, and year are required' });

    const safeGrade   = String(grade).replace(/\s+/g, '_');
    const safeSubject = String(subject).replace(/\s+/g, '_');
    const publicId     = `betastudu/pastpapers/${safeGrade}/${year}/${safeSubject}_${Date.now()}`;

    const contextObj = {
      grade: sanitizeContextValue(grade),
      subject: sanitizeContextValue(subject),
      year: sanitizeContextValue(year),
    };
    if (examtype) contextObj.examtype = sanitizeContextValue(examtype);
    const tags = ['pastpaper', `grade_${grade}`, `year_${year}`, String(subject).toLowerCase()];
    if (examtype) tags.push(String(examtype).toLowerCase());

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
    const { grade, subject, year, examtype } = req.query;

    const resources = await fetchBothPrefixes('pastpapers');

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
        grade:      ctx.grade    || '',
        subject:    ctx.subject  || '',
        year:       ctx.year     || '',
        examtype:   ctx.examtype || '',
        bytes:      r.bytes,
        created_at: r.created_at,
      };
    });

    if (grade)    papers = papers.filter(p => p.grade === String(grade));
    if (year)     papers = papers.filter(p => p.year  === String(year));
    if (subject)  papers = papers.filter(p => p.subject.toLowerCase() === String(subject).toLowerCase());
    if (examtype) papers = papers.filter(p => p.examtype.toLowerCase() === String(examtype).toLowerCase());

    res.json({ success: true, count: papers.length, data: papers });
  } catch (err) {
    console.error('[LIST papers] error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch past papers' });
  }
});

// Update a past paper's metadata
app.put('/api/pastpapers/update', async (req, res) => {
  try {
    const { publicId, grade, subject, year, examtype } = req.body;
    if (!publicId || !grade || !subject || !year)
      return res.status(400).json({ error: 'publicId, grade, subject, and year are required' });

    const contextObj = {
      grade: sanitizeContextValue(grade),
      subject: sanitizeContextValue(subject),
      year: sanitizeContextValue(year),
    };
    if (examtype) contextObj.examtype = sanitizeContextValue(examtype);
    const tags = ['pastpaper', `grade_${grade}`, `year_${year}`, String(subject).toLowerCase()];
    if (examtype) tags.push(String(examtype).toLowerCase());

    await updateResourceContext(publicId, 'raw', contextObj, tags);

    const check = await cloudinary.api.resource(publicId, { resource_type: 'raw', type: 'upload', context: true });
    const verifiedCtx = parseContext(check.context);

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

    const { grade, title, category, whatsapp, downloadcode } = req.body;
    if (!grade || !title)
      return res.status(400).json({ error: 'grade and title are required' });

    const safeGrade = String(grade).replace(/\s+/g, '_');
    const safeTitle = String(title).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const publicId  = `betastudu/books/${safeGrade}/${safeTitle}_${Date.now()}`;

    const contextObj = {
      grade: sanitizeContextValue(grade),
      title: sanitizeContextValue(title),
    };
    if (category) contextObj.category = sanitizeContextValue(category);
    if (whatsapp) contextObj.whatsapp = sanitizeContextValue(whatsapp);
    if (downloadcode) contextObj.downloadcode = sanitizeContextValue(downloadcode);

    const tags = ['book', `grade_${grade}`];
    if (category)     tags.push(String(category).toLowerCase().replace(/\s+/g, '_'));
    if (whatsapp)     tags.push('whatsapp_required');
    if (downloadcode) tags.push('has_code');

    console.log(`[UPLOAD book] context →`, JSON.stringify(contextObj));

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
        url:       result.secure_url,
        grade:     String(grade),
        title:     String(title),
        category:  category  ? String(category)  : '',
        whatsapp:  whatsapp  ? String(whatsapp).trim() : '',
        downloadcode: downloadcode ? sanitizeContextValue(downloadcode) : '',
        bytes:     result.bytes,
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
    const { grade, category, admin } = req.query;

    // The public app must NEVER receive the raw download code — otherwise anyone
    // could read it out of the JSON response. The admin panel asks for it
    // explicitly with ?admin=1 so it can display and edit codes.
    const isAdmin = String(admin) === '1';

    const resources = await fetchBothPrefixes('books');

    let books = resources.map(r => {
      const ctx = parseContext(r.context);
      const code = (ctx.downloadcode || '').trim();
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
        grade:      ctx.grade     || '',
        title:      ctx.title     || '',
        category:   ctx.category  || '',
        whatsapp:   ctx.whatsapp  || '',
        has_code:   !!code,                        // public: only "is there a code?"
        downloadcode: isAdmin ? code : undefined,  // admin only — dropped from JSON otherwise
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
    const { publicId, grade, title, category, whatsapp, downloadcode } = req.body;
    if (!publicId || !grade || !title)
      return res.status(400).json({ error: 'publicId, grade, and title are required' });

    const categoryProvided = typeof category === 'string' && category.trim().length > 0;
    const cleanCategory    = categoryProvided ? sanitizeContextValue(category) : '';
    const cleanWhatsapp    = typeof whatsapp === 'string' ? sanitizeContextValue(whatsapp) : '';
    // Sending an empty downloadcode removes it (context is replaced, not merged).
    const cleanCode        = typeof downloadcode === 'string' ? sanitizeContextValue(downloadcode) : '';

    const contextObj = {
      grade: sanitizeContextValue(grade),
      title: sanitizeContextValue(title),
    };
    if (categoryProvided) contextObj.category = cleanCategory;
    if (cleanWhatsapp)    contextObj.whatsapp  = cleanWhatsapp;
    if (cleanCode)        contextObj.downloadcode = cleanCode;

    console.log(`[UPDATE book] ${publicId} sending context →`, JSON.stringify(contextObj));

    const tags = ['book', `grade_${grade}`];
    if (categoryProvided) tags.push(cleanCategory.toLowerCase().replace(/\s+/g, '_'));
    if (cleanWhatsapp)    tags.push('whatsapp_required');
    if (cleanCode)        tags.push('has_code');

    await updateResourceContext(publicId, 'raw', contextObj, tags);

    const check       = await cloudinary.api.resource(publicId, { resource_type: 'raw', type: 'upload', context: true });
    const verifiedCtx = parseContext(check.context);
    console.log(`[UPDATE book] ${publicId} readback →`, JSON.stringify(verifiedCtx));

    const gradeOk    = verifiedCtx.grade === String(grade);
    const titleOk    = verifiedCtx.title === String(title);
    const categoryOk = categoryProvided ? (verifiedCtx.category === cleanCategory) : true;
    const whatsappOk = cleanWhatsapp    ? (verifiedCtx.whatsapp  === cleanWhatsapp)  : true;
    const codeOk     = cleanCode        ? (verifiedCtx.downloadcode === cleanCode)   : true;

    if (!gradeOk || !titleOk || !categoryOk || !whatsappOk || !codeOk) {
      return res.status(500).json({
        error: `Update did not fully persist. Sent: ${JSON.stringify(contextObj)} — Cloudinary has: ${JSON.stringify(verifiedCtx)}`,
      });
    }

    res.json({ success: true, message: 'Book updated', verified: verifiedCtx });
  } catch (err) {
    console.error('[UPDATE book] error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
});

// ── Verify a download code ────────────────────────────────────────────────
// The public app sends { publicId, code }. If the code matches the one the
// admin saved on that book, we hand back a fresh signed URL. The code itself
// never leaves the server, so it can't be read out of any list response.
//
// Simple in-memory brute-force guard: a short code is easy to guess by
// scripting, so each IP gets a limited number of WRONG tries per window.
const _codeAttempts = new Map(); // ip → { count, resetAt }
const MAX_TRIES   = 10;
const TRY_WINDOW  = 10 * 60 * 1000; // 10 minutes

function tooManyTries(ip) {
  const rec = _codeAttempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) return false;
  return rec.count >= MAX_TRIES;
}
function noteFailedTry(ip) {
  const rec = _codeAttempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) {
    _codeAttempts.set(ip, { count: 1, resetAt: Date.now() + TRY_WINDOW });
  } else {
    rec.count++;
  }
}

app.post('/api/books/verify-code', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    if (tooManyTries(ip))
      return res.status(429).json({ error: 'Too many wrong codes. Please try again in 10 minutes.' });

    const { publicId, code } = req.body;
    if (!publicId || !code)
      return res.status(400).json({ error: 'publicId and code are required' });

    let resource;
    try {
      resource = await cloudinary.api.resource(publicId, {
        resource_type: 'raw', type: 'upload', context: true,
      });
    } catch (e) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const ctx      = parseContext(resource.context);
    const realCode = (ctx.downloadcode || '').trim();

    if (!realCode)
      return res.status(404).json({ error: 'This book has no download code yet. Please contact us on WhatsApp.' });

    // Codes are stored already sanitized, so sanitize the input the same way
    // before comparing. Case-insensitive so "zl-7k4q2" works too.
    const given = sanitizeContextValue(code);
    if (given.toLowerCase() !== realCode.toLowerCase()) {
      noteFailedTry(ip);
      return res.status(403).json({ error: 'Invalid download code' });
    }

    _codeAttempts.delete(ip); // correct code clears the counter

    const signedUrl = cloudinary.url(publicId, {
      resource_type: 'raw',
      type: 'upload',
      secure: true,
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    console.log(`[VERIFY code] unlocked ${publicId}`);
    res.json({ success: true, url: signedUrl, title: ctx.title || '', grade: ctx.grade || '' });
  } catch (err) {
    console.error('[VERIFY code] error:', err);
    res.status(500).json({ error: err.message || 'Could not verify code' });
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
//  ANALYTICS  (in-memory, saved to stats.json so restarts don't wipe it)
// ═══════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const STATS_FILE   = path.join(__dirname, 'stats.json');
const ONLINE_MS    = 70 * 1000;          // "online" = heartbeat in the last 70 s
const SESSION_KEEP = 24 * 3600 * 1000;   // keep session rows for 24 h
const SECTIONS = new Set(['papers','books','timetable','notes','study','timer','grades','formulas','flashcards','exams','home','other']);

app.set('trust proxy', true);            // real client IP behind Render's proxy

const sessions = new Map();              // sid -> live session
let totals = {
  since: Date.now(), visits: 0, peakOnline: 0, peakAt: 0,
  sections: {}, searches: {}, downloads: 0, downloadItems: {},
  daily: {},                             // 'YYYY-MM-DD' -> { visits, uniq:[sid...] }
  hourly: {},                            // 'YYYY-MM-DDTHH' -> pings
};
try {
  if (fs.existsSync(STATS_FILE)) totals = Object.assign(totals, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')));
} catch (e) { console.warn('[stats] could not load stats.json:', e.message); }

function saveStats() {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(totals)); } catch (_) {}
}
setInterval(saveStats, 60 * 1000).unref();
process.on('SIGTERM', () => { saveStats(); process.exit(0); });

const dayKey  = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 13);
const bump = (obj, key, n = 1) => { if (key) obj[key] = (obj[key] || 0) + n; };
const clean = (v, max = 60) => String(v == null ? '' : v).replace(/[^\w\s.\-&()+/:]/g, '').trim().slice(0, max);

function maskIp(ip) {
  ip = String(ip || '').replace('::ffff:', '');
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : 'unknown';
}
function parseUA(ua = '') {
  const device  = /Mobi|Android|iPhone|iPad/i.test(ua) ? (/iPad|Tablet/i.test(ua) ? 'Tablet' : 'Phone') : 'Desktop';
  const os      = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
                : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Chrome\//i.test(ua) ? 'Chrome'
                : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Other';
  return { device, os, browser };
}
function onlineCount() {
  const now = Date.now(); let n = 0;
  sessions.forEach(s => { if (now - s.lastSeen < ONLINE_MS) n++; });
  return n;
}
function touchSession(req, sid, section) {
  sid = clean(sid, 40);
  if (!sid) return null;
  const now = Date.now();
  let s = sessions.get(sid);
  if (!s) {
    s = { sid, first: now, lastSeen: now, section: 'home', trail: [], pings: 0,
          ip: maskIp(req.ip), ...parseUA(req.get('user-agent') || '') };
    sessions.set(sid, s);
    totals.visits++;
    const d = (totals.daily[dayKey()] ||= { visits: 0, uniq: [] });
    d.visits++;
    if (!d.uniq.includes(sid)) d.uniq.push(sid);
  }
  s.lastSeen = now; s.pings++;
  if (section) {
    section = SECTIONS.has(section) ? section : 'other';
    if (section !== s.section || !s.trail.length) {
      s.section = section;
      s.trail.push({ section, at: now });
      if (s.trail.length > 15) s.trail.shift();
      bump(totals.sections, section);
    }
  }
  bump(totals.hourly, hourKey());
  const on = onlineCount();
  if (on > totals.peakOnline) { totals.peakOnline = on; totals.peakAt = now; }
  return s;
}
setInterval(() => {                       // housekeeping
  const cut = Date.now() - SESSION_KEEP;
  sessions.forEach((s, k) => { if (s.lastSeen < cut) sessions.delete(k); });
  const keepDays = Object.keys(totals.daily).sort().slice(-60);
  Object.keys(totals.daily).forEach(k => { if (!keepDays.includes(k)) delete totals.daily[k]; });
  const keepHours = Object.keys(totals.hourly).sort().slice(-72);
  Object.keys(totals.hourly).forEach(k => { if (!keepHours.includes(k)) delete totals.hourly[k]; });
}, 10 * 60 * 1000).unref();

// Public tracking endpoints — always answer 204 so a failing tracker can
// never produce an error or slow down the student app.
app.post('/api/track/ping', (req, res) => {
  try { touchSession(req, req.body.sid, clean(req.body.section, 20)); } catch (_) {}
  res.sendStatus(204);
});
app.post('/api/track/event', (req, res) => {
  try {
    const { sid, type, label, section } = req.body || {};
    touchSession(req, sid, clean(section, 20));
    const l = clean(label, 80);
    if (type === 'search' && l) bump(totals.searches, l);
    if (type === 'download') { totals.downloads++; bump(totals.downloadItems, l || 'Unknown'); }
  } catch (_) {}
  res.sendStatus(204);
});

// Admin statistics
app.get('/api/admin/stats', (_req, res) => {
  const now = Date.now();
  const online = [];
  sessions.forEach(s => { if (now - s.lastSeen < ONLINE_MS) online.push(s); });
  online.sort((a, b) => b.lastSeen - a.lastSeen);

  const top = (obj, n = 8) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayKey(now - i * 86400000);
    const d = totals.daily[k] || { visits: 0, uniq: [] };
    days.push({ day: k, visits: d.visits, unique: d.uniq.length });
  }
  const hours = [];
  for (let i = 23; i >= 0; i--) {
    const k = hourKey(now - i * 3600000);
    hours.push({ hour: k.slice(11) + ':00', pings: totals.hourly[k] || 0 });
  }
  const today = totals.daily[dayKey()] || { visits: 0, uniq: [] };
  const mix = key => { const o = {}; online.forEach(s => bump(o, s[key])); return top(o, 6); };

  res.json({
    success: true,
    serverTime: now,
    since: totals.since,
    onlineNow: online.length,
    peakOnline: totals.peakOnline,
    peakAt: totals.peakAt,
    visitsToday: today.visits,
    uniqueToday: today.uniq.length,
    totalVisits: totals.visits,
    totalDownloads: totals.downloads,
    sections: top(totals.sections, 12),
    searches: top(totals.searches, 8),
    downloadsTop: top(totals.downloadItems, 8),
    devices: mix('device'), systems: mix('os'), browsers: mix('browser'),
    onlineBySection: (() => { const o = {}; online.forEach(s => bump(o, s.section)); return top(o, 12); })(),
    days, hours,
    users: online.slice(0, 100).map(s => ({
      id: s.sid.slice(0, 6), ip: s.ip, device: s.device, os: s.os, browser: s.browser,
      section: s.section, onlineFor: Math.round((now - s.first) / 1000),
      idleFor: Math.round((now - s.lastSeen) / 1000),
      trail: s.trail.slice(-5).map(t => t.section),
    })),
  });
});


// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  // tracking must never surface an error to the student app
  if (req.path.startsWith('/api/track')) return res.sendStatus(204);
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🟢 BetaStudu server running at http://localhost:${PORT}`);
});
