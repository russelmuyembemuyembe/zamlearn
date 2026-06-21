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

    console.log(`[UPLOAD paper] ${publicId} context →`, JSON.stringify(contextObj));

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

    const result = await cloudinary.api.resources({
      resource_type: 'raw',
      type: 'upload',
      prefix: 'zamlearn/pastpapers/',
      max_results: 500,
      context: true,
      tags: true,
    });

    let papers = result.resources.map(r => {
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

    const { grade, title, category } = req.body;
    if (!grade || !title)
      return res.status(400).json({ error: 'grade and title are required' });

    const safeGrade = String(grade).replace(/\s+/g, '_');
    const safeTitle = String(title).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const publicId  = `zamlearn/books/${safeGrade}/${safeTitle}_${Date.now()}`;

    const contextObj = { grade: String(grade), title: String(title) };
    if (category) contextObj.category = String(category);

    const tags = ['book', `grade_${grade}`];
    if (category) tags.push(String(category).toLowerCase().replace(/\s+/g, '_'));

    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'raw',
      public_id: publicId,
      format: 'pdf',
      access_mode: 'public',
      context: contextObj,
      tags,
    });

    console.log(`[UPLOAD book] ${publicId} context →`, JSON.stringify(contextObj));

    res.json({
      success: true,
      message: 'Book uploaded successfully',
      data: {
        public_id: result.public_id,
        url: result.secure_url,
        grade: String(grade),
        title: String(title),
        category: category ? String(category) : '',
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

    const result = await cloudinary.api.resources({
      resource_type: 'raw',
      type: 'upload',
      prefix: 'zamlearn/books/',
      max_results: 500,
      context: true,
      tags: true,
    });

    let books = result.resources.map(r => {
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
    const { publicId, grade, title, category } = req.body;
    if (!publicId || !grade || !title)
      return res.status(400).json({ error: 'publicId, grade, and title are required' });

    const contextObj = { grade: String(grade), title: String(title) };
    if (category) contextObj.category = String(category);

    const tags = ['book', `grade_${grade}`];
    if (category) tags.push(String(category).toLowerCase().replace(/\s+/g, '_'));

    await updateResourceContext(publicId, 'raw', contextObj, tags);

    // Self-verify: read the resource back immediately to confirm context stuck
    const check = await cloudinary.api.resource(publicId, { resource_type: 'raw', type: 'upload', context: true });
    const verifiedCtx = parseContext(check.context);
    console.log(`[UPDATE book] ${publicId} wrote →`, JSON.stringify(contextObj), 'readback →', JSON.stringify(verifiedCtx));

    const ok = verifiedCtx.grade === String(grade)
      && verifiedCtx.title === String(title)
      && (!category || verifiedCtx.category === String(category));
    if (!ok) {
      return res.status(500).json({
        error: 'Update sent but Cloudinary did not persist it. Readback: ' + JSON.stringify(verifiedCtx),
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

// ── DEBUG: inspect raw Cloudinary response shape for one resource ─────────
app.get('/api/debug/resource', async (req, res) => {
  try {
    const { publicId, resourceType } = req.query;
    if (!publicId) return res.status(400).json({ error: 'publicId query param required' });
    const result = await cloudinary.api.resource(publicId, {
      resource_type: resourceType || 'raw',
      type: 'upload',
      context: true,
      tags: true,
    });
    res.json({ success: true, raw: result, parsedContext: parseContext(result.context) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/books-raw', async (req, res) => {
  try {
    const result = await cloudinary.api.resources({
      resource_type: 'raw',
      type: 'upload',
      prefix: 'zamlearn/books/',
      max_results: 10,
      context: true,
      tags: true,
    });
    res.json({
      success: true,
      raw: result.resources,
      parsed: result.resources.map(r => ({ public_id: r.public_id, context: parseContext(r.context) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
