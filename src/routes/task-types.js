const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: 'SELECT * FROM task_types ORDER BY sort_order ASC' });
  res.json(r.rows);
});

router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { name, label, icon, color } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name and label required' });
  const db = getDb();
  const er = await db.execute({ sql: 'SELECT id FROM task_types WHERE name = ?', args: [name.trim()] });
  if (er.rows[0]) return res.status(409).json({ error: 'Task type name already exists' });
  const maxR = await db.execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM task_types' });
  const nextSort = Number(maxR.rows[0]['next']);
  const ir = await db.execute({
    sql: 'INSERT INTO task_types (name, label, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)',
    args: [name.trim(), label.trim(), icon || '📌', color || '#6b7280', nextSort]
  });
  const rr = await db.execute({ sql: 'SELECT * FROM task_types WHERE id = ?', args: [Number(ir.lastInsertRowid)] });
  res.status(201).json(rr.rows[0]);
});

router.put('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { name, label, icon, color, is_active } = req.body;
  const db = getDb();
  const existing = await db.execute({ sql: 'SELECT id FROM task_types WHERE id = ?', args: [req.params.id] });
  if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (name) {
    const dup = await db.execute({ sql: 'SELECT id FROM task_types WHERE name = ? AND id != ?', args: [name.trim(), req.params.id] });
    if (dup.rows[0]) return res.status(409).json({ error: 'Name already used' });
  }
  const updates = []; const vals = [];
  if (name !== undefined) { updates.push('name = ?'); vals.push(name.trim()); }
  if (label !== undefined) { updates.push('label = ?'); vals.push(label.trim()); }
  if (icon !== undefined) { updates.push('icon = ?'); vals.push(icon); }
  if (color !== undefined) { updates.push('color = ?'); vals.push(color); }
  if (is_active !== undefined) { updates.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
  if (updates.length) {
    vals.push(req.params.id);
    await db.execute({ sql: `UPDATE task_types SET ${updates.join(', ')} WHERE id = ?`, args: vals });
  }
  const rr = await db.execute({ sql: 'SELECT * FROM task_types WHERE id = ?', args: [req.params.id] });
  res.json(rr.rows[0]);
});

router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const vr = await db.execute({ sql: 'SELECT COUNT(*) as c FROM visits WHERE visit_task = (SELECT name FROM task_types WHERE id = ?)', args: [req.params.id] });
  if (Number(vr.rows[0]['c']) > 0) return res.status(400).json({ error: 'Task type has visits assigned. Deactivate instead.' });
  await db.execute({ sql: 'DELETE FROM task_types WHERE id = ?', args: [req.params.id] });
  res.json({ deleted: true });
});

module.exports = router;
