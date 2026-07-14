document.addEventListener('alpine:init', () => {

  Alpine.data('visetDashboard', () => ({
    _ready: false,
    showForm: false,
    visits: [],
    taskTypes: [],
    pendingSync: 0,
    loading: true,
    get dateStr() {
      return new Date().toLocaleDateString(VISET.locale === 'ar' ? 'ar-SA' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    },
    get user() { return VISET.user; },
    statusLabel(s) { return VISET.__('status.' + s) || s; },

    init() {
      this._ready = VISET._permReady;
      if (!VISET._permReady) VISET.ready.then(() => { this._ready = true; });
      this.loadVisits();
      this.loadTaskTypes();
      this.pendingSync = VISET.getOfflineQueue().length;
      if (new URLSearchParams(window.location.search).get('submitted') === '1') {
        setTimeout(() => { this.showSuccess = true; setTimeout(() => this.showSuccess = false, 3000); }, 100);
      }
    },

    async loadVisits() {
      try { this.visits = await VISET.api('visits'); } catch (e) { console.warn(e); }
      this.loading = false;
    },

    async loadTaskTypes() {
      try { this.taskTypes = await VISET.api('task-types'); } catch (e) { console.warn(e); }
    },

    get stateInfo() {
      return [
        { key: 'pending',   label: VISET.__('status.pending'),   color: '#d97706' },
        { key: 'review',    label: VISET.__('status.review'),    color: '#6366f1' },
        { key: 'approved',  label: VISET.__('status.approved'),  color: '#059669' },
        { key: 'flagged',   label: VISET.__('status.flagged'),   color: '#dc2626' },
        { key: 'completed', label: VISET.__('status.completed'), color: '#6b7280' },
      ];
    },

    get activeTasks() {
      return this.visits.filter(v => v.status === 'pending' || v.status === 'review');
    },
    get visitHistory() {
      return this.visits.filter(v => v.status === 'approved' || v.status === 'flagged' || v.status === 'completed');
    },
    get board() {
      const columns = {};
      const counts = {};
      this.stateInfo.forEach(s => { columns[s.key] = []; counts[s.key] = 0; });
      this.visits.forEach(v => {
        const key = this.stateInfo.find(s => s.key === v.status) ? v.status : 'pending';
        columns[key].push(v);
        counts[key]++;
      });
      return { columns, counts };
    },

    openForm() { this.showForm = true; },
    closeForm() { this.showForm = false; },

    async syncOffline() {
      const queue = VISET.getOfflineQueue();
      if (!queue.length) return;
      for (const visit of queue) {
        try { await VISET.api('visits', { method: 'POST', body: JSON.stringify(visit) }); }
        catch (e) { console.warn('sync error', e); }
      }
      VISET.clearOfflineQueue();
      this.pendingSync = 0;
      this.loadVisits();
    },

    logout() { VISET.logout(); },
    statusColor(s) { return { pending:'#eab308', review:'#6366f1', approved:'#22c55e', flagged:'#ef4444', completed:'#6b7280' }[s] || '#9ca3af'; },
    taskIcon(v) {
      if (!v) return '📌';
      const t = this.taskTypes.find(tt => tt.name === v.visit_task);
      return t ? t.icon : '📌';
    },
    showSuccess: false,
    selectedVisit: null,
    editNote: '',
    editTask: '',
    savingEdit: false,
    editMsg: '',
    editMsgType: '',
    uploadingToVisit: false,
    showBranchTaskForm: false,
    branchTaskParentId: 0,
    branchTaskType: 'followup',
    branchTaskNote: '',
    savingBranch: false,
    branchMsg: '',
    branchMsgType: '',

    async submitBranchTask() {
      if (!this.branchTaskParentId) return;
      this.savingBranch = true; this.branchMsg = '';
      try {
        const body = {
          customer_name: this.selectedVisit?.customer_name || '',
          customer_id: this.selectedVisit?.customer_id || 0,
          visit_task: this.branchTaskType || 'followup',
          visit_purpose: this.branchTaskNote || '',
          parent_id: this.branchTaskParentId,
          address: this.selectedVisit?.address || '',
          latitude: this.selectedVisit?.latitude || 0,
          longitude: this.selectedVisit?.longitude || 0,
        };
        const r = await fetch(`${VISET.API_BASE}/visits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (r.ok) {
          this.branchMsg = 'Branch task created!';
          this.branchMsgType = 'success';
          this.showBranchTaskForm = false;
          this.branchTaskNote = '';
          this.loadVisits();
        } else {
          this.branchMsg = d.error || 'Failed';
          this.branchMsgType = 'error';
        }
      } catch (e) {
        this.branchMsg = 'Connection error';
        this.branchMsgType = 'error';
      }
      this.savingBranch = false;
    },

    viewVisit(v) {
      this.selectedVisit = v;
      this.editNote = v.visit_note || '';
      this.editTask = v.visit_task || '';
      this.editMsg = '';
      this.showBranchTaskForm = false;
      this.branchMsg = '';
    },

    canEdit(v) {
      return v && v.status === 'pending' && v.author_id === this.user?.id;
    },

    async saveEdit() {
      if (!this.selectedVisit) return;
      this.savingEdit = true;
      this.editMsg = '';
      const body = { visit_note: this.editNote };
      if (this.editTask && this.editTask !== this.selectedVisit.visit_task) {
        body.visit_task = this.editTask;
      }
      try {
        const r = await VISET.apiRaw(`visits/${this.selectedVisit.id}/edit`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.ok) {
          const updated = await r.json();
          const idx = this.visits.findIndex(v => v.id === this.selectedVisit.id);
          if (idx >= 0) Object.assign(this.visits[idx], updated);
          Object.assign(this.selectedVisit, updated);
          this.editMsg = '✅ Saved';
          this.editMsgType = 'success';
        } else {
          const d = await r.json();
          this.editMsg = d.error || 'Error';
          this.editMsgType = 'error';
        }
      } catch (e) { this.editMsg = 'Error saving'; this.editMsgType = 'error'; }
      this.savingEdit = false;
    },

    async uploadDocToVisit(visitId, docType) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp';
      input.onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        this.uploadingToVisit = true;
        const fd = new FormData();
        fd.append('file', file);
        try {
          const ur = await fetch(`${VISET.API_BASE}/upload/document`, {
            method: 'POST', headers: { Authorization: `Bearer ${VISET.token}` }, body: fd,
          });
          const d = await ur.json();
          if (d.url) {
            await fetch(`${VISET.API_BASE}/documents/${visitId}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...d, doc_type: docType || '' }),
            });
            // Refresh visit documents
            const dr = await fetch(`${VISET.API_BASE}/documents/${visitId}`, {
              headers: { Authorization: `Bearer ${VISET.token}` },
            });
            if (dr.ok) {
              const docs = await dr.json();
              this.selectedVisit.documents = docs;
              const idx = this.visits.findIndex(v => v.id === visitId);
              if (idx >= 0) this.visits[idx].documents = docs;
            }
          }
        } catch (e) { console.warn(e); }
        this.uploadingToVisit = false;
      };
      input.click();
    },

    async deleteDocFromVisit(visitId, doc) {
      if (!confirm('Remove this document?')) return;
      try {
        const r = await fetch(`${VISET.API_BASE}/documents/${visitId}/${doc.id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${VISET.token}` },
        });
        if (r.ok) {
          this.selectedVisit.documents = (this.selectedVisit.documents || []).filter(d => d.id !== doc.id);
          const idx = this.visits.findIndex(v => v.id === visitId);
          if (idx >= 0) this.visits[idx].documents = this.selectedVisit.documents;
        }
      } catch (e) { console.warn(e); }
    },

    photoPreview: null,

    async editCapturePhoto() {
      const overlay = document.createElement('div');
      overlay.id = 'cam-edit-overlay';
      Object.assign(overlay.style, {
        position:'fixed', inset:'0', zIndex:'9999', background:'#000',
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center'
      });
      overlay.innerHTML = `
        <video id="cam-edit-feed" autoplay playsinline style="width:100%;max-height:80vh;object-fit:contain;background:#000"></video>
        <div style="position:fixed;bottom:40px;left:0;right:0;display:flex;justify-content:center;gap:40px;z-index:10000">
          <button id="cam-edit-cancel" style="width:60px;height:60px;border-radius:50%;border:4px solid #fff;background:rgba(255,255,255,.2);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Cancel</button>
          <button id="cam-edit-shutter" style="width:70px;height:70px;border-radius:50%;border:5px solid #fff;background:#fff;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4)"></button>
        </div>
      `;
      document.body.appendChild(overlay);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
        const video = document.getElementById('cam-edit-feed');
        video.srcObject = stream;
        await video.play();
        const blob = await new Promise((resolve) => {
          document.getElementById('cam-edit-shutter').onclick = () => {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            stream.getTracks().forEach(t => t.stop());
            overlay.remove();
            canvas.toBlob(resolve, 'image/jpeg', 0.85);
          };
          document.getElementById('cam-edit-cancel').onclick = () => {
            stream.getTracks().forEach(t => t.stop());
            overlay.remove();
            resolve(null);
          };
        });
        if (!blob) return;
        this.editMsg = '⏳ Uploading photo...';
        this.editMsgType = '';
        const form = new FormData();
        form.append('file', blob, `edit_${Date.now()}.jpg`);
        const r = await fetch(`${VISET.API_BASE}/upload`, {
          method: 'POST', headers: { Authorization: `Bearer ${VISET.token}` }, body: form,
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: 'Upload failed' }));
          this.editMsg = '❌ Upload failed: ' + (err.error || r.status);
          this.editMsgType = 'error';
          return;
        }
        const d = await r.json();
        console.log('Photo upload response:', d);
        if (!d.url) {
          this.editMsg = '❌ No URL returned';
          this.editMsgType = 'error';
          return;
        }
        this.selectedVisit.photo_url = d.url;
        this.selectedVisit.photo_id = d.id;
        const idx = this.visits.findIndex(v => v.id === this.selectedVisit.id);
        if (idx >= 0) { this.visits[idx].photo_url = d.url; this.visits[idx].photo_id = d.id; }
        const saveResult = await VISET.apiRaw(`visits/${this.selectedVisit.id}/edit`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_url: d.url, photo_id: d.id }),
        });
        if (!saveResult.ok) {
          const err = await saveResult.json().catch(() => ({ error: 'Save failed' }));
          console.warn('Photo save failed:', err);
          this.editMsg = '⚠️ Photo captured but not saved to server';
          this.editMsgType = 'error';
          return;
        }
        this.editMsg = '✅ Photo saved';
        this.editMsgType = 'success';
        VISET.vibrate([100, 50, 100]);
      } catch (e) { console.error('Camera error:', e); this.editMsg = '❌ Camera error: ' + e.message; this.editMsgType = 'error'; }
    },
  }));

  Alpine.data('visetForm', () => ({
    customer_name: '',
    customer_id: 0,
    customer_type: 'new',
    new_name: '',
    new_address: '',
    new_business: 'retail',
    visit_purpose: '',
    visit_task: 'visit',
    taskTypes: [],
    taskOptions: [],
    latitude: 0,
    longitude: 0,
    address: '',
    manual_address: '',
    photo_id: 0,
    photoPreview: '',
    documents: [],
    uploadingDoc: false,
    locating: false,
    locationFetched: false,
    showManual: false,
    submitting: false,
    offline: false,
    geoStatusClass: 'border-gray-200',
    customers: [],
    search: '',
    selectedCustomerId: 0,

    get filteredCustomers() {
      const sorted = [...this.customers].sort((a, b) => (a.account || '').localeCompare(b.account || ''));
      if (!this.search) return sorted;
      const q = this.search.toLowerCase();
      return sorted.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.account && c.account.toLowerCase().includes(q)) ||
        (c.address && c.address.toLowerCase().includes(q))
      );
    },

    async loadCustomers() {
      try { this.customers = await VISET.api('customers'); } catch (e) { console.warn(e); }
      try {
        this.taskTypes = await VISET.api('task-types');
        this.taskOptions = this.taskTypes.filter(t => t.is_active).map(t => ({
          value: t.name, label: t.icon + ' ' + t.label,
          style: `background:${t.color}22;color:${t.color};border:2px solid ${t.color}`
        }));
        if (this.taskOptions.length && !this.taskOptions.find(o => o.value === this.visit_task)) {
          this.visit_task = this.taskOptions[0].value;
        }
      } catch (e) { console.warn(e); }
    },

    selectCustomer(c) {
      this.customer_name = c.name;
      this.customer_id = c.id;
      this.customer_type = 'old';
      this.selectedCustomerId = c.id;
      this.search = c.name;
      if (c.address && !this.locationFetched) {
        this.address = c.address;
        this.latitude = c.latitude || 0;
        this.longitude = c.longitude || 0;
        if (c.latitude) { this.locationFetched = true; this.geoStatusClass = 'border-blue-400'; }
      }
    },

    async fetchLocation() {
      this.locating = true;
      this.showManual = false;
      const timeout = setTimeout(() => { this.showManual = true; this.locating = false; }, 10000);
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 8000 }));
        clearTimeout(timeout);
        this.latitude = pos.coords.latitude;
        this.longitude = pos.coords.longitude;
        const geo = await VISET.api('geocode', { method: 'POST', body: JSON.stringify({ lat: this.latitude, lng: this.longitude }) });
        this.address = geo.address;
        this.locationFetched = true;
        this.geoStatusClass = 'border-green-400';
        VISET.vibrate(100);
      } catch (e) {
        clearTimeout(timeout);
        this.showManual = true;
      }
      this.locating = false;
    },

    useManualAddress() {
      if (this.manual_address) {
        this.address = this.manual_address;
        this.locationFetched = true;
        this.geoStatusClass = 'border-yellow-400';
      }
    },

    async capturePhoto() {
      const overlay = document.createElement('div');
      overlay.id = 'camera-overlay';
      Object.assign(overlay.style, {
        position:'fixed', inset:'0', zIndex:'9999', background:'#000',
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center'
      });
      overlay.innerHTML = `
        <video id="camera-feed" autoplay playsinline style="width:100%;max-height:80vh;object-fit:contain;background:#000"></video>
        <div style="position:fixed;bottom:40px;left:0;right:0;display:flex;justify-content:center;gap:40px;z-index:10000">
          <button id="cam-cancel" style="width:60px;height:60px;border-radius:50%;border:4px solid #fff;background:rgba(255,255,255,.2);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Cancel</button>
          <button id="cam-shutter" style="width:70px;height:70px;border-radius:50%;border:5px solid #fff;background:#fff;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4)"></button>
        </div>
      `;
      document.body.appendChild(overlay);
      const video = document.getElementById('camera-feed');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
      video.srcObject = stream;
      await video.play();
      document.getElementById('cam-shutter').onclick = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        stream.getTracks().forEach(t => t.stop());
        overlay.remove();
        canvas.toBlob(async (blob) => {
          const form = new FormData();
          form.append('file', blob, `visit_${Date.now()}.jpg`);
          try {
            const r = await fetch(`${VISET.API_BASE}/upload`, {
              method: 'POST', headers: { Authorization: `Bearer ${VISET.token}` }, body: form,
            });
            const d = await r.json();
            if (d.url) { this.photo_id = d.id; this.photoPreview = d.url; VISET.vibrate([100, 50, 100]); }
          } catch (e) { console.warn(e); }
        }, 'image/jpeg', 0.85);
      };
      document.getElementById('cam-cancel').onclick = () => {
        stream.getTracks().forEach(t => t.stop());
        overlay.remove();
      };
    },

    async uploadDocument() {
      this._uploadDocWithType('');
    },

    async uploadDocWithType(docType) {
      this._uploadDocWithType(docType);
    },

    async _uploadDocWithType(docType) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp';
      input.onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        this.uploadingDoc = true;
        const fd = new FormData();
        fd.append('file', file);
        try {
          const r = await fetch(`${VISET.API_BASE}/upload/document`, {
            method: 'POST', headers: { Authorization: `Bearer ${VISET.token}` }, body: fd,
          });
          const d = await r.json();
          if (d.url) this.documents.push({ ...d, original_name: d.original_name, url: d.url, filename: d.filename, size: d.size, mimetype: d.mimetype, _docType: docType });
        } catch (e) { console.warn(e); }
        this.uploadingDoc = false;
      };
      input.click();
    },

    async submitVisit() {
      let name = this.customer_name;
      let addr = this.address;
      let cid = this.customer_id;

      if (this.customer_type === 'new') {
        if (!this.new_name) { alert('Enter customer name'); return; }
        if (!this.new_business) { alert('Select business type'); return; }
        name = this.new_name;
        if (this.new_address) addr = this.new_address || addr;
        cid = 0;
      }

      if (!name) { alert('Customer name is required'); return; }
      if (!this.customer_type) { alert('Select customer type'); return; }
      if (!this.locationFetched) { alert('📍 Please capture your location first'); return; }
      if (!this.photoPreview && !this.photo_id) { alert('📷 Please take a proof photo first'); return; }
      this.submitting = true;

      const payload = {
        customer_name: name,
        customer_id: cid,
        customer_type: this.customer_type,
        new_customer_name: this.customer_type === 'new' ? this.new_name : '',
        new_customer_address: this.customer_type === 'new' ? (this.new_address || addr) : '',
        new_business_type: this.customer_type === 'new' ? this.new_business : '',
        visit_purpose: this.visit_purpose,
        visit_task: this.visit_task,
        latitude: this.latitude,
        longitude: this.longitude,
        address: addr,
        photo_id: this.photo_id,
        photo_url: this.photoPreview,
      };
      try {
        const visit = await VISET.api('visits', { method: 'POST', body: JSON.stringify(payload) });
        // Save documents linked to this visit
        for (const doc of this.documents) {
          const docPayload = { ...doc };
          if (docPayload._docType) { docPayload.doc_type = docPayload._docType; delete docPayload._docType; }
          await fetch(`${VISET.API_BASE}/documents/${visit.id}`, {
            method: 'POST', headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(docPayload),
          });
        }
        VISET.vibrate([100, 50, 100, 50, 100]);
        window.location.href = '/dashboard.html?submitted=1';
      } catch (e) {
        VISET.saveOffline(payload);
        this.offline = true;
        setTimeout(() => { window.location.href = '/dashboard.html'; }, 2000);
      }
      this.submitting = false;
    },

    startVoice() {
      if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = 'en-US';
      rec.onresult = (e) => { this.visit_purpose = e.results[0][0].transcript; };
      rec.start();
    },
  }));

  Alpine.data('visetSuccess', () => ({
    visitId: new URLSearchParams(window.location.search).get('viset_done') || 'N/A',
    streak: 0,
    initSuccess() {
      const c = document.getElementById('confetti-canvas');
      if (c) this.fireConfetti(c);
      this.streak = Math.min(5, Math.floor(Math.random() * 5) + 1);
      setTimeout(() => { window.location.href = '/dashboard.html'; }, 3000);
    },
    fireConfetti(canvas) {
      const ctx = canvas.getContext('2d');
      canvas.width = window.innerWidth; canvas.height = window.innerHeight;
      const pieces = Array.from({ length: 80 }, () => ({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height - canvas.height,
        w: 8, h: 8, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 3 + 2,
        color: `hsl(${Math.random() * 360}, 80%, 60%)`,
      }));
      const anim = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;
        pieces.forEach(p => {
          p.x += p.vx; p.y += p.vy; p.vy += 0.05;
          if (p.y < canvas.height) { alive = true; ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.w, p.h); }
        });
        if (alive) requestAnimationFrame(anim);
      };
      anim();
    },
  }));
});
