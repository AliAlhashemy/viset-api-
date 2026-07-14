const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

const VALID_STATES = ['pending', 'completed'];

// Allowed transitions: pending → completed only
const TRANSITIONS = {
  pending:   { admin: ['completed'], manager: ['completed'], supervisor: ['completed'], salesman: [] },
  completed: { admin: ['pending'], manager: [], supervisor: [], salesman: [] },
};

// Get workflow board data: visits grouped by status
router.get('/board', authenticate, requireRole('admin', 'manager', 'supervisor'), async (req, res) => {
  const db = getDb();
  const conditions = [];
  const args = [];

  if (req.query.visit_task) {
    conditions.push('v.visit_task = ?');
    args.push(req.query.visit_task);
  }
  if (req.query.q) {
    conditions.push('v.customer_name LIKE ?');
    args.push(`%${req.query.q}%`);
  }
  if (req.query.author_id) {
    conditions.push('v.author_id = ?');
    args.push(parseInt(req.query.author_id));
  }
  if (req.query.date_from) {
    conditions.push('v.created_at >= ?');
    args.push(req.query.date_from);
  }
  if (req.query.date_to) {
    conditions.push('v.created_at <= ?');
    args.push(req.query.date_to + ' 23:59:59');
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const sql = `SELECT v.id, v.customer_name, v.customer_type, v.visit_task, v.status, v.created_at, v.customer_id,
         v.visit_purpose, v.visit_note, v.photo_url, v.parent_id,
         v.latitude, v.longitude, v.address,
         u.display_name as author_name, u.department_id, d.name as department_name
  FROM visits v
  JOIN users u ON v.author_id = u.id
  LEFT JOIN departments d ON u.department_id = d.id${where}
  ORDER BY v.created_at DESC`;
  const r = await db.execute({ sql, args });
  const visits = r.rows;

  // Attach sub-tasks to each visit
  const parentIds = visits.filter(v => v.id && !v.parent_id).map(v => v.id);
  if (parentIds.length) {
    const placeholders = parentIds.map(() => '?').join(',');
    const sr = await db.execute({ sql: `SELECT id, customer_name, visit_task, status, created_at, author_id, parent_id FROM visits WHERE parent_id IN (${placeholders}) ORDER BY created_at ASC`, args: parentIds });
    const childMap = {};
    for (const child of sr.rows) {
      const pid = child.parent_id;
      if (!childMap[pid]) childMap[pid] = [];
      childMap[pid].push(child);
    }
    for (const v of visits) {
      v.sub_tasks = childMap[v.id] || [];
    }
  } else {
    visits.forEach(v => v.sub_tasks = []);
  }

  // Only show parent tasks (no sub-tasks directly) in the board columns
  const parentVisits = visits.filter(v => !v.parent_id);

  const grouped = {};
  VALID_STATES.forEach(s => { grouped[s] = []; });
  parentVisits.forEach(v => {
    const key = VALID_STATES.includes(v['status']) ? v['status'] : 'pending';
    grouped[key].push(v);
  });

  // Also return available task types for the filter dropdown
  const taskTypesR = await db.execute({ sql: 'SELECT name FROM task_types WHERE is_active = 1 ORDER BY name' });
  const taskTypes = taskTypesR.rows.map(r => r['name']);

  res.json({
    states: VALID_STATES,
    columns: grouped,
    counts: Object.fromEntries(VALID_STATES.map(s => [s, (grouped[s] || []).length])),
    taskTypes,
    selectedTask: req.query.visit_task || '',
  });
});

// Get workflow log for a specific visit
router.get('/log/:visit_id', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT w.*, u.display_name as user_name FROM workflow_log w JOIN users u ON w.user_id = u.id WHERE w.visit_id = ? ORDER BY w.created_at ASC`,
    args: [req.params.visit_id]
  });
  res.json(r.rows);
});

// Transition a visit to a new status
router.post('/transition', authenticate, requireRole('admin', 'manager', 'supervisor'), async (req, res) => {
  const { visit_id, to_status, note } = req.body;
  if (!visit_id || !to_status) return res.status(400).json({ error: 'visit_id and to_status required' });
  if (!VALID_STATES.includes(to_status)) return res.status(400).json({ error: `Invalid status: ${to_status}` });

  const db = getDb();
  const vr = await db.execute({ sql: 'SELECT * FROM visits WHERE id = ?', args: [visit_id] });
  const visit = vr.rows[0];
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  const fromStatus = visit['status'];
  const role = req.user.role;
  const allowed = TRANSITIONS[fromStatus]?.[role] || [];

  if (role !== 'admin' && !allowed.includes(to_status)) {
    return res.status(403).json({
      error: `Cannot move from "${fromStatus}" to "${to_status}" as ${role}`,
      allowed: allowed,
    });
  }

  const actionLabel = { pending: 'submitted', completed: 'completed' }[to_status] || to_status;

  await db.execute({ sql: 'UPDATE visits SET status = ?, workflow_note = ? WHERE id = ?', args: [to_status, (note || '').slice(0, 1000), visit_id] });

  await db.execute({
    sql: 'INSERT INTO workflow_log (visit_id, from_status, to_status, action, note, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    args: [visit_id, fromStatus, to_status, actionLabel, (note || '').slice(0, 1000), req.user.id]
  });

  const ur = await db.execute({
    sql: `SELECT v.*, u.display_name as author_name FROM visits v JOIN users u ON v.author_id = u.id WHERE v.id = ?`,
    args: [visit_id]
  });

  res.json({ visit: ur.rows[0], action: actionLabel });
});

// Mark a visit as success or not-success (manager only)
router.post('/success', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  const { visit_id, is_success } = req.body;
  if (!visit_id) return res.status(400).json({ error: 'visit_id required' });
  const db = getDb();
  const vr = await db.execute({ sql: 'SELECT * FROM visits WHERE id = ?', args: [visit_id] });
  if (!vr.rows[0]) return res.status(404).json({ error: 'Visit not found' });
  await db.execute({ sql: 'UPDATE visits SET is_success = ? WHERE id = ?', args: [is_success ? 1 : 0, visit_id] });
  await db.execute({
    sql: 'INSERT INTO workflow_log (visit_id, from_status, to_status, action, note, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    args: [visit_id, vr.rows[0]['status'], vr.rows[0]['status'], is_success ? 'marked_success' : 'marked_not_success', (req.body.note || '').slice(0, 500), req.user.id]
  });
  const ur = await db.execute({ sql: 'SELECT v.*, u.display_name as author_name FROM visits v JOIN users u ON v.author_id = u.id WHERE v.id = ?', args: [visit_id] });
  res.json({ visit: ur.rows[0] });
});

module.exports = router;