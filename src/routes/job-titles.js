const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT j.*, (SELECT COUNT(*) FROM users WHERE job_title_id = j.id) as employee_count
    FROM job_titles j ORDER BY j.level ASC, j.sort_order ASC, j.name ASC`
  });
  res.json(r.rows);
});

router.post('/', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Job title required' });
  const db = getDb();
  const er = await db.execute({ sql: 'SELECT id FROM job_titles WHERE name = ?', args: [name.trim()] });
  if (er.rows[0]) return res.status(409).json({ error: 'Job title already exists' });

  let level = 0;
  if (parent_id && parseInt(parent_id) > 0) {
    const pr = await db.execute({ sql: 'SELECT level FROM job_titles WHERE id = ?', args: [parseInt(parent_id)] });
    if (pr.rows[0]) level = Number(pr.rows[0].level) + 1;
  }

  const ir = await db.execute({
    sql: 'INSERT INTO job_titles (name, parent_id, level) VALUES (?, ?, ?)',
    args: [name.trim(), parseInt(parent_id) || 0, level]
  });
  const jr = await db.execute({ sql: 'SELECT * FROM job_titles WHERE id = ?', args: [Number(ir.lastInsertRowid)] });
  res.status(201).json(jr.rows[0]);
});

router.put('/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const db = getDb();
  const dup = await db.execute({ sql: 'SELECT id FROM job_titles WHERE name = ? AND id != ?', args: [name.trim(), req.params.id] });
  if (dup.rows[0]) return res.status(409).json({ error: 'Name already used' });

  let level = 0;
  if (parent_id && parseInt(parent_id) > 0) {
    const pr = await db.execute({ sql: 'SELECT level FROM job_titles WHERE id = ?', args: [parseInt(parent_id)] });
    if (pr.rows[0]) level = Number(pr.rows[0].level) + 1;
  }

  await db.execute({
    sql: 'UPDATE job_titles SET name = ?, parent_id = ?, level = ? WHERE id = ?',
    args: [name.trim(), parseInt(parent_id) || 0, level, req.params.id]
  });

  const jr = await db.execute({ sql: 'SELECT * FROM job_titles WHERE id = ?', args: [req.params.id] });
  if (!jr.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(jr.rows[0]);
});

router.delete('/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const db = getDb();
  const child = await db.execute({ sql: 'SELECT COUNT(*) as c FROM job_titles WHERE parent_id = ?', args: [req.params.id] });
  if (Number(child.rows[0].c) > 0) return res.status(400).json({ error: 'Has child positions. Reassign them first.' });
  const er = await db.execute({ sql: 'SELECT COUNT(*) as c FROM users WHERE job_title_id = ?', args: [req.params.id] });
  if (Number(er.rows[0].c) > 0) return res.status(400).json({ error: `Job title has ${Number(er.rows[0].c)} employees assigned` });
  await db.execute({ sql: 'DELETE FROM job_titles WHERE id = ?', args: [req.params.id] });
  res.json({ deleted: true });
});

module.exports = router;
