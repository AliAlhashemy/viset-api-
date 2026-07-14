window.VISET = {
  API_BASE: '/api',
  token: localStorage.getItem('viset_token') || '',
  user: null,
  _readyResolve: null,
  ready: null,

  setToken(t) {
    this.token = t;
    localStorage.setItem('viset_token', t);
    document.cookie = `viset_token=${t}; path=/; max-age=86400; SameSite=Strict; Secure`;
  },
  clearToken() {
    this.token = '';
    localStorage.removeItem('viset_token');
    document.cookie = 'viset_token=; path=/; max-age=0';
  },

  headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  },

  async apiRaw(endpoint, opts = {}) {
    return fetch(`${this.API_BASE}/${endpoint}`, { ...opts, headers: { ...this.headers(), ...opts.headers } });
  },

  async api(endpoint, opts = {}) {
    const url = `${this.API_BASE}/${endpoint}`;
    const res = await fetch(url, { ...opts, headers: { ...this.headers(), ...opts.headers } });
    if (!res.ok) {
      if (res.status === 401) { this.clearToken(); window.location.href = '/'; }
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    if (endpoint.includes('template') || endpoint.includes('export')) return res;
    return res.json();
  },

  async login(username, password) {
    const res = await fetch(`${this.API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const data = await res.json();
    this.setToken(data.token);
    this.user = data.user;
    return data;
  },

  logout() { this.clearToken(); window.location.href = '/'; },

  vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); },

  getOfflineQueue() {
    try { return JSON.parse(localStorage.getItem('viset_offline') || '[]'); } catch { return []; }
  },
  saveOffline(payload) {
    const q = this.getOfflineQueue();
    q.push(payload);
    localStorage.setItem('viset_offline', JSON.stringify(q));
  },
  clearOfflineQueue() { localStorage.removeItem('viset_offline'); },

  locale: localStorage.getItem('viset_locale') || 'en',

  __(key) {
    return (window.LANG?.[this.locale]?.[key]) || (window.LANG?.en?.[key]) || key;
  },

  get dir() { return this.locale === 'ar' ? 'rtl' : 'ltr'; },

  toggleLang() {
    this.locale = this.locale === 'en' ? 'ar' : 'en';
    localStorage.setItem('viset_locale', this.locale);
    window.location.reload();
  },
};

window.VISET._permReady = false;
window.VISET.can = () => false;
window.VISET.canAny = () => false;
window.VISET.ready = new Promise(resolve => { window.VISET._readyResolve = resolve; });

// Set initial direction
document.documentElement.dir = VISET.dir;
document.documentElement.lang = VISET.locale;

(async () => {
  if (VISET.token) {
    try {
      const res = await fetch(`${VISET.API_BASE}/auth/me?_=${Date.now()}`, { headers: VISET.headers() });
      if (res.ok) VISET.user = await res.json();
    } catch (e) { VISET.clearToken(); }
  }
  // Load permissions
  VISET.permissions = [];
  if (VISET.token && VISET.user) {
    try {
      const r = await fetch(`${VISET.API_BASE}/permissions/me`, { headers: VISET.headers() });
      if (r.ok) { const d = await r.json(); VISET.permissions = d.permissions || []; }
    } catch (e) { /* permissions unavailable */ }
  }
  VISET.can = (key) => {
    if (VISET.user?.role === 'admin') return true;
    return VISET.permissions.includes(key);
  };
  VISET.canAny = (prefix) => {
    if (VISET.user?.role === 'admin') return true;
    return VISET.permissions.some(p => p.startsWith(prefix));
  };
  VISET._permReady = true;
  if (VISET._readyResolve) VISET._readyResolve();
})();
