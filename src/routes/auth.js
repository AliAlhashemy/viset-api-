const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { generateToken } = require('../middleware/auth');

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Invalid input' });
  if (username.length > 100 || password.length > 200) return res.status(400).json({ error: 'Input too long' });

  const db = getDb();
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE UPPER(username) = UPPER(?)', args: [username] });
  const user = r.rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = bcrypt.compareSync(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const token = generateToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
  });
});

router.get('/me', authenticateFallback, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(req.user);
});

async function authenticateFallback(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'fallback-secret') throw new Error('JWT_SECRET not set');
    const decoded = jwt.verify(header.split(' ')[1], secret);
    const db = getDb();
    const r2 = await db.execute({ sql: 'SELECT id, username, display_name, email, role FROM users WHERE id = ?', args: [decoded.userId] });
    const user = r2.rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = router;
