const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const db = getDb();
  const ur = await db.execute({
    sql: `SELECT u.id, u.username, u.display_name, u.email, u.role, u.department_id, u.job_title_id, u.employee_code, u.phone, u.created_at,
           d.name as department_name, j.name as job_title_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN job_titles j ON u.job_title_id = j.id
    ORDER BY u.display_name ASC`
  });
  const users = ur.rows;
  const vr = await db.execute({ sql: 'SELECT author_id, COUNT(*) as c FROM visits GROUP BY author_id' });
  const cm = {};
  vr.rows.forEach(v => { cm[v['author_id']] = v['c']; });
  res.json(users.map(u => ({ ...u, visit_count: cm[u.id] || 0 })));
});

router.post('/', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const { username, email, display_name, password, role, department_id, job_title_id, employee_code, phone } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, password required' });

  // Only admins can create other admins
  let finalRole = 'salesman';
  if (['manager','supervisor','accountant','salesman'].includes(role)) finalRole = role;
  if (role === 'admin' && req.user.role === 'admin') finalRole = 'admin';

  const db = getDb();
  const er = await db.execute({ sql: 'SELECT id FROM users WHERE username = ? OR email = ?', args: [username, email] });
  if (er.rows[0]) return res.status(409).json({ error: 'Username or email already exists' });

  const hashed = bcrypt.hashSync(password, 10);
  const result = await db.execute({
    sql: 'INSERT INTO users (username, password, display_name, email, role, department_id, job_title_id, employee_code, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: [
      username, hashed, display_name || username, email,
      finalRole,
      parseInt(department_id) || 0, parseInt(job_title_id) || 0,
      (employee_code || '').slice(0, 50), (phone || '').slice(0, 30)
    ]
  });
  const ur = await db.execute({
    sql: `SELECT u.id, u.username, u.display_name, u.email, u.role, u.department_id, u.job_title_id, u.employee_code, u.phone, u.created_at, d.name as department_name, j.name as job_title_name FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN job_titles j ON u.job_title_id = j.id WHERE u.id = ?`,
    args: [Number(result.lastInsertRowid)]
  });
  res.status(201).json(ur.rows[0]);
});

router.put('/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const { id } = req.params;
  const { display_name, email, role, password, department_id, job_title_id, employee_code, phone } = req.body;
  const db = getDb();

  const check = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [id] });
  if (!check.rows[0]) return res.status(404).json({ error: 'User not found' });

  const updates = [];
  const vals = [];
  if (display_name !== undefined) { updates.push('display_name = ?'); vals.push(display_name.slice(0, 100)); }
  if (email !== undefined) { updates.push('email = ?'); vals.push(email.slice(0, 200)); }
  if (role !== undefined) {
    let finalRole = 'salesman';
    if (role === 'manager' && req.user.role !== 'admin') { return res.status(403).json({ error: 'Only admins can assign manager role' }); }
    if (['manager','supervisor','accountant','salesman'].includes(role)) finalRole = role;
    if (role === 'admin' && req.user.role === 'admin') finalRole = 'admin';
    updates.push('role = ?'); vals.push(finalRole);
  }
  if (password) { updates.push('password = ?'); vals.push(bcrypt.hashSync(password, 10)); }
  if (department_id !== undefined) { updates.push('department_id = ?'); vals.push(parseInt(department_id) || 0); }
  if (job_title_id !== undefined) { updates.push('job_title_id = ?'); vals.push(parseInt(job_title_id) || 0); }
  if (employee_code !== undefined) { updates.push('employee_code = ?'); vals.push(employee_code.slice(0, 50)); }
  if (phone !== undefined) { updates.push('phone = ?'); vals.push(phone.slice(0, 30)); }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  vals.push(id);
  await db.execute({ sql: `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, args: vals });
  const ur = await db.execute({
    sql: `SELECT u.id, u.username, u.display_name, u.email, u.role, u.department_id, u.job_title_id, u.employee_code, u.phone, u.created_at, d.name as department_name, j.name as job_title_name FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN job_titles j ON u.job_title_id = j.id WHERE u.id = ?`,
    args: [id]
  });
  res.json(ur.rows[0]);
});

module.exports = router;