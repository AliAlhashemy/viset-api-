const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT d.*,
      (SELECT COUNT(*) FROM users WHERE department_id = d.id) as employee_count,
      (SELECT display_name FROM users WHERE id = d.manager_id) as manager_name
    FROM departments d ORDER BY d.name ASC`
  });
  res.json(r.rows);
});

router.post('/', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const { name, description, manager_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Department name required' });
  const db = getDb();
  const er = await db.execute({ sql: 'SELECT id FROM departments WHERE name = ?', args: [name.trim()] });
  if (er.rows[0]) return res.status(409).json({ error: 'Department already exists' });
  const ir = await db.execute({
    sql: 'INSERT INTO departments (name, description, manager_id) VALUES (?, ?, ?)',
    args: [name.trim(), (description || '').slice(0, 500), parseInt(manager_id) || 0]
  });
  const dr = await db.execute({
    sql: `SELECT d.*, (SELECT display_name FROM users WHERE id = d.manager_id) as manager_name FROM departments d WHERE d.id = ?`,
    args: [Number(ir.lastInsertRowid)]
  });
  res.status(201).json(dr.rows[0]);
});

router.put('/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const { name, description, manager_id } = req.body;
  const db = getDb();
  if (name) {
    const dup = await db.execute({ sql: 'SELECT id FROM departments WHERE name = ? AND id != ?', args: [name.trim(), req.params.id] });
    if (dup.rows[0]) return res.status(409).json({ error: 'Name already used' });
  }
  const updates = [];
  const vals = [];
  if (name !== undefined) { updates.push('name = ?'); vals.push(name.trim()); }
  if (description !== undefined) { updates.push('description = ?'); vals.push(description.slice(0, 500)); }
  if (manager_id !== undefined) { updates.push('manager_id = ?'); vals.push(parseInt(manager_id) || 0); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(req.params.id);
  await db.execute({ sql: `UPDATE departments SET ${updates.join(', ')} WHERE id = ?`, args: vals });
  const dr = await db.execute({
    sql: `SELECT d.*, (SELECT display_name FROM users WHERE id = d.manager_id) as manager_name FROM departments d WHERE d.id = ?`,
    args: [req.params.id]
  });
  if (!dr.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(dr.rows[0]);
});

router.delete('/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const db = getDb();
  const er = await db.execute({ sql: 'SELECT COUNT(*) as c FROM users WHERE department_id = ?', args: [req.params.id] });
  if (Number(er.rows[0].c) > 0) return res.status(400).json({ error: 'Department has employees. Reassign them first.' });
  await db.execute({ sql: 'DELETE FROM departments WHERE id = ?', args: [req.params.id] });
  res.json({ deleted: true });
});

module.exports = router;
