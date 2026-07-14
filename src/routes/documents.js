const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate } = require('../middleware/auth');
const { deleteFile: b2Delete } = require('../b2');
const path = require('path');
const fs = require('fs');

const router = Router();

function isAdminManager(req) {
  return ['admin', 'manager'].includes(req.user?.role);
}

function isVisitOwner(db, visitId, userId) {
  return db.execute({ sql: 'SELECT author_id FROM visits WHERE id = ?', args: [visitId] }).then(r => {
    const v = r.rows[0];
    return v && Number(v.author_id) === Number(userId);
  });
}

router.get('/:visit_id', authenticate, async (req, res) => {
  const db = getDb();
  const isOwner = await isVisitOwner(db, req.params.visit_id, req.user.id);
  if (!isOwner && !isAdminManager(req)) return res.status(403).json({ error: 'Access denied' });
  const r = await db.execute({
    sql: `SELECT d.*, u.display_name as uploaded_by_name FROM visit_documents d JOIN users u ON d.uploaded_by = u.id WHERE d.visit_id = ? ORDER BY d.created_at ASC`,
    args: [req.params.visit_id]
  });
  res.json(r.rows);
});

router.post('/:visit_id', authenticate, async (req, res) => {
  const { filename, original_name, file_url, file_size, file_type, doc_type, url, size, mimetype } = req.body;
  const finalUrl = file_url || url || '';
  const finalSize = file_size || size || 0;
  const finalType = file_type || mimetype || '';
  if (!filename || !finalUrl) return res.status(400).json({ error: 'filename and file_url required' });

  const db = getDb();
  const vr = await db.execute({ sql: 'SELECT id, author_id FROM visits WHERE id = ?', args: [req.params.visit_id] });
  if (!vr.rows[0]) return res.status(404).json({ error: 'Visit not found' });
  const isOwner = Number(vr.rows[0].author_id) === Number(req.user.id);
  if (!isOwner && !isAdminManager(req)) return res.status(403).json({ error: 'Access denied' });

  // Validate file_url: disallow path traversal
  if (finalUrl.includes('..')) return res.status(400).json({ error: 'Invalid file_url' });

  const ir = await db.execute({
    sql: 'INSERT INTO visit_documents (visit_id, filename, original_name, file_url, file_size, file_type, uploaded_by, doc_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [
      req.params.visit_id, filename, (original_name || filename).slice(0, 255),
      finalUrl, parseInt(finalSize) || 0, (finalType || '').slice(0, 100),
      req.user.id, (doc_type || '').slice(0, 50)
    ]
  });
  const dr = await db.execute({ sql: 'SELECT id, visit_id, filename, original_name, file_url, file_size, file_type, uploaded_by, doc_type, created_at FROM visit_documents WHERE id = ?', args: [Number(ir.lastInsertRowid)] });
  res.status(201).json(dr.rows[0]);
});

router.delete('/:visit_id/:doc_id', authenticate, async (req, res) => {
  const db = getDb();
  const docR = await db.execute({ sql: 'SELECT d.*, v.author_id FROM visit_documents d JOIN visits v ON v.id = d.visit_id WHERE d.id = ? AND d.visit_id = ?', args: [req.params.doc_id, req.params.visit_id] });
  const doc = docR.rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const isOwner = Number(doc.author_id) === Number(req.user.id);
  if (!isOwner && !isAdminManager(req)) return res.status(403).json({ error: 'Access denied' });

  // Try B2 deletion if the file was stored there (filename starts with "viset/")
  if (doc.filename && doc.filename.startsWith('viset/')) {
    try { await b2Delete(doc.filename); } catch (e) { console.warn('B2 delete warning:', e.message); }
  } else {
    // Local file deletion — only allow files under /uploads/
    const relativeUrl = doc?.file_url || '';
    if (relativeUrl.startsWith('/uploads/')) {
      const normalized = path.normalize(relativeUrl).replace(/^(\.\.(\/|\\|$))+/, '');
      if (!normalized.includes('..')) {
        const fpath = path.join(__dirname, '..', '..', normalized);
        try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch (e) { /* ignore */ }
      }
    }
  }

  await db.execute({ sql: 'DELETE FROM visit_documents WHERE id = ?', args: [req.params.doc_id] });
  res.json({ deleted: true });
});

module.exports = router;
