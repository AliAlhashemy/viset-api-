const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/summary', authenticate, requireRole('admin', 'manager', 'supervisor', 'accountant'), async (req, res) => {
  const db = getDb();
  const allR = await db.execute({ sql: "SELECT COUNT(*) as c FROM visits WHERE created_at >= datetime('now', '-12 months')" });
  const pendR = await db.execute({ sql: "SELECT COUNT(*) as c FROM visits WHERE status='pending' AND created_at >= datetime('now', '-12 months')" });
  const apprR = await db.execute({ sql: "SELECT COUNT(*) as c FROM visits WHERE status='approved' AND created_at >= datetime('now', '-12 months')" });
  const flagR = await db.execute({ sql: "SELECT COUNT(*) as c FROM visits WHERE status='flagged' AND created_at >= datetime('now', '-12 months')" });

  const smR = await db.execute({ sql: "SELECT u.id, u.display_name, u.username FROM users u WHERE u.role = 'salesman' ORDER BY u.display_name ASC" });
  const salesmen = smR.rows;

  const enriched = [];
  for (const sm of salesmen) {
    const tR = await db.execute({ sql: "SELECT COUNT(*) as c FROM visits WHERE author_id=? AND created_at >= datetime('now', '-12 months')", args: [sm.id] });
    const total = Number(tR.rows[0]['c']);

    const uR = await db.execute({ sql: "SELECT COUNT(DISTINCT customer_name) as c FROM visits WHERE author_id=? AND created_at >= datetime('now', '-12 months')", args: [sm.id] });
    const uniqueCust = Number(uR.rows[0]['c']);

    const repR = await db.execute({ sql: "SELECT COUNT(*) as c FROM (SELECT customer_name, COUNT(*) as cnt FROM visits WHERE author_id=? AND created_at >= datetime('now', '-12 months') AND customer_name != '' GROUP BY customer_name HAVING cnt > 1)", args: [sm.id] });
    const repeat = Number(repR.rows[0]['c']);

    const repVR = await db.execute({ sql: "SELECT COUNT(*) as c FROM visits v WHERE v.author_id=? AND v.created_at >= datetime('now', '-12 months') AND v.customer_name IN (SELECT customer_name FROM visits WHERE author_id=? AND created_at >= datetime('now', '-12 months') AND customer_name != '' GROUP BY customer_name HAVING COUNT(*) > 1)", args: [sm.id, sm.id] });
    const repeatVisits = Number(repVR.rows[0]['c']);

    const tasksR = await db.execute({ sql: "SELECT visit_task, COUNT(*) as c FROM visits WHERE author_id=? AND created_at >= datetime('now', '-12 months') GROUP BY visit_task ORDER BY c DESC", args: [sm.id] });
    const tasks = tasksR.rows;

    const monR = await db.execute({ sql: "SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as c FROM visits WHERE author_id=? AND created_at >= datetime('now', '-12 months') GROUP BY month ORDER BY month ASC", args: [sm.id] });
    const monthly = monR.rows;

    const topR = await db.execute({ sql: "SELECT customer_name, COUNT(*) as c FROM visits WHERE author_id=? AND created_at >= datetime('now', '-12 months') AND customer_name != '' GROUP BY customer_name ORDER BY c DESC LIMIT 5", args: [sm.id] });
    const topCustomers = topR.rows;

    const lvR = await db.execute({ sql: "SELECT created_at FROM visits WHERE author_id=? ORDER BY created_at DESC LIMIT 1", args: [sm.id] });
    const lastVisit = lvR.rows[0];

    enriched.push({
      id: sm.id,
      display_name: sm.display_name,
      username: sm.username,
      total_visits: total,
      unique_customers: uniqueCust,
      repeat_customers: repeat,
      repeat_visits: repeatVisits,
      repeat_rate: total > 0 ? Math.round((repeatVisits / total) * 100) : 0,
      top_task: tasks.length ? tasks[0]['visit_task'] : 'visit',
      task_breakdown: tasks,
      monthly_trend: monthly,
      top_customers: topCustomers,
      last_visit: lastVisit ? lastVisit['created_at'] : null,
    });
  }

  res.json({
    total_visits: Number(allR.rows[0]['c']),
    pending: Number(pendR.rows[0]['c']),
    approved: Number(apprR.rows[0]['c']),
    flagged: Number(flagR.rows[0]['c']),
    salesmen: enriched,
  });
});

router.get('/visits', authenticate, requireRole('admin', 'manager', 'supervisor', 'accountant'), async (req, res) => {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT v.id, v.customer_name, v.customer_type, v.status, v.latitude,
           v.longitude, v.address, v.created_at, v.visit_task,
           u.display_name as author_name
    FROM visits v JOIN users u ON v.author_id = u.id
    WHERE v.created_at >= datetime('now', '-12 months')
    ORDER BY v.created_at DESC`
  });
  const visits = r.rows;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="visits-export.csv"');
  res.write('\uFEFF');
  const esc = (v) => {
    const s = String(v == null ? '' : v).replace(/"/g, '""');
    return /^[=+\-@]/.test(s) ? `"'${s}"` : `"${s}"`;
  };
  res.write('ID,Customer,Type,Task,Status,Latitude,Longitude,Address,Salesman,Date\n');
  visits.forEach(v => {
    res.write(`${v.id},${esc(v.customer_name)},${esc(v.customer_type)},${esc(v.visit_task)},${esc(v.status)},${esc(v.latitude)},${esc(v.longitude)},${esc(v.address)},${esc(v.author_name)},${esc(v.created_at)}\n`);
  });
  res.end();
});

// Success report — per salesman with date filters
router.get('/success', authenticate, requireRole('admin', 'manager', 'supervisor', 'accountant'), async (req, res) => {
  const db = getDb();
  const { date_from, date_to, author_id } = req.query;
  let dateCond = '';
  const args = [];
  if (date_from) { dateCond += ' AND v.created_at >= ?'; args.push(date_from); }
  if (date_to) { dateCond += ' AND v.created_at <= ?'; args.push(date_to + ' 23:59:59'); }

  // Only query requested salesman if author_id specified
  let salesmen;
  if (author_id) {
    const smR = await db.execute({ sql: "SELECT u.id, u.display_name, u.username FROM users u WHERE u.role = 'salesman' AND u.id = ?", args: [Number(author_id)] });
    salesmen = smR.rows;
  } else {
    const smR = await db.execute({ sql: "SELECT u.id, u.display_name, u.username FROM users u WHERE u.role = 'salesman' ORDER BY u.display_name ASC" });
    salesmen = smR.rows;
  }

  const enriched = [];
  for (const sm of salesmen) {
    const tR = await db.execute({ sql: `SELECT COUNT(*) as c FROM visits v WHERE v.author_id=? ${dateCond}`, args: [sm.id, ...args] });
    const total = Number(tR.rows[0]['c']);
    const sR = await db.execute({ sql: `SELECT COUNT(*) as c FROM visits v WHERE v.author_id=? AND v.is_success=1 ${dateCond}`, args: [sm.id, ...args] });
    const success = Number(sR.rows[0]['c']);
    const fR = await db.execute({ sql: `SELECT COUNT(*) as c FROM visits v WHERE v.author_id=? AND v.is_success=0 ${dateCond}`, args: [sm.id, ...args] });
    const notSuccess = Number(fR.rows[0]['c']);
    enriched.push({
      id: sm.id, display_name: sm.display_name, username: sm.username,
      total_visits: total,
      success_visits: success,
      not_success_visits: notSuccess,
      success_rate: total > 0 ? Math.round((success / total) * 100) : 0,
    });
  }
  res.json(enriched);
});

module.exports = router;