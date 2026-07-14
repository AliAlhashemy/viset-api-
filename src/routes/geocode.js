const { Router } = require('express');
const { authenticate } = require('../middleware/auth');

const router = Router();

router.post('/', authenticate, async (req, res) => {
  const { lat, lng } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`;
    const r = await fetch(url, { headers: { 'User-Agent': 'VISET/1.0' } });
    const data = await r.json();
    res.json({ address: data.display_name || `${lat}, ${lng}` });
  } catch (e) {
    res.json({ address: `${lat}, ${lng}` });
  }
});

module.exports = router;
