const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

const PROGRESS_FLOWS = {
  production: ['production', 'create', 'report_finish', 'transfer_warehouse', 'received', 'ended'],
  purchase: ['purchase_request', 'payment_request', 'approved'],
  outside_orders: ['order_placed', 'in_progress', 'shipped', 'delivered', 'completed'],
};

const FLOW_TRANSITIONS = {
  production: { production: ['create'], create: ['report_finish'], report_finish: ['transfer_warehouse'], transfer_warehouse: ['received'], received: ['ended'] },
  purchase: { purchase_request: ['payment_request'], payment_request: ['approved'] },
  outside_orders: { order_placed: ['in_progress'], in_progress: ['shipped'], shipped: ['delivered'], delivered: ['completed'] },
};

function calcProgress(flowKey, status) {
  const statuses = PROGRESS_FLOWS[flowKey];
  if (!statuses) return 0;
  const idx = statuses.indexOf(status);
  if (idx < 0) return 0;
  return Math.round((idx / (statuses.length - 1)) * 100);
}

function attachNodeCounts(db, tickets) {
  return Promise.all(tickets.map(async t => {
    const nr = await db.execute({ sql: 'SELECT COUNT(*) as total, SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as done FROM ticket_nodes WHERE ticket_id = ?', args: [t.id] });
    const row = nr.rows[0];
    t.nodes_total = Number(row.total);
    t.nodes_done = Number(row.done || 0);
    // t.progress is already stored as flow progress from status changes
    return t;
  }));
}

// GET pending approvals for current user (must be before /:id to avoid route conflict)
router.get('/approvals', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT a.*, t.title as ticket_title, t.flow as ticket_flow,
          req.display_name as requester_name,
          ap.display_name as approver_name
          FROM ticket_approvals a
          JOIN tickets t ON a.ticket_id = t.id
          LEFT JOIN users req ON a.requested_by = req.id
          LEFT JOIN users ap ON a.assigned_user = ap.id
          WHERE a.status = 'pending'
          AND (? IN ('admin','manager') OR a.assigned_user = ? OR (a.assigned_user IS NULL AND a.assigned_role = ?))
          ORDER BY a.created_at DESC`,
    args: [req.user.role, req.user.id, req.user.role]
  });
  res.json(r.rows);
});

router.get('/', authenticate, async (req, res) => {
  const db = getDb();
  const { flow, status, priority, assigned_to, q, date_from, date_to } = req.query;
  let sql = `SELECT t.*, a.display_name as author_name, u.display_name as assigned_name,
             v.customer_name as visit_customer_name
             FROM tickets t
             LEFT JOIN users a ON t.author_id = a.id
             LEFT JOIN users u ON t.assigned_to = u.id
             LEFT JOIN visits v ON t.visit_id = v.id`;
  const wheres = [];
  const vals = [];
  if (req.user.role === 'salesman') {
    wheres.push('(t.author_id = ? OR t.assigned_to = ?)');
    vals.push(req.user.id, req.user.id);
  }
  if (flow) { wheres.push('t.flow = ?'); vals.push(flow); }
  if (status) { wheres.push('t.status = ?'); vals.push(status); }
  if (priority) { wheres.push('t.priority = ?'); vals.push(priority); }
  if (assigned_to) { wheres.push('t.assigned_to = ?'); vals.push(assigned_to); }
  if (q) { wheres.push('t.title LIKE ?'); vals.push(`%${q}%`); }
  if (date_from) { wheres.push('t.created_at >= ?'); vals.push(date_from); }
  if (date_to) { wheres.push('t.created_at <= ?'); vals.push(date_to + ' 23:59:59'); }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' ORDER BY t.updated_at DESC';
  const r = await db.execute({ sql, args: vals });
  let tickets = r.rows;
  tickets = await attachNodeCounts(db, tickets);
  res.json(tickets);
});

router.get('/:id', authenticate, async (req, res) => {
  const db = getDb();
  let whereExtra = '';
  const vals = [req.params.id];
  if (req.user.role === 'salesman') {
    whereExtra = ' AND (t.author_id = ? OR t.assigned_to = ?)';
    vals.push(req.user.id, req.user.id);
  }
  const r = await db.execute({
    sql: `SELECT t.*, a.display_name as author_name, u.display_name as assigned_name,
          v.customer_name as visit_customer_name
          FROM tickets t
          LEFT JOIN users a ON t.author_id = a.id
          LEFT JOIN users u ON t.assigned_to = u.id
          LEFT JOIN visits v ON t.visit_id = v.id
          WHERE t.id = ?${whereExtra}`,
    args: vals
  });
  if (!r.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const ticket = r.rows[0];
  const logR = await db.execute({
    sql: 'SELECT tl.*, u.display_name as user_name FROM ticket_log tl LEFT JOIN users u ON tl.user_id = u.id WHERE tl.ticket_id = ? ORDER BY tl.created_at ASC',
    args: [req.params.id]
  });
  const nr = await db.execute({ sql: 'SELECT COUNT(*) as total, SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as done FROM ticket_nodes WHERE ticket_id = ?', args: [req.params.id] });
  const nodeRow = nr.rows[0];
  ticket.nodes_total = Number(nodeRow.total);
  ticket.nodes_done = Number(nodeRow.done || 0);
  ticket.progress = ticket.nodes_total > 0 ? Math.round((ticket.nodes_done / ticket.nodes_total) * 100) : 0;
  res.json({ ticket, log: logR.rows });
});

router.get('/:id/nodes', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: 'SELECT * FROM ticket_nodes WHERE ticket_id = ? ORDER BY sort_order ASC, id ASC', args: [req.params.id] });
  res.json(r.rows);
});

router.post('/:id/nodes', authenticate, async (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const db = getDb();
  const mr = await db.execute({ sql: 'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort FROM ticket_nodes WHERE ticket_id = ?', args: [req.params.id] });
  const nextSort = Number(mr.rows[0].next_sort);
  const ir = await db.execute({ sql: 'INSERT INTO ticket_nodes (ticket_id, title, sort_order) VALUES (?, ?, ?)', args: [req.params.id, title.trim(), nextSort] });
  const rr = await db.execute({ sql: 'SELECT * FROM ticket_nodes WHERE id = ?', args: [Number(ir.lastInsertRowid)] });
  res.status(201).json(rr.rows[0]);
});

router.put('/:id/nodes/:nodeId', authenticate, async (req, res) => {
  const { title, is_done } = req.body;
  const db = getDb();
  const sets = []; const vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title.trim()); }
  if (is_done !== undefined) { sets.push('is_done = ?'); vals.push(is_done ? 1 : 0); }
  if (sets.length) {
    vals.push(req.params.nodeId, req.params.id);
    await db.execute({ sql: `UPDATE ticket_nodes SET ${sets.join(', ')} WHERE id = ? AND ticket_id = ?`, args: vals });
  }
  const rr = await db.execute({ sql: 'SELECT * FROM ticket_nodes WHERE id = ?', args: [req.params.nodeId] });
  res.json(rr.rows[0]);
});

router.delete('/:id/nodes/:nodeId', authenticate, async (req, res) => {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM ticket_nodes WHERE id = ? AND ticket_id = ?', args: [req.params.nodeId, req.params.id] });
  res.json({ deleted: true });
});

router.post('/', authenticate, async (req, res) => {
  const { title, description, flow, priority, assigned_to, visit_id, customer_name } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const fKey = flow || 'production';
  const initialStatus = PROGRESS_FLOWS[fKey]?.[0] || 'production';
  const db = getDb();
  const initialProgress = calcProgress(fKey, initialStatus);
  const ir = await db.execute({
    sql: `INSERT INTO tickets (title, description, flow, status, progress, priority, author_id, assigned_to, visit_id, customer_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [title.trim(), description || '', fKey, initialStatus, initialProgress, priority || 'medium', req.user.id, assigned_to || null, visit_id || null, customer_name || '']
  });
  await db.execute({
    sql: 'INSERT INTO ticket_log (ticket_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
    args: [Number(ir.lastInsertRowid), 'created', '', initialStatus, req.user.id, '']
  });
  const rr = await db.execute({
    sql: `SELECT t.*, a.display_name as author_name, u.display_name as assigned_name
          FROM tickets t LEFT JOIN users a ON t.author_id = a.id LEFT JOIN users u ON t.assigned_to = u.id
          WHERE t.id = ?`,
    args: [Number(ir.lastInsertRowid)]
  });
  res.status(201).json(rr.rows[0]);
});

const FLOW_APPROVALS = {
  production: {
    production: { role: 'manager', user: null },
    create: { role: 'supervisor', user: null },
    report_finish: { role: 'accountant', user: null },
    transfer_warehouse: { role: 'manager', user: null },
  },
  purchase: { payment_request: { role: 'admin', user: null } },
  outside_orders: {
    order_placed: { role: 'manager', user: null },
    in_progress: { role: 'supervisor', user: null },
    shipped: { role: 'manager', user: null },
  },
};

router.put('/:id', authenticate, async (req, res) => {
  const db = getDb();
  const existing = await db.execute({ sql: 'SELECT * FROM tickets WHERE id = ?', args: [req.params.id] });
  if (!existing.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const ticket = existing.rows[0];
  const isAdminManager = ['admin', 'manager'].includes(req.user.role);
  const isOwner = Number(ticket.author_id) === req.user.id;
  if (!isAdminManager && !isOwner) return res.status(403).json({ error: 'Not authorized' });

  if (req.body.status && req.body.status !== ticket.status) {
    if (!isAdminManager && !['purchase'].includes(ticket.flow)) {
      return res.status(403).json({ error: 'Only admins and managers can change ticket status' });
    }
    const fKey = ticket.flow || 'production';
    const flowStatuses = PROGRESS_FLOWS[fKey];
    const currentIdx = flowStatuses.indexOf(ticket.status);
    const targetIdx = flowStatuses.indexOf(req.body.status);
    if (currentIdx === -1 || targetIdx === -1 || targetIdx <= currentIdx) {
      return res.status(400).json({ error: 'Invalid status transition' });
    }
    const allowed = FLOW_TRANSITIONS[fKey]?.[ticket.status] || [];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: 'Invalid status transition' });
    }
  }

  const { title, description, flow, status, priority, assigned_to, visit_id, customer_name } = req.body;
  if (status && status !== ticket.status) {
    const fKey = ticket.flow || 'production';
    const approvalCfg = FLOW_APPROVALS[fKey]?.[ticket.status];
    if (approvalCfg) {
      // Step requires approval: create approval request, set status to awaiting_approval
      const approverRole = approvalCfg.role;
      const approverUser = approvalCfg.user;
      await db.execute({
        sql: 'INSERT INTO ticket_approvals (ticket_id, from_status, to_status, requested_by, assigned_role, assigned_user, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [req.params.id, ticket.status, status, req.user.id, approverRole, approverUser, req.body.note || '']
      });
      const fromProg = calcProgress(fKey, ticket.status);
      await db.execute({
        sql: "UPDATE tickets SET status = 'awaiting_approval', progress = ?, updated_at = datetime('now') WHERE id = ?",
        args: [fromProg, req.params.id]
      });
      await db.execute({
        sql: 'INSERT INTO ticket_log (ticket_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
        args: [req.params.id, 'pending_approval', ticket.status, status, req.user.id, req.body.note || '']
      });
    } else {
      // Direct transition (no approval needed)
      const toProg = calcProgress(fKey, status);
      const pd = req.body.purchase_data;
      const pdStr = pd !== undefined ? (typeof pd === 'string' ? pd : JSON.stringify(pd)) : null;
      if (pdStr !== null) {
        await db.execute({
          sql: "UPDATE tickets SET status = ?, progress = ?, purchase_data = ?, updated_at = datetime('now') WHERE id = ?",
          args: [status, toProg, pdStr, req.params.id]
        });
      } else {
        await db.execute({
          sql: "UPDATE tickets SET status = ?, progress = ?, updated_at = datetime('now') WHERE id = ?",
          args: [status, toProg, req.params.id]
        });
      }
      await db.execute({
        sql: 'INSERT INTO ticket_log (ticket_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
        args: [req.params.id, status, ticket.status, status, req.user.id, req.body.note || '']
      });
      if (assigned_to !== undefined && Number(assigned_to) !== Number(ticket.assigned_to)) {
        await db.execute({
          sql: 'INSERT INTO ticket_log (ticket_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
          args: [req.params.id, 'assigned', '', '', req.user.id, `Assigned to user ${assigned_to || 'unassigned'}`]
        });
      }
    }
  } else {
    // Non-status updates
    const updates = []; const vals = [];
    if (title !== undefined) { updates.push('title = ?'); vals.push(title.trim()); }
    if (description !== undefined) { updates.push('description = ?'); vals.push(description); }
    if (flow !== undefined && isAdminManager) { updates.push('flow = ?'); vals.push(flow); }
    if (priority !== undefined) { updates.push('priority = ?'); vals.push(priority); }
    if (assigned_to !== undefined && isAdminManager) { updates.push('assigned_to = ?'); vals.push(assigned_to || null); }
    if (visit_id !== undefined) { updates.push('visit_id = ?'); vals.push(visit_id || null); }
    if (customer_name !== undefined) { updates.push('customer_name = ?'); vals.push(customer_name || ''); }
    if (req.body.purchase_data !== undefined) { updates.push('purchase_data = ?'); vals.push(typeof req.body.purchase_data === 'string' ? req.body.purchase_data : JSON.stringify(req.body.purchase_data)); }
    if (updates.length) {
      updates.push("updated_at = datetime('now')");
      vals.push(req.params.id);
      await db.execute({ sql: `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`, args: vals });
    }
  }
  const rr = await db.execute({
    sql: `SELECT t.*, a.display_name as author_name, u.display_name as assigned_name
          FROM tickets t LEFT JOIN users a ON t.author_id = a.id LEFT JOIN users u ON t.assigned_to = u.id
          WHERE t.id = ?`,
    args: [req.params.id]
  });
  res.json(rr.rows[0]);
});

// Approve a pending request
router.post('/:id/approve', authenticate, async (req, res) => {
  const db = getDb();
  const existing = await db.execute({ sql: 'SELECT * FROM tickets WHERE id = ?', args: [req.params.id] });
  if (!existing.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const approval = await db.execute({
    sql: "SELECT * FROM ticket_approvals WHERE ticket_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    args: [req.params.id]
  });
  if (!approval.rows[0]) return res.status(404).json({ error: 'No pending approval for this ticket' });
  const ap = approval.rows[0];
  const isRoleMatch = req.user.role === ap.assigned_role || ['admin','manager'].includes(req.user.role);
  const isUserMatch = ap.assigned_user && Number(ap.assigned_user) === req.user.id;
  if (!isRoleMatch && !isUserMatch) return res.status(403).json({ error: 'Not authorized to approve this request' });
  await db.execute({
    sql: "UPDATE ticket_approvals SET status = 'approved', updated_at = datetime('now') WHERE id = ?",
    args: [ap.id]
  });
  const flowRow = await db.execute({ sql: 'SELECT flow FROM tickets WHERE id = ?', args: [req.params.id] });
  const approveProg = calcProgress(flowRow.rows[0]?.flow || 'production', ap.to_status);
  await db.execute({
    sql: "UPDATE tickets SET status = ?, progress = ?, updated_at = datetime('now') WHERE id = ?",
    args: [ap.to_status, approveProg, req.params.id]
  });
  await db.execute({
    sql: 'INSERT INTO ticket_log (ticket_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
    args: [req.params.id, 'approved', ap.from_status, ap.to_status, req.user.id, req.body.note || '']
  });
  const rr = await db.execute({
    sql: `SELECT t.*, a.display_name as author_name, u.display_name as assigned_name
          FROM tickets t LEFT JOIN users a ON t.author_id = a.id LEFT JOIN users u ON t.assigned_to = u.id
          WHERE t.id = ?`,
    args: [req.params.id]
  });
  res.json(rr.rows[0]);
});

// Reject a pending request
router.post('/:id/reject', authenticate, async (req, res) => {
  const db = getDb();
  const existing = await db.execute({ sql: 'SELECT * FROM tickets WHERE id = ?', args: [req.params.id] });
  if (!existing.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const approval = await db.execute({
    sql: "SELECT * FROM ticket_approvals WHERE ticket_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    args: [req.params.id]
  });
  if (!approval.rows[0]) return res.status(404).json({ error: 'No pending approval for this ticket' });
  const ap = approval.rows[0];
  const isRoleMatch = req.user.role === ap.assigned_role || ['admin','manager'].includes(req.user.role);
  const isUserMatch = ap.assigned_user && Number(ap.assigned_user) === req.user.id;
  if (!isRoleMatch && !isUserMatch) return res.status(403).json({ error: 'Not authorized to reject this request' });
  const rejectFlow = await db.execute({ sql: 'SELECT flow FROM tickets WHERE id = ?', args: [req.params.id] });
  const rFlow = rejectFlow.rows[0]?.flow || 'production';
  const rejectProg = calcProgress(rFlow, ap.from_status);
  await db.execute({
    sql: "UPDATE ticket_approvals SET status = 'rejected', updated_at = datetime('now') WHERE id = ?",
    args: [ap.id]
  });
  await db.execute({
    sql: "UPDATE tickets SET status = ?, progress = ?, updated_at = datetime('now') WHERE id = ?",
    args: [ap.from_status, rejectProg, req.params.id]
  });
  await db.execute({
    sql: 'INSERT INTO ticket_log (ticket_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
    args: [req.params.id, 'rejected', ap.from_status, ap.to_status, req.user.id, req.body.note || '']
  });
  const rr = await db.execute({
    sql: `SELECT t.*, a.display_name as author_name, u.display_name as assigned_name
          FROM tickets t LEFT JOIN users a ON t.author_id = a.id LEFT JOIN users u ON t.assigned_to = u.id
          WHERE t.id = ?`,
    args: [req.params.id]
  });
  res.json(rr.rows[0]);
});

// Request reversal (back to previous status, admin approval required)
router.post('/:id/request-reversal', authenticate, async (req, res) => {
  const db = getDb();
  const existing = await db.execute({ sql: 'SELECT * FROM tickets WHERE id = ?', args: [req.params.id] });
  if (!existing.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const ticket = existing.rows[0];
  const flowKey = ticket.flow || 'production';
  const statuses = PROGRESS_FLOWS[flowKey];
  if (!statuses) return res.status(400).json({ error: 'Unknown flow' });
  const curIdx = statuses.indexOf(ticket.status);
  if (curIdx <= 0) return res.status(400).json({ error: 'Cannot reverse from first status' });
  const prevStatus = statuses[curIdx - 1];
  // Check if there's already a pending reversal
  const existingApr = await db.execute({
    sql: "SELECT id FROM ticket_approvals WHERE ticket_id = ? AND status = 'pending' AND to_status = ? AND assigned_role = 'admin'",
    args: [req.params.id, prevStatus]
  });
  if (existingApr.rows[0]) return res.status(400).json({ error: 'Reversal already requested' });
  await db.execute({
    sql: 'INSERT INTO ticket_approvals (ticket_id, from_status, to_status, requested_by, assigned_role, note) VALUES (?, ?, ?, ?, ?, ?)',
    args: [req.params.id, ticket.status, prevStatus, req.user.id, 'admin', req.body.note || 'Reversal request']
  });
  await db.execute({
    sql: 'INSERT INTO ticket_log (ticket_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
    args: [req.params.id, 'reversal_requested', ticket.status, prevStatus, req.user.id, req.body.note || '']
  });
  res.json({ success: true, message: 'Reversal requested' });
});

router.delete('/:id', authenticate, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or manager access required' });
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM ticket_approvals WHERE ticket_id = ?', args: [req.params.id] });
  await db.execute({ sql: 'DELETE FROM ticket_nodes WHERE ticket_id = ?', args: [req.params.id] });
  await db.execute({ sql: 'DELETE FROM ticket_log WHERE ticket_id = ?', args: [req.params.id] });
  await db.execute({ sql: 'DELETE FROM tickets WHERE id = ?', args: [req.params.id] });
  res.json({ deleted: true });
});

module.exports = router;
