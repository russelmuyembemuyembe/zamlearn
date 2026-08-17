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
    const publicId     = `zamlearn/pastpapers/${safeGrade}/${year}/${safeSubject}_${Date.now()}`;

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

    const { grade, title, category, whatsapp } = req.body;
    if (!grade || !title)
      return res.status(400).json({ error: 'grade and title are required' });

    const safeGrade = String(grade).replace(/\s+/g, '_');
    const safeTitle = String(title).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const publicId  = `zamlearn/books/${safeGrade}/${safeTitle}_${Date.now()}`;

    const contextObj = {
      grade: sanitizeContextValue(grade),
      title: sanitizeContextValue(title),
    };
    if (category) contextObj.category = sanitizeContextValue(category);
    if (whatsapp) contextObj.whatsapp = sanitizeContextValue(whatsapp);

    const tags = ['book', `grade_${grade}`];
    if (category) tags.push(String(category).toLowerCase().replace(/\s+/g, '_'));
    if (whatsapp) tags.push('whatsapp_required');

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
        grade:      ctx.grade     || '',
        title:      ctx.title     || '',
        category:   ctx.category  || '',
        whatsapp:   ctx.whatsapp  || '',
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
    const { publicId, grade, title, category, whatsapp } = req.body;
    if (!publicId || !grade || !title)
      return res.status(400).json({ error: 'publicId, grade, and title are required' });

    const categoryProvided = typeof category === 'string' && category.trim().length > 0;
    const cleanCategory    = categoryProvided ? sanitizeContextValue(category) : '';
    const cleanWhatsapp    = typeof whatsapp === 'string' ? sanitizeContextValue(whatsapp) : '';

    const contextObj = {
      grade: sanitizeContextValue(grade),
      title: sanitizeContextValue(title),
    };
    if (categoryProvided) contextObj.category = cleanCategory;
    if (cleanWhatsapp)    contextObj.whatsapp  = cleanWhatsapp;

    console.log(`[UPDATE book] ${publicId} sending context →`, JSON.stringify(contextObj));

    const tags = ['book', `grade_${grade}`];
    if (categoryProvided) tags.push(cleanCategory.toLowerCase().replace(/\s+/g, '_'));
    if (cleanWhatsapp)    tags.push('whatsapp_required');

    await updateResourceContext(publicId, 'raw', contextObj, tags);

    const check       = await cloudinary.api.resource(publicId, { resource_type: 'raw', type: 'upload', context: true });
    const verifiedCtx = parseContext(check.context);
    console.log(`[UPDATE book] ${publicId} readback →`, JSON.stringify(verifiedCtx));

    const gradeOk    = verifiedCtx.grade === String(grade);
    const titleOk    = verifiedCtx.title === String(title);
    const categoryOk = categoryProvided ? (verifiedCtx.category === cleanCategory) : true;
    const whatsappOk = cleanWhatsapp    ? (verifiedCtx.whatsapp  === cleanWhatsapp)  : true;

    if (!gradeOk || !titleOk || !categoryOk || !whatsappOk) {
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


// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🟢 ZamLearn server running at http://localhost:${PORT}`);
});
