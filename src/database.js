const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

let db;
let initPromise = null;

function getDb() {
  if (db) return db;
  const url = process.env.TURSO_URL || `file:${process.env.DB_PATH || './data/viset.db'}`;
  const authToken = process.env.TURSO_TOKEN;
  if (url.startsWith('file:')) {
    const filePath = url.slice(5);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  db = createClient({ url, authToken });
  // Wrap execute to always provide args (fixes @libsql/client bug with undefined args over HTTP)
  const origExec = db.execute.bind(db);
  db.execute = (stmt) => origExec({ ...stmt, args: stmt.args || [] });
  return db;
}

async function initDb() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const client = getDb();
    await initSchema(client);
    await seedDefaults(client);
  })();
  return initPromise;
}

async function initSchema(client) {
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'salesman' CHECK(role IN ('admin','manager','supervisor','accountant','salesman')),
    department_id INTEGER DEFAULT 0,
    job_title_id INTEGER DEFAULT 0,
    employee_code TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS job_titles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_id INTEGER DEFAULT 0,
    customer_type TEXT NOT NULL DEFAULT 'new' CHECK(customer_type IN ('new','old')),
    visit_purpose TEXT DEFAULT '',
    latitude REAL DEFAULT 0,
    longitude REAL DEFAULT 0,
    address TEXT DEFAULT '',
    photo_id INTEGER DEFAULT 0,
    photo_url TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','review','approved','flagged','completed')),
    workflow_note TEXT DEFAULT '',
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT DEFAULT '',
    name TEXT NOT NULL,
    buyer TEXT DEFAULT '',
    email TEXT DEFAULT '',
    building TEXT DEFAULT '',
    street TEXT DEFAULT '',
    city TEXT DEFAULT '',
    country TEXT DEFAULT '',
    postal TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    latitude REAL DEFAULT 0,
    longitude REAL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'new' CHECK(type IN ('new','old')),
    business_type TEXT NOT NULL DEFAULT 'retail' CHECK(business_type IN ('retail','wholesale','horeca')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS visit_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER NOT NULL REFERENCES visits(id),
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    file_type TEXT DEFAULT '',
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS workflow_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER NOT NULL REFERENCES visits(id),
    from_status TEXT NOT NULL DEFAULT '',
    to_status TEXT NOT NULL DEFAULT '',
    action TEXT DEFAULT '',
    note TEXT DEFAULT '',
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_visits_author ON visits(author_id)' });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status)' });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)' });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_wf_visit ON workflow_log(visit_id)' });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'production',
    flow TEXT NOT NULL DEFAULT 'production',
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
    author_id INTEGER NOT NULL REFERENCES users(id),
    assigned_to INTEGER REFERENCES users(id),
    visit_id INTEGER REFERENCES visits(id),
    customer_name TEXT DEFAULT '',
    parent_id INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(author_id)' });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to)' });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)' });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS ticket_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    action TEXT DEFAULT '',
    from_status TEXT DEFAULT '',
    to_status TEXT DEFAULT '',
    note TEXT DEFAULT '',
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tlog_ticket ON ticket_log(ticket_id)' });
  await client.execute({ sql: `CREATE TABLE IF NOT EXISTS task_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    icon TEXT DEFAULT '📌',
    color TEXT DEFAULT '#6b7280',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )` });
  await migrateSchema(client);
}

async function migrateSchema(client) {
  const r1 = await client.execute({ sql: "PRAGMA table_info('visits')" });
  const vCols = r1.rows.map(r => r['name']);
  if (!vCols.includes('visit_task')) {
    await client.execute({ sql: "ALTER TABLE visits ADD COLUMN visit_task TEXT NOT NULL DEFAULT 'visit'" });
  }
  if (!vCols.includes('visit_note')) {
    await client.execute({ sql: "ALTER TABLE visits ADD COLUMN visit_note TEXT DEFAULT ''" });
  }
  if (!vCols.includes('workflow_note')) {
    await client.execute({ sql: "ALTER TABLE visits ADD COLUMN workflow_note TEXT DEFAULT ''" });
  }
  const r2 = await client.execute({ sql: "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='workflow_log'" });
  const tableCount = Number(r2.rows[0]['c']);
  if (tableCount === 0) {
    await client.execute({ sql: `CREATE TABLE workflow_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL REFERENCES visits(id),
      from_status TEXT NOT NULL DEFAULT '',
      to_status TEXT NOT NULL DEFAULT '',
      action TEXT DEFAULT '',
      note TEXT DEFAULT '',
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )` });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_wf_visit ON workflow_log(visit_id)' });
  }
  const r3 = await client.execute({ sql: "PRAGMA table_info('customers')" });
  const cCols = r3.rows.map(r => r['name']);
  if (!cCols.includes('visit_count')) {
    await client.execute({ sql: "ALTER TABLE customers ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 0" });
  }
  if (!cCols.includes('customer_code')) {
    await client.execute({ sql: "ALTER TABLE customers ADD COLUMN customer_code TEXT DEFAULT ''" });
  }
  const r5 = await client.execute({ sql: "PRAGMA table_info('visit_documents')" });
  const docCols = r5.rows.map(r => r['name']);
  if (!docCols.includes('doc_type')) {
    await client.execute({ sql: "ALTER TABLE visit_documents ADD COLUMN doc_type TEXT DEFAULT ''" });
  }
  const r4 = await client.execute({ sql: "PRAGMA table_info('users')" });
  const uCols = r4.rows.map(r => r['name']);
  const r6 = await client.execute({ sql: "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='tickets'" });
  if (Number(r6.rows[0]['c']) === 0) {
    await client.execute({ sql: `CREATE TABLE tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'production',
      flow TEXT NOT NULL DEFAULT 'production',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      author_id INTEGER NOT NULL REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      visit_id INTEGER REFERENCES visits(id),
      customer_name TEXT DEFAULT '',
      parent_id INTEGER DEFAULT 0,
      progress INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )` });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(author_id)' });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to)' });
      await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)' });
      }
  if (!vCols.includes('is_success')) {
    await client.execute({ sql: "ALTER TABLE visits ADD COLUMN is_success INTEGER DEFAULT NULL" });
  }
  if (!uCols.includes('department_id')) {
    await client.execute({ sql: "ALTER TABLE users ADD COLUMN department_id INTEGER DEFAULT 0" });
    await client.execute({ sql: "ALTER TABLE users ADD COLUMN job_title_id INTEGER DEFAULT 0" });
    await client.execute({ sql: "ALTER TABLE users ADD COLUMN employee_code TEXT DEFAULT ''" });
    await client.execute({ sql: "ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''" });
  }
  const r7 = await client.execute({ sql: "PRAGMA table_info('job_titles')" });
  const jtCols = r7.rows.map(r => r['name']);
  if (!jtCols.includes('parent_id')) {
    await client.execute({ sql: "ALTER TABLE job_titles ADD COLUMN parent_id INTEGER DEFAULT 0" });
    await client.execute({ sql: "ALTER TABLE job_titles ADD COLUMN level INTEGER DEFAULT 0" });
    await client.execute({ sql: "ALTER TABLE job_titles ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0" });
  }
  const r8 = await client.execute({ sql: "PRAGMA table_info('departments')" });
  const deptCols = r8.rows.map(r => r['name']);
  if (!deptCols.includes('manager_id')) {
    await client.execute({ sql: "ALTER TABLE departments ADD COLUMN manager_id INTEGER DEFAULT 0" });
  }
  if (!vCols.includes('parent_id')) {
    await client.execute({ sql: "ALTER TABLE visits ADD COLUMN parent_id INTEGER DEFAULT 0" });
  }
  const r9 = await client.execute({ sql: "PRAGMA table_info('tickets')" });
  const tktCols = r9.rows.map(r => r['name']);
  if (!tktCols.includes('parent_id')) {
    await client.execute({ sql: "ALTER TABLE tickets ADD COLUMN parent_id INTEGER DEFAULT 0" });
  }
  if (!tktCols.includes('progress')) {
    await client.execute({ sql: "ALTER TABLE tickets ADD COLUMN progress INTEGER DEFAULT 0" });
  }
  if (!tktCols.includes('flow')) {
    await client.execute({ sql: "ALTER TABLE tickets ADD COLUMN flow TEXT NOT NULL DEFAULT 'production'" });
  }
  const r10 = await client.execute({ sql: "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='ticket_nodes'" });
  if (Number(r10.rows[0]['c']) === 0) {
    await client.execute({ sql: `CREATE TABLE ticket_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      title TEXT NOT NULL,
      is_done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )` });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tnodes_ticket ON ticket_nodes(ticket_id)' });
  }
  // Migrate tickets table to remove old CHECK constraint on status
  const r11 = await client.execute({ sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'" });
  const oldSql = (r11.rows[0]?.sql || '').toLowerCase();
  if (oldSql.includes('check(status')) {
    console.log('Migrating tickets table: removing status CHECK constraint...');
    // Drop stale tickets_new table if previous migration attempt crashed
    const rStale = await client.execute({ sql: "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='tickets_new'" });
    if (Number(rStale.rows[0]['c']) > 0) {
      await client.execute({ sql: 'DROP TABLE tickets_new' });
    }
    // Save child table data, drop them temporarily to avoid FK constraints, then recreate
    const nodesData = (await client.execute({ sql: 'SELECT * FROM ticket_nodes' })).rows;
    const logData = (await client.execute({ sql: 'SELECT * FROM ticket_log' })).rows;
    await client.execute({ sql: 'DROP TABLE IF EXISTS ticket_nodes' });
    await client.execute({ sql: 'DROP TABLE IF EXISTS ticket_log' });
    await client.execute({ sql: `CREATE TABLE tickets_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'production',
      flow TEXT NOT NULL DEFAULT 'production',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      author_id INTEGER NOT NULL REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      visit_id INTEGER REFERENCES visits(id),
      customer_name TEXT DEFAULT '',
      parent_id INTEGER DEFAULT 0,
      progress INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )` });
    const cols = ['id','title','description','status','flow','priority','author_id','assigned_to','visit_id','customer_name','parent_id','progress','created_at','updated_at'];
    await client.execute({ sql: `INSERT INTO tickets_new (${cols.join(',')}) SELECT ${cols.join(',')} FROM tickets` });
    await client.execute({ sql: 'DROP TABLE tickets' });
    await client.execute({ sql: 'ALTER TABLE tickets_new RENAME TO tickets' });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(author_id)' });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to)' });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)' });
    // Recreate child tables and restore data
    await client.execute({ sql: `CREATE TABLE ticket_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      action TEXT DEFAULT '',
      from_status TEXT DEFAULT '',
      to_status TEXT DEFAULT '',
      note TEXT DEFAULT '',
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )` });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tlog_ticket ON ticket_log(ticket_id)' });
    await client.execute({ sql: `CREATE TABLE ticket_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      title TEXT NOT NULL,
      is_done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )` });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_tnodes_ticket ON ticket_nodes(ticket_id)' });
    for (const row of nodesData) {
      await client.execute({ sql: 'INSERT INTO ticket_nodes (id, ticket_id, title, is_done, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)', args: [row.id, row.ticket_id, row.title, row.is_done, row.sort_order, row.created_at] });
    }
    for (const row of logData) {
      await client.execute({ sql: 'INSERT INTO ticket_log (id, ticket_id, action, from_status, to_status, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [row.id, row.ticket_id, row.action, row.from_status, row.to_status, row.note, row.user_id, row.created_at] });
    }
    console.log('Tickets table migration complete.');
  }
  // Ticket approvals table
  const rApprovals = await client.execute({ sql: "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='ticket_approvals'" });
  if (Number(rApprovals.rows[0]['c']) === 0) {
    await client.execute({ sql: `CREATE TABLE ticket_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      assigned_role TEXT DEFAULT '',
      assigned_user INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )` });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_approval_ticket ON ticket_approvals(ticket_id)' });
    await client.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_approval_status ON ticket_approvals(status)' });
  }
  // Add purchase_data column to tickets
  const rTktCols = await client.execute({ sql: "PRAGMA table_info('tickets')" });
  const tktColNames = rTktCols.rows.map(r => r['name']);
  if (!tktColNames.includes('purchase_data')) {
    await client.execute({ sql: "ALTER TABLE tickets ADD COLUMN purchase_data TEXT DEFAULT '{}'" });
  }
  // Rename old status value from pre-rename tickets
  await client.execute({ sql: "UPDATE tickets SET status = 'production' WHERE status = 'production_ticket'" });
  // Fix purchase tickets with wrong initial status (previously defaulted to 'production')
  await client.execute({ sql: "UPDATE tickets SET status = 'purchase_request', progress = 0 WHERE flow = 'purchase' AND status = 'production'" });
  // Permissions & labels tables
  const rPerm = await client.execute({ sql: "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='permissions'" });
  if (Number(rPerm.rows[0]['c']) === 0) {
    await client.execute({ sql: `CREATE TABLE permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT DEFAULT '')` });
    await client.execute({ sql: `CREATE TABLE labels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6366f1', description TEXT DEFAULT '')` });
    await client.execute({ sql: `CREATE TABLE label_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE, permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, UNIQUE(label_id, permission_id))` });
    await client.execute({ sql: `CREATE TABLE user_labels (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE, UNIQUE(user_id, label_id))` });
  }
    // Seed default permissions (always runs to add any new ones)
    const defaultPerms = [
      ['ticket.view', 'Tickets', 'Can view tickets page'],
      ['visit.create', 'Create Visit', 'Can create new visits'],
      ['visit.submit', 'Submit Visit', 'Can submit completed visits'],
      ['ticket.production.create', 'Create Production Ticket', 'Can create production tickets'],
      ['ticket.purchase.create', 'Create Purchase Ticket', 'Can create purchase tickets'],
      ['ticket.purchase.purchase_request', 'Purchase Request Step', 'Can access purchase request step'],
      ['ticket.purchase.payment_request', 'Payment Request Step', 'Can access payment request step'],
      ['ticket.purchase.create_po', 'Create PO Step', 'Can access create PO step'],
      ['ticket.purchase.posting', 'Posting Step', 'Can access posting step'],
      ['ticket.purchase.close', 'Close Purchase', 'Can close purchase tickets'],
      ['ticket.production.production', 'Production Step', 'Can access production step'],
      ['ticket.production.create_ticket', 'Create Ticket Step', 'Can access create ticket step'],
      ['ticket.production.report_finish', 'Report Finish Step', 'Can access report finish step'],
      ['ticket.production.transfer_warehouse', 'Transfer Warehouse Step', 'Can access transfer warehouse step'],
      ['ticket.production.received', 'Received Step', 'Can access received step'],
      ['ticket.production.ended', 'Ended Step', 'Can access ended step'],
      ['admin.dashboard', 'Dashboard', 'Can access the admin dashboard'],
      ['admin.workflow', 'Workflow', 'Can access workflow pages'],
      ['admin.customers', 'Customers', 'Can manage customers'],
      ['admin.employees', 'Employees', 'Can manage employees'],
      ['admin.departments', 'Departments', 'Can manage departments'],
      ['admin.job_titles', 'Job Titles', 'Can manage job titles'],
      ['admin.task_types', 'Task Types', 'Can manage task types'],
      ['admin.users', 'Users', 'Can manage users and roles'],
      ['admin.labels', 'Labels', 'Can manage permission labels'],
      ['reports.view', 'Reports', 'Can view reports'],
    ];
    for (const [key, name, desc] of defaultPerms) {
      await client.execute({ sql: 'INSERT OR IGNORE INTO permissions (key, name, description) VALUES (?, ?, ?)', args: [key, name, desc] });
    }
}

async function seedDefaults(client) {
  const bcrypt = require('bcryptjs');
  const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
  const adminExists = await client.execute({ sql: "SELECT id FROM users WHERE username = 'ADMIN'" });
  if (adminExists.rows[0]) {
    await client.execute({ sql: "UPDATE users SET password = ? WHERE username = 'ADMIN'", args: [adminPass] });
  } else {
    await client.execute({ sql: 'INSERT INTO users (username, password, display_name, email, role) VALUES (?, ?, ?, ?, ?)', args: ['ADMIN', adminPass, 'Admin', 'admin@change-me.local', 'admin'] });
  }
  const r = await client.execute({ sql: 'SELECT COUNT(*) as c FROM users' });
  const count = Number(r.rows[0]['c']);
  if (count <= 1) {
    const salesmanPass = bcrypt.hashSync(process.env.SALESMAN_PASSWORD || 'visit123', 10);
    await client.execute({ sql: 'INSERT INTO users (username, password, display_name, email, role) VALUES (?, ?, ?, ?, ?)', args: ['salesman1', salesmanPass, 'Salesman One', 'salesman1@change-me.local', 'salesman'] });
  }
  // Seed default task types if table is empty
  const tr = await client.execute({ sql: 'SELECT COUNT(*) as c FROM task_types' });
  if (Number(tr.rows[0]['c']) === 0) {
    const defaults = [
      ['visit', 'Visit', '🛒', '#3b82f6', 1],
      ['order', 'Order', '📋', '#059669', 2],
      ['followup', 'Follow-up', '📞', '#d97706', 3],
      ['demo', 'Demo', '📱', '#7c3aed', 4],
      ['payment', 'Payment', '💰', '#db2777', 5],
      ['callback', 'Call Back', '🔙', '#78716c', 6],
      ['other', 'Other', '📌', '#64748b', 7],
      ['opening', 'New Customer Opening', '📋', '#0891b2', 8],
    ];
    for (const [name, label, icon, color, sort] of defaults) {
      await client.execute({ sql: 'INSERT INTO task_types (name, label, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)', args: [name, label, icon, color, sort] });
    }
  }
}

module.exports = { getDb, initDb };
