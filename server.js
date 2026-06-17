require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Cloudinary config ──────────────────────────────────────────────────────
// Replace these with your real Cloudinary credentials
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'YOUR_CLOUD_NAME',
  api_key:    process.env.CLOUDINARY_API_KEY    || 'YOUR_API_KEY',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'YOUR_API_SECRET',
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
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

// ── Helper: upload buffer to Cloudinary ───────────────────────────────────
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  PAST PAPERS
// ══════════════════════════════════════════════════════════════════════════

// Upload a past paper
app.post('/api/pastpapers/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const { grade, subject, year } = req.body;
    if (!grade || !subject || !year)
      return res.status(400).json({ error: 'grade, subject, and year are required' });

    const safeGrade   = grade.replace(/\s+/g, '_');
    const safeSubject = subject.replace(/\s+/g, '_');
    const publicId    = `zamlearn/pastpapers/${safeGrade}/${year}/${safeSubject}_${Date.now()}`;

    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'raw',
      public_id: publicId,
      format: 'pdf',
      access_mode: 'public',          // ← make file publicly accessible
      context: `grade=${grade}|subject=${subject}|year=${year}`,
      tags: ['pastpaper', `grade_${grade}`, `year_${year}`, subject.toLowerCase()],
    });

    res.json({
      success: true,
      message: 'Past paper uploaded successfully',
      data: {
        public_id: result.public_id,
        url: result.secure_url,
        grade,
        subject,
        year,
        bytes: result.bytes,
      },
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// List past papers (with optional filters)
app.get('/api/pastpapers', async (req, res) => {
  try {
    const { grade, subject, year } = req.query;

    // Use Resources API (works on all free Cloudinary plans)
    const result = await cloudinary.api.resources({
      resource_type: 'raw',
      type: 'upload',
      prefix: 'zamlearn/pastpapers/',
      max_results: 500,
      context: true,
      tags: true,
    });

    let papers = result.resources.map(r => {
      const ctx = r.context?.custom || {};
      // Generate a signed URL valid for 1 hour — works for both public and restricted files
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

    // Filter in-memory since Resources API doesn't support tag filtering on free plan
    if (grade)   papers = papers.filter(p => p.grade   === grade);
    if (year)    papers = papers.filter(p => p.year    === year);
    if (subject) papers = papers.filter(p => p.subject.toLowerCase() === subject.toLowerCase());

    res.json({ success: true, count: papers.length, data: papers });
  } catch (err) {
    console.error('List error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch past papers' });
  }
});

// Update a past paper's metadata
app.put('/api/pastpapers/:publicId(*)/update', async (req, res) => {
  try {
    const publicId = req.params.publicId;
    const { grade, subject, year } = req.body;
    if (!grade || !subject || !year)
      return res.status(400).json({ error: 'grade, subject, and year are required' });

    await cloudinary.uploader.explicit(publicId, {
      resource_type: 'raw',
      type: 'upload',
      context: `grade=${grade}|subject=${subject}|year=${year}`,
      tags: ['pastpaper', `grade_${grade}`, `year_${year}`, subject.toLowerCase()],
    });

    res.json({ success: true, message: 'Past paper updated' });
  } catch (err) {
    console.error('Update error:', err);
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
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  BOOKS
// ══════════════════════════════════════════════════════════════════════════

// Upload a book
app.post('/api/books/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const { grade, title, category } = req.body;
    if (!grade || !title)
      return res.status(400).json({ error: 'grade and title are required' });

    const safeGrade = grade.replace(/\s+/g, '_');
    const safeTitle = title.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const publicId  = `zamlearn/books/${safeGrade}/${safeTitle}_${Date.now()}`;

    const contextStr = [`grade=${grade}`, `title=${title}`];
    if (category) contextStr.push(`category=${category}`);

    const tags = ['book', `grade_${grade}`];
    if (category) tags.push(category.toLowerCase().replace(/\s+/g,'_'));

    const result = await uploadToCloudinary(req.file.buffer, {
      resource_type: 'raw',
      public_id: publicId,
      format: 'pdf',
      access_mode: 'public',
      context: contextStr.join('|'),
      tags,
    });

    res.json({
      success: true,
      message: 'Book uploaded successfully',
      data: {
        public_id: result.public_id,
        url: result.secure_url,
        grade,
        title,
        category: category || '',
        bytes: result.bytes,
      },
    });
  } catch (err) {
    console.error('Upload error:', err);
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
      const ctx = r.context?.custom || {};
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

    if (grade)    books = books.filter(b => b.grade === grade);
    if (category) books = books.filter(b => b.category.toLowerCase() === category.toLowerCase());

    res.json({ success: true, count: books.length, data: books });
  } catch (err) {
    console.error('List error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch books' });
  }
});
// Update a book's metadata
app.put('/api/books/:publicId(*)/update', async (req, res) => {
  try {
    const publicId = req.params.publicId;
    const { grade, title, category } = req.body;
    if (!grade || !title)
      return res.status(400).json({ error: 'grade and title are required' });

    const contextStr = [`grade=${grade}`, `title=${title}`];
    if (category) contextStr.push(`category=${category}`);

    const tags = ['book', `grade_${grade}`];
    if (category) tags.push(category.toLowerCase().replace(/\s+/g,'_'));

    await cloudinary.uploader.explicit(publicId, {
      resource_type: 'raw',
      type: 'upload',
      context: contextStr.join('|'),
      tags,
    });

    res.json({ success: true, message: 'Book updated' });
  } catch (err) {
    console.error('Update error:', err);
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
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🟢 ZamLearn server running at http://localhost:${PORT}`);
});