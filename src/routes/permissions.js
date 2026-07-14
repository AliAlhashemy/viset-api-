const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = Router();

// Get all permissions
router.get('/', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: 'SELECT * FROM permissions ORDER BY name' });
  res.json(r.rows);
});

// Get all labels (with permission count)
router.get('/labels', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: `SELECT l.*, (SELECT COUNT(*) FROM label_permissions WHERE label_id = l.id) as perm_count FROM labels l ORDER BY l.name` });
  res.json(r.rows);
});

// Create label
router.post('/labels', authenticate, requireAdmin, async (req, res) => {
  const { name, color, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const db = getDb();
  const ir = await db.execute({ sql: 'INSERT INTO labels (name, color, description) VALUES (?, ?, ?)', args: [name.trim(), color || '#6366f1', description || ''] });
  const rr = await db.execute({ sql: 'SELECT * FROM labels WHERE id = ?', args: [Number(ir.lastInsertRowid)] });
  res.status(201).json(rr.rows[0]);
});

// Update label
router.put('/labels/:id', authenticate, requireAdmin, async (req, res) => {
  const { name, color, description } = req.body;
  const db = getDb();
  await db.execute({ sql: 'UPDATE labels SET name = ?, color = ?, description = ? WHERE id = ?', args: [name, color, description, req.params.id] });
  const rr = await db.execute({ sql: 'SELECT * FROM labels WHERE id = ?', args: [req.params.id] });
  res.json(rr.rows[0]);
});

// Delete label
router.delete('/labels/:id', authenticate, requireAdmin, async (req, res) => {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM labels WHERE id = ?', args: [req.params.id] });
  res.json({ deleted: true });
});

// Get permissions for a label
router.get('/labels/:id/permissions', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: `SELECT p.* FROM permissions p JOIN label_permissions lp ON lp.permission_id = p.id WHERE lp.label_id = ? ORDER BY p.name`, args: [req.params.id] });
  res.json(r.rows);
});

// Set permissions for a label (replace all)
router.put('/labels/:id/permissions', authenticate, requireAdmin, async (req, res) => {
  const { permission_ids } = req.body;
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM label_permissions WHERE label_id = ?', args: [req.params.id] });
  for (const pid of (permission_ids || [])) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO label_permissions (label_id, permission_id) VALUES (?, ?)', args: [req.params.id, pid] });
  }
  res.json({ updated: true });
});

// Get labels assigned to a user
router.get('/users/:userId/labels', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: `SELECT l.* FROM labels l JOIN user_labels ul ON ul.label_id = l.id WHERE ul.user_id = ? ORDER BY l.name`, args: [req.params.userId] });
  res.json(r.rows);
});

// Get all user-label assignments (for drag-drop UI)
router.get('/user-labels', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: `SELECT ul.user_id, ul.label_id, l.name as label_name, l.color as label_color, u.display_name as user_name FROM user_labels ul JOIN labels l ON l.id = ul.label_id JOIN users u ON u.id = ul.user_id ORDER BY u.display_name` });
  res.json(r.rows);
});

// Assign label to user (drag-drop)
router.post('/users/:userId/labels', authenticate, requireAdmin, async (req, res) => {
  const { label_id } = req.body;
  if (!label_id) return res.status(400).json({ error: 'label_id required' });
  const db = getDb();
  await db.execute({ sql: 'INSERT OR IGNORE INTO user_labels (user_id, label_id) VALUES (?, ?)', args: [req.params.userId, label_id] });
  res.json({ assigned: true });
});

// Remove label from user
router.delete('/users/:userId/labels/:labelId', authenticate, requireAdmin, async (req, res) => {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM user_labels WHERE user_id = ? AND label_id = ?', args: [req.params.userId, req.params.labelId] });
  res.json({ removed: true });
});

// Get all permissions for current user (resolved via labels)
router.get('/me', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: `SELECT DISTINCT p.key FROM permissions p JOIN label_permissions lp ON lp.permission_id = p.id JOIN user_labels ul ON ul.label_id = lp.label_id WHERE ul.user_id = ?`, args: [req.user.id] });
  const perms = r.rows.map(r => r.key);
  res.json({ permissions: perms });
});

module.exports = router;
