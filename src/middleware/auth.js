const jwt = require('jsonwebtoken');
const { getDb } = require('../database');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'fallback-secret' || secret.length < 16) {
    throw new Error('JWT_SECRET environment variable is not set or too weak. Set a strong random secret in Railway variables.');
  }
  return secret;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, getSecret());
    const db = getDb();
    const r = await db.execute({ sql: 'SELECT id, username, display_name, role FROM users WHERE id = ?', args: [decoded.userId] });
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access restricted to: ${roles.join(', ')}` });
    }
    next();
  };
}

function generateToken(user) {
  return jwt.sign({ userId: user.id, role: user.role }, getSecret(), { expiresIn: '7d' });
}

module.exports = { authenticate, requireAdmin, requireRole, generateToken };
