const { Router } = require('express');
const { getDb } = require('../database');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = Router();

router.get('/', authenticate, async (req, res) => {
  const db = getDb();
  const r = await db.execute({ sql: 'SELECT id, account, name, buyer, email, building, street, city, country, postal, phone, address, latitude, longitude, type, business_type, customer_code, created_at FROM customers ORDER BY name ASC' });
  res.json(r.rows);
});

router.get('/template', (req, res) => {
  const cols = ['CustomerAccount','اسم المورد','Buyer Name'];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="customer-template.csv"');
  res.write('\uFEFF');
  res.write(cols.join(',') + '\n');
  res.write(['ACC-001','مورد تجريبي','Ahmed Ali'].join(',') + '\n');
  res.end();
});

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

const fieldMap = {
  'CustomerAccount': 'account', 'اسم المورد': 'name',
  'Buyer Name': 'buyer',
};

function parseCsvRows(filePath) {
  const csv = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { rows: [], error: 'Empty CSV' };
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    const data = { account: '', name: '', buyer: '' };
    for (const [csvCol, dbCol] of Object.entries(fieldMap)) {
      if (row[csvCol]) data[dbCol] = row[csvCol];
    }
    rows.push(data);
  }
  return { rows, error: null };
}

router.post('/preview', authenticate, requireRole('admin', 'manager'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { rows, error } = parseCsvRows(req.file.path);
  fs.unlinkSync(req.file.path);
  if (error) return res.status(400).json({ error });

  const db = getDb();
  const nr = await db.execute({ sql: 'SELECT name FROM customers' });
  const existingNames = new Set(
    nr.rows.map(r => r['name'].trim().toLowerCase())
  );

  rows.forEach((r, i) => {
    r.index = i;
    r.duplicate = existingNames.has((r.name || '').trim().toLowerCase());
    r.selected = true;
  });

  res.json({ total: rows.length, rows });
});

router.post('/import', authenticate, requireRole('admin', 'manager'), upload.single('file'), async (req, res) => {
  let rows;

  if (req.file) {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = parseCsvRows(req.file.path);
    fs.unlinkSync(req.file.path);
    if (result.error) return res.status(400).json({ error: result.error });
    rows = result.rows;
  } else {
    rows = req.body.rows;
    if (!rows || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'No rows to import' });
    }
  }

  const db = getDb();
  let imported = 0;
  const errors = [];

  for (const data of rows) {
    const name = data.name || data.account || '';
    if (!name) { errors.push('empty name'); continue; }
    if (name.length > 200) { errors.push('name too long'); continue; }
    try {
      await db.execute({
        sql: 'INSERT INTO customers (account, name, buyer, email, building, street, city, country, postal, phone, address, latitude, longitude, type, business_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [
          (data.account || '').slice(0, 100), name.slice(0, 200),
          (data.buyer || '').slice(0, 100),
          '', '', '', '', '', '',
          '', '', 0, 0,
          'new', 'retail'
        ]
      });
      imported++;
    } catch (e) {
      errors.push(e.message);
    }
  }

  res.json({ imported, errors });
});

module.exports = router;