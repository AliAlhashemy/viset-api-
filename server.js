require('dotenv').config();
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { getDb, initDb } = require('./src/database');
const uuid = require('uuid').v4;
const { uploadFile: b2Upload } = require('./src/b2');

const authRoutes = require('./src/routes/auth');
const visitRoutes = require('./src/routes/visits');
const customerRoutes = require('./src/routes/customers');
const userRoutes = require('./src/routes/users');
const reportRoutes = require('./src/routes/reports');
const geocodeRoutes = require('./src/routes/geocode');
const departmentRoutes = require('./src/routes/departments');
const jobTitleRoutes = require('./src/routes/job-titles');
const documentRoutes = require('./src/routes/documents');
const workflowRoutes = require('./src/routes/workflow');
const taskTypeRoutes = require('./src/routes/task-types');
const ticketRoutes = require('./src/routes/tickets');
const permissionRoutes = require('./src/routes/permissions');
const { authenticate } = require('./src/middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's reverse proxy for rate limiter IP detection
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https://tile.openstreetmap.org", "data:", "https://*.backblazeb2.com"],
      frameSrc: ["'self'", "https://www.openstreetmap.org"],
      connectSrc: ["'self'"],
    },
  },
}));

// CORS — restrict in production
const prodDomain = process.env.RAILWAY_STATIC_URL || 'https://viset-api-production.up.railway.app';
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : [prodDomain, 'http://localhost:3000'];
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
// Server-side auth for protected static pages
app.use((req, res, next) => {
  const isAdmin = req.path.startsWith('/admin/');
  const isManager = req.path.startsWith('/manager/');
  if (!isAdmin && !isManager) return next();

  const cookieToken = req.headers.cookie?.split(';').find(c => c.trim().startsWith('viset_token='))?.split('=')[1];
  const token = req.headers.authorization?.split(' ')[1] || cookieToken;
  if (!token) return res.redirect('/');

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'fallback-secret') return res.redirect('/');
    const decoded = jwt.verify(token, secret);
    const db = getDb();
    db.execute({ sql: 'SELECT id, username, role FROM users WHERE id = ?', args: [decoded.userId] })
      .then(r => {
        if (!r.rows[0]) return res.redirect('/');
        const role = r.rows[0].role;
        if (isAdmin && !['admin', 'supervisor', 'accountant'].includes(role)) return res.redirect('/');
        if (isManager && !['admin', 'manager'].includes(role)) return res.redirect('/');
        req.user = r.rows[0];
        next();
      })
      .catch(() => res.redirect('/'));
  } catch (e) {
    return res.redirect('/');
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary config (auto-reads CLOUDINARY_URL from .env)
if (process.env.CLOUDINARY_URL) {
  console.log('Cloudinary configured: image uploads enabled');
} else {
  console.log('Cloudinary not configured, using local file uploads');
}

// Rate limit login to prevent brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per 15 min per IP
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', loginLimiter);

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

function saveToDisk(buffer, filename) {
  const fpath = path.join(uploadDir, filename);
  fs.writeFileSync(fpath, buffer);
  return `/uploads/${filename}`;
}

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/upload', authenticate, (req, res, next) => {
  memoryUpload.single('file')(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const filename = `photo_${Date.now()}_${uuid().slice(0, 8)}${req.file.mimetype === 'image/png' ? '.png' : '.jpg'}`;
    try {
      const result = await b2Upload(req.file.buffer, filename, req.file.mimetype);
      res.json({ id: Date.now(), url: result.url, filename: result.key });
    } catch (e) {
      const url = saveToDisk(req.file.buffer, filename);
      res.json({ id: Date.now(), url, filename });
    }
  });
});

const allowedDocMimes = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg', 'image/png', 'image/webp',
];

const docMemoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => { allowedDocMimes.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF, Word, Excel, and image files allowed')); } });

app.post('/api/upload/document', authenticate, (req, res, next) => {
  docMemoryUpload.single('file')(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const filename = `doc_${Date.now()}_${uuid().slice(0, 8)}${path.extname(req.file.originalname) || '.bin'}`;
    try {
      const result = await b2Upload(req.file.buffer, filename, req.file.mimetype);
      res.json({
        filename: result.key,
        original_name: req.file.originalname,
        url: result.url,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    } catch (e) {
      const url = saveToDisk(req.file.buffer, filename);
      res.json({
        filename,
        original_name: req.file.originalname,
        url,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    }
  });
});

app.use('/uploads', express.static(uploadDir, {
  setHeaders: (res) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'attachment');
  },
}));

// Token auth helper for CSV downloads (cookie + query param support)
app.use('/api', async (req, res, next) => {
  const cookieToken = req.headers.cookie?.split(';').find(c => c.trim().startsWith('viset_token='))?.split('=')[1];
  const token = req.query.token || cookieToken;
  if (!token) return next();
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'fallback-secret') throw new Error('JWT_SECRET not set');
    const decoded = jwt.verify(token, secret);
    const db = getDb();
    const r = await db.execute({ sql: 'SELECT id, username, role FROM users WHERE id = ?', args: [decoded.userId] });
    if (r.rows[0]) req.user = r.rows[0];
  } catch (e) { /* ignore invalid tokens */ }
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/users', userRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/geocode', geocodeRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/job-titles', jobTitleRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/workflow', workflowRoutes);
app.use('/api/task-types', taskTypeRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/permissions', permissionRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/diagnostics', authenticate, (req, res) => {
  const url = process.env.TURSO_URL || 'not-set';
  const masked = url.startsWith('libsql://') ? url.slice(0, 25) + '...' : url;
  res.json({
    db_type: url.startsWith('libsql://') ? 'Turso cloud' : 'Local SQLite',
    db_url_prefix: masked,
    has_token: !!process.env.TURSO_TOKEN,
    jwt_set: !!process.env.JWT_SECRET,
  });
});

// Proxy to serve Cloudinary files only (SSRF-safe)
app.get('/api/proxy/file', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  if (!req.user) return res.status(401).json({ error: 'No token provided' });
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'res.cloudinary.com') return res.status(403).json({ error: 'Only Cloudinary URLs allowed' });
    if (parsed.protocol !== 'https:') return res.status(403).json({ error: 'HTTPS only' });
    const ext = path.extname(parsed.pathname).toLowerCase();
    const mimeMap = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status >= 400) return res.status(502).json({ error: 'Failed to fetch file' });
    const buf = Buffer.from(await response.arrayBuffer());
    res.set('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.set('Content-Disposition', 'inline; filename="file' + ext + '"');
    res.set('Content-Length', buf.length);
    res.end(buf);
  } catch (e) {
    res.status(502).json({ error: 'Proxy error' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack || err.message);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 2MB)' });
    return res.status(400).json({ error: err.message });
  }
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

// Fallback for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb().then(() => {
  const dbUrl = process.env.TURSO_URL || `file:${process.env.DB_PATH || './data/viset.db'}`;
  console.log(`Database: ${dbUrl.startsWith('libsql://') ? 'Turso cloud' : 'Local SQLite'}`);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VISET API running on http://localhost:${PORT}`);
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'fallback-secret') {
      console.warn('WARNING: JWT_SECRET not set. Set a strong random secret in Railway variables.');
    }
  });
}).catch(err => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
