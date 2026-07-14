const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, async (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.per_page) || 500, 1000);
  const isSalesman = req.user.role === 'salesman';

  const conditions = [];
  const args = [];

  if (isSalesman) {
    conditions.push('v.author_id = ?');
    args.push(req.user.id);
  }
  if (req.query.visit_task) {
    conditions.push('v.visit_task = ?');
    args.push(req.query.visit_task);
  }
  if (req.query.status) {
    conditions.push('v.status = ?');
    args.push(req.query.status);
  }
  if (req.query.q) {
    conditions.push('v.customer_name LIKE ?');
    args.push(`%${req.query.q}%`);
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const sql = `SELECT v.*, u.display_name as author_name FROM visits v JOIN users u ON v.author_id = u.id${where} ORDER BY v.created_at DESC LIMIT ?`;
  args.push(limit);
  const r = await db.execute({ sql, args });
  const visits = r.rows;

  // Attach documents to each visit
  for (const v of visits) {
    const dr = await db.execute({ sql: 'SELECT id, original_name, file_url, file_size, file_type, doc_type, created_at FROM visit_documents WHERE visit_id = ? ORDER BY created_at ASC', args: [v.id] });
    v.documents = dr.rows;
  }
  // Attach sub-tasks
  const parentIds = visits.filter(v => v.id).map(v => v.id);
  const childMap = {};
  if (parentIds.length) {
    const sr = await db.execute({ sql: `SELECT id, customer_name, visit_task, status, created_at, author_id, parent_id FROM visits WHERE parent_id IN (${parentIds.map(() => '?').join(',')}) ORDER BY created_at ASC`, args: parentIds });
    for (const child of sr.rows) {
      const pid = child.parent_id;
      if (!childMap[pid]) childMap[pid] = [];
      childMap[pid].push(child);
    }
  }
  for (const v of visits) {
    v.sub_tasks = childMap[v.id] || [];
  }

  res.json(visits);
});

router.post('/', authenticate, async (req, res) => {
  let { customer_name, customer_id, customer_type, new_customer_name, new_customer_address, new_business_type, new_customer_code, visit_purpose, latitude, longitude, address, photo_id, photo_url, visit_task, visit_note, parent_id } = req.body;

  const db = getDb();
  const taskTypesR = await db.execute({ sql: 'SELECT name FROM task_types WHERE is_active = 1' });
  const validTasks = taskTypesR.rows.map(r => r['name']);
  const task = validTasks.includes(visit_task) ? visit_task : (validTasks[0] || 'visit');

  // Auto-create new customer if new_customer_name provided
  if (customer_type === 'new' && new_customer_name && !customer_id) {
    const cr = await db.execute({
      sql: 'INSERT INTO customers (name, address, type, business_type, customer_code) VALUES (?, ?, \'new\', ?, ?)',
      args: [
        new_customer_name.slice(0, 200),
        (new_customer_address || address || '').slice(0, 300),
        ['retail', 'wholesale', 'horeca'].includes(new_business_type) ? new_business_type : 'retail',
        (new_customer_code || '').slice(0, 50)
      ]
    });
    customer_id = Number(cr.lastInsertRowid);
    customer_name = new_customer_name;
    if (new_customer_address) address = new_customer_address;
  }

  if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
  if (typeof customer_name !== 'string' || customer_name.length > 200) return res.status(400).json({ error: 'Invalid customer name' });
  if (visit_purpose && visit_purpose.length > 1000) return res.status(400).json({ error: 'Visit purpose too long' });

  // Inherit parent's customer info if creating sub-task
  if (parseInt(parent_id) > 0) {
    const pv = await db.execute({ sql: 'SELECT customer_name, customer_id FROM visits WHERE id = ?', args: [parseInt(parent_id)] });
    if (pv.rows[0]) {
      customer_name = customer_name || pv.rows[0].customer_name;
      customer_id = customer_id || pv.rows[0].customer_id;
    }
  }

  const result = await db.execute({
    sql: 'INSERT INTO visits (customer_name, customer_id, customer_type, visit_purpose, latitude, longitude, address, photo_id, photo_url, author_id, visit_task, visit_note, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: [
      customer_name.slice(0, 200), parseInt(customer_id) || 0,
      ['new', 'old'].includes(customer_type) ? customer_type : 'new',
      (visit_purpose || '').slice(0, 1000),
      parseFloat(latitude) || 0, parseFloat(longitude) || 0,
      (address || '').slice(0, 300), parseInt(photo_id) || 0,
      (photo_url || '').slice(0, 500),
      req.user.id, task, (visit_note || '').slice(0, 500),
      parseInt(parent_id) || 0
    ]
  });

  // Increment customer visit_count
  if (parseInt(customer_id) > 0) {
    await db.execute({ sql: 'UPDATE customers SET visit_count = visit_count + 1 WHERE id = ?', args: [parseInt(customer_id)] });
  }

  const vr = await db.execute({ sql: 'SELECT * FROM visits WHERE id = ?', args: [Number(result.lastInsertRowid)] });
  res.status(201).json(vr.rows[0]);
});

router.put('/:id', authenticate, async (req, res) => {
  const { status, note } = req.body;
  if (!['pending', 'review', 'approved', 'flagged', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (!['admin', 'supervisor'].includes(req.user.role)) return res.status(403).json({ error: 'Only admins and supervisors can update status' });

  const db = getDb();
  const or = await db.execute({ sql: 'SELECT status FROM visits WHERE id = ?', args: [req.params.id] });
  const old = or.rows[0];
  if (!old) return res.status(404).json({ error: 'Visit not found' });

  await db.execute({ sql: 'UPDATE visits SET status = ?, workflow_note = ? WHERE id = ?', args: [status, (note || '').slice(0, 1000), req.params.id] });

  if (old.status !== status) {
    const actionLabel = { pending: 'submitted', review: 'sent to review', approved: 'approved', flagged: 'flagged', completed: 'completed' }[status] || status;
    await db.execute({
      sql: 'INSERT INTO workflow_log (visit_id, from_status, to_status, action, note, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      args: [req.params.id, old.status, status, actionLabel, (note || '').slice(0, 1000), req.user.id]
    });
  }

  const vr = await db.execute({ sql: 'SELECT v.*, u.display_name as author_name FROM visits v JOIN users u ON v.author_id = u.id WHERE v.id = ?', args: [req.params.id] });
  res.json(vr.rows[0]);
});

// Salesman edit own pending visit (notes + task + documents only, not location/photo)
router.put('/:id/edit', authenticate, async (req, res) => {
  const { visit_note, visit_task, photo_url, photo_id } = req.body;
  const db = getDb();
  const vr = await db.execute({ sql: 'SELECT * FROM visits WHERE id = ?', args: [req.params.id] });
  const visit = vr.rows[0];
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (Number(visit.author_id) !== req.user.id) return res.status(403).json({ error: 'Not your visit' });
  if (visit.status !== 'pending') return res.status(400).json({ error: 'Can only edit pending visits' });

  const sets = [];
  const sArgs = [];
  if (visit_note !== undefined) {
    sets.push('visit_note = ?');
    sArgs.push((visit_note || '').slice(0, 500));
  }
  if (visit_task !== undefined) {
    const taskTypesR = await db.execute({ sql: 'SELECT name FROM task_types WHERE is_active = 1' });
    const validTasks = taskTypesR.rows.map(r => r['name']);
    if (validTasks.includes(visit_task)) {
      sets.push('visit_task = ?');
      sArgs.push(visit_task);
    }
  }
  if (photo_url !== undefined) {
    sets.push('photo_url = ?');
    sArgs.push((photo_url || '').slice(0, 500));
    if (photo_id !== undefined) {
      sets.push('photo_id = ?');
      sArgs.push(parseInt(photo_id) || 0);
    }
  }
  if (sets.length) {
    sArgs.push(req.params.id);
    await db.execute({ sql: `UPDATE visits SET ${sets.join(', ')} WHERE id = ?`, args: sArgs });
  }

  const updated = await db.execute({ sql: 'SELECT * FROM visits WHERE id = ?', args: [req.params.id] });
  res.json(updated.rows[0]);
});

module.exports = router;
