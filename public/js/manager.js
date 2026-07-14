document.addEventListener('alpine:init', () => {

  Alpine.data('overviewDashboard', () => ({
    _ready: false,
    s: { total_visits: 0, pending: 0, approved: 0, flagged: 0, salesmen: [] },
    recent: [],
    taskLabels: { visit:'🛒 Visit', order:'📋 Order', followup:'📞 Follow-up', demo:'📱 Demo', payment:'💰 Payment', callback:'🔙 Call Back', other:'📌 Other' },
    init() { this._ready = VISET._permReady; if (!VISET._permReady) VISET.ready.then(() => { this._ready = true; if (!VISET.can('admin.dashboard')) window.location.href = '/'; }); else if (!VISET.can('admin.dashboard')) window.location.href = '/'; this.load(); },
    async load() {
      try {
        this.s = await VISET.api('reports/summary');
        this.recent = await VISET.api('visits?per_page=10');
      } catch (e) { console.warn(e); }
    },
  }));

  Alpine.data('customerManager', () => ({
    _ready: false,
    customers: [],
    file: null,
    loadingPreview: false,
    previewRows: [],
    importing: false,
    importDone: '',
    init() { this._ready = VISET._permReady; if (!VISET._permReady) VISET.ready.then(() => { this._ready = true; if (!VISET.can('admin.customers')) window.location.href = '/'; }); else if (!VISET.can('admin.customers')) window.location.href = '/'; this.load(); },
    async load() {
      try { this.customers = await VISET.api('customers'); }
      catch (e) { console.warn(e); }
    },
    async previewImport() {
      if (!this.file) { this.importDone = 'Select a CSV file'; return; }
      this.loadingPreview = true;
      this.previewRows = [];
      this.importDone = '';
      const fd = new FormData();
      fd.append('file', this.file);
      try {
        const r = await fetch(`${VISET.API_BASE}/customers/preview`, {
          method: 'POST', headers: { Authorization: `Bearer ${VISET.token}` }, body: fd,
        });
        const d = await r.json();
        if (r.ok) {
          this.previewRows = d.rows;
        } else {
          this.importDone = 'Error: ' + (d.error || 'Preview failed');
        }
      } catch (e) { this.importDone = 'Error: Connection failed'; }
      this.loadingPreview = false;
    },
    selectAll(v) {
      this.previewRows.forEach(r => r.selected = v);
    },
    removeRow(i) {
      this.previewRows.splice(i, 1);
    },
    async confirmImport() {
      const rows = this.previewRows.filter(r => r.selected);
      if (!rows.length) { this.importDone = 'No rows selected'; return; }
      this.importing = true;
      this.importDone = '';
      try {
        const r = await fetch(`${VISET.API_BASE}/customers/import`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows }),
        });
        const d = await r.json();
        this.importDone = `Imported: ${d.imported}${d.errors?.length ? ', Errors: ' + d.errors.length : ''}`;
        this.previewRows = [];
        this.file = null;
        this.load();
      } catch (e) { this.importDone = 'Error: Import failed'; }
      this.importing = false;
    },
    deleteCustomer(id) {
      if (!confirm('Delete this customer?')) return;
    },
    downloadTemplate() {
      window.open(`${VISET.API_BASE}/customers/template`, '_blank');
    },
  }));

  Alpine.data('employeeManager', () => ({
    _ready: false,
    employees: [],
    filtered: [],
    departments: [],
    jobTitles: [],
    jobTitlesFlat: [],
    jtLevelMap: {},
    jtLevelColorMap: {},
    form: { username: '', email: '', display_name: '', password: '', role: 'salesman', department_id: 0, job_title_id: 0, employee_code: '', phone: '' },
    saving: false,
    msg: '',
    msgType: '',
    showEditModal: false,
    editForm: { id: 0, display_name: '', email: '', role: 'salesman', department_id: 0, job_title_id: 0, employee_code: '', phone: '', password: '' },
    filterDept: '0',
    filterRole: '',
    filterSearch: '',
    viewMode: 'list',
    init() { this._ready = VISET._permReady; if (!VISET._permReady) VISET.ready.then(() => { this._ready = true; if (!VISET.can('admin.employees')) window.location.href = '/'; }); else if (!VISET.can('admin.employees')) window.location.href = '/'; this.load(); this.loadDropdowns(); },
    get deptGroups() {
      const map = {};
      this.departments.forEach(d => {
        map[d.id] = { ...d, employees: [] };
      });
      map[0] = { id: 0, name: 'Unassigned', manager_name: null, employees: [] };
      this.employees.forEach(e => {
        const did = e.department_id || 0;
        if (map[did]) map[did].employees.push(e);
        else {
          map[did] = { id: did, name: e.department_name || 'Unknown', manager_name: null, employees: [e] };
        }
      });
      return Object.values(map).filter(d => d.name).sort((a, b) => a.name.localeCompare(b.name));
    },
    async load() {
      try { this.employees = await VISET.api('users'); this.filterEmployees(); }
      catch (e) { console.warn(e); }
    },
    async loadDropdowns() {
      try { this.departments = await VISET.api('departments'); } catch (e) {}
      try {
        this.jobTitles = await VISET.api('job-titles');
        this.jobTitlesFlat = this.jobTitles.slice().sort((a, b) => a.level - b.level || a.sort_order - b.sort_order || a.name.localeCompare(b.name));
        this.jtLevelMap = {};
        this.jtLevelColorMap = {};
        const colors = ['#4f46e5', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#78716c'];
        this.jobTitles.forEach(t => {
          this.jtLevelMap[t.id] = t.level;
          this.jtLevelColorMap[t.id] = colors[(t.level || 0) % colors.length];
        });
      } catch (e) {}
    },
    jtLevelColor(id) {
      return this.jtLevelColorMap[id] || '#6b7280';
    },
    filterEmployees() {
      this.filtered = this.employees.filter(e => {
        if (this.filterDept !== '0' && e.department_id != this.filterDept) return false;
        if (this.filterRole && e.role !== this.filterRole) return false;
        if (this.filterSearch) {
          const q = this.filterSearch.toLowerCase();
          return (e.display_name || '').toLowerCase().includes(q) || e.username.toLowerCase().includes(q) || (e.employee_code || '').toLowerCase().includes(q);
        }
        return true;
      });
    },
    async createEmployee() {
      if (!this.form.username || !this.form.email || !this.form.password) {
        this.msg = 'Username, email, password required'; this.msgType = 'error'; return;
      }
      this.saving = true; this.msg = '';
      try {
        const r = await fetch(`${VISET.API_BASE}/users`, {
          method: 'POST', headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(this.form),
        });
        const d = await r.json();
        if (r.ok) {
          this.msg = `Employee "${d.display_name || d.username}" created`; this.msgType = 'success';
          this.form = { username: '', email: '', display_name: '', password: '', role: 'salesman', department_id: 0, job_title_id: 0, employee_code: '', phone: '' };
          this.load();
        } else { this.msg = d.error || 'Failed'; this.msgType = 'error'; }
      } catch (e) { this.msg = 'Connection error'; this.msgType = 'error'; }
      this.saving = false;
    },
    openEdit(u) {
      this.editForm = { id: u.id, display_name: u.display_name || '', email: u.email || '', role: u.role || 'salesman', department_id: u.department_id || 0, job_title_id: u.job_title_id || 0, employee_code: u.employee_code || '', phone: u.phone || '', password: '' };
      this.showEditModal = true; this.msg = '';
    },
    closeEdit() {
      this.showEditModal = false;
      this.editForm = { id: 0, display_name: '', email: '', role: 'salesman', department_id: 0, job_title_id: 0, employee_code: '', phone: '', password: '' };
      this.msg = '';
    },
    async saveEmployee() {
      if (!this.editForm.display_name || !this.editForm.email) {
        this.msg = 'Name and email required'; this.msgType = 'error'; return;
      }
      this.saving = true; this.msg = '';
      try {
        const body = {
          display_name: this.editForm.display_name, email: this.editForm.email,
          role: this.editForm.role, department_id: this.editForm.department_id,
          job_title_id: this.editForm.job_title_id, employee_code: this.editForm.employee_code, phone: this.editForm.phone
        };
        if (this.editForm.password) body.password = this.editForm.password;
        const r = await fetch(`${VISET.API_BASE}/users/${this.editForm.id}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (r.ok) {
          this.msg = 'Employee updated'; this.msgType = 'success';
          this.closeEdit();
          this.load();
        } else { this.msg = d.error || 'Update failed'; this.msgType = 'error'; }
      } catch (e) { this.msg = 'Connection error'; this.msgType = 'error'; }
      this.saving = false;
    },
  }));

  Alpine.data('deptManager', () => ({
    _ready: false,
    depts: [],
    users: [],
    form: { name: '', description: '', manager_id: 0 },
    editForm: { id: 0, name: '', description: '', manager_id: 0 },
    showEditModal: false,
    saving: false,
    msg: '',
    msgType: '',
    init() { this._ready = VISET._permReady; if (!VISET._permReady) VISET.ready.then(() => { this._ready = true; if (!VISET.can('admin.departments')) window.location.href = '/'; }); else if (!VISET.can('admin.departments')) window.location.href = '/'; this.load(); this.loadUsers(); },
    async load() { try { this.depts = await VISET.api('departments'); } catch (e) { console.warn(e); } },
    async loadUsers() { try { this.users = await VISET.api('users'); } catch (e) {} },
    async createDept() {
      if (!this.form.name.trim()) { this.msg = 'Name required'; this.msgType = 'error'; return; }
      this.saving = true; this.msg = '';
      try {
        const r = await fetch(`${VISET.API_BASE}/departments`, {
          method: 'POST', headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.form.name.trim(), description: this.form.description, manager_id: this.form.manager_id }),
        });
        const d = await r.json();
        if (r.ok) { this.msg = 'Department created'; this.msgType = 'success'; this.form = { name: '', description: '', manager_id: 0 }; this.load(); }
        else { this.msg = d.error; this.msgType = 'error'; }
      } catch (e) { this.msg = 'Connection error'; this.msgType = 'error'; }
      this.saving = false;
    },
    openEdit(d) {
      this.editForm = { id: d.id, name: d.name, description: d.description || '', manager_id: d.manager_id || 0 };
      this.showEditModal = true;
      this.msg = '';
    },
    async saveDept() {
      if (!this.editForm.name.trim()) { this.msg = 'Name required'; this.msgType = 'error'; return; }
      this.saving = true; this.msg = '';
      try {
        const r = await fetch(`${VISET.API_BASE}/departments/${this.editForm.id}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.editForm.name.trim(), description: this.editForm.description, manager_id: this.editForm.manager_id }),
        });
        const d = await r.json();
        if (r.ok) { this.msg = 'Department updated'; this.msgType = 'success'; this.showEditModal = false; this.load(); }
        else { this.msg = d.error; this.msgType = 'error'; }
      } catch (e) { this.msg = 'Connection error'; this.msgType = 'error'; }
      this.saving = false;
    },
    async deleteDept(id, name) {
      if (!confirm(`Delete "${name}"? Employees in this department must be reassigned first.`)) return;
      try {
        const r = await fetch(`${VISET.API_BASE}/departments/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${VISET.token}` } });
        const d = await r.json();
        if (r.ok) { this.load(); this.msg = 'Deleted'; this.msgType = 'success'; }
        else { this.msg = d.error; this.msgType = 'error'; }
      } catch (e) { this.msg = 'Error'; this.msgType = 'error'; }
    },
  }));


  Alpine.data('workflowBoard', () => ({
    _ready: false,
    selected: null,
    showModal: false,
    log: [],
    selectedDocs: [],
    transitionNote: '',
    showBranchForm: false,
    branchTaskType: 'followup',
    branchTaskNote: '',
    savingBranch: false,
    branchMsg: '',
    branchMsgType: '',
    activeTab: 'pending',
    selectedTask: '',
    searchQuery: '',
    salesmen: [],
    selectedSalesman: '',
    dateMode: 'all',
    dateFrom: '',
    dateTo: '',
    visits: [],
    page: 1,
    total: 0,
    perPage: 50,
    stateInfo: [
      { key: 'pending',   label: 'Pending',   color: '#d97706' },
      { key: 'completed', label: 'Completed', color: '#6b7280' },
    ],
    init() { this._ready = VISET._permReady; if (!VISET._permReady) VISET.ready.then(() => { this._ready = true; }); this.loadBoard(); this.loadSalesmen(); },
    getStateInfo(s) { return this.stateInfo.find(x => x.key === s); },
    async createBranchTask() {
      if (!this.selected) return;
      this.savingBranch = true; this.branchMsg = '';
      try {
        const r = await fetch(`${VISET.API_BASE}/visits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_name: this.selected.customer_name,
            customer_id: this.selected.customer_id || 0,
            visit_task: this.branchTaskType || 'followup',
            visit_purpose: this.branchTaskNote || '',
            parent_id: this.selected.id,
            address: this.selected.address || '',
            latitude: this.selected.latitude || 0,
            longitude: this.selected.longitude || 0,
          }),
        });
        const d = await r.json();
        if (r.ok) {
          this.branchMsg = 'Branch task created!';
          this.branchMsgType = 'success';
          this.showBranchForm = false;
          this.branchTaskNote = '';
          this.loadBoard();
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
    get taskTypes() { return this.board?.taskTypes || []; },
    get pendingVisits() { return (this.board?.columns?.pending || []).filter(v => !v.parent_id); },
    get completedVisits() { return (this.board?.columns?.completed || []).filter(v => !v.parent_id); },
    get allowedTransitions() {
      if (!this.selected) return [];
      if (this.selected?.status === 'pending') return ['completed'];
      if (this.selected?.status === 'completed') return ['pending'];
      return [];
    },
    setDateFilter(mode) {
      this.dateMode = mode;
      const now = new Date();
      if (mode === 'today') {
        this.dateFrom = now.toISOString().slice(0, 10);
        this.dateTo = now.toISOString().slice(0, 10);
      } else if (mode === 'month') {
        this.dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        this.dateTo = now.toISOString().slice(0, 10);
      } else {
        this.dateFrom = '';
        this.dateTo = '';
      }
      this.loadBoard();
    },
    async loadSalesmen() {
      try {
        const users = await VISET.api('users');
        this.salesmen = users.filter(u => u.role === 'salesman');
      } catch (e) { console.warn(e); }
    },
    async loadBoard() {
      try {
        const params = new URLSearchParams();
        if (this.selectedTask) params.set('visit_task', this.selectedTask);
        if (this.searchQuery) params.set('q', this.searchQuery);
        if (this.selectedSalesman) params.set('author_id', this.selectedSalesman);
        if (this.dateFrom) params.set('date_from', this.dateFrom);
        if (this.dateTo) params.set('date_to', this.dateTo);
        const qs = params.toString();
        const r = await fetch(`${VISET.API_BASE}/workflow/board${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${VISET.token}` } });
        if (r.ok) {
          this.board = await r.json();
          for (const col of Object.values(this.board.columns || {})) {
            for (const v of col) {
              if (v.sub_tasks && v.sub_tasks.length) v._showSubs = false;
            }
          }
        }
      } catch (e) { console.warn(e); }
    },
    clearFilter() {
      this.selectedTask = '';
      this.searchQuery = '';
      this.selectedSalesman = '';
      this.setDateFilter('all');
    },
    async openDetail(v) {
      this.selected = v;
      this.log = [];
      this.selectedDocs = [];
      this.transitionNote = '';
      this.showBranchForm = false;
      this.branchMsg = '';
      this.showModal = true;
      try {
        const [logR, docsR] = await Promise.all([
          fetch(`${VISET.API_BASE}/workflow/log/${v.id}`, { headers: { Authorization: `Bearer ${VISET.token}` } }),
          fetch(`${VISET.API_BASE}/documents/${v.id}`, { headers: { Authorization: `Bearer ${VISET.token}` } }),
        ]);
        if (logR.ok) this.log = await logR.json();
        if (docsR.ok) this.selectedDocs = await docsR.json();
      } catch (e) { console.warn(e); }
    },
    async transitionTo(status) {
      if (!this.selected) return;
      try {
        const r = await fetch(`${VISET.API_BASE}/workflow/transition`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ visit_id: this.selected.id, to_status: status, note: this.transitionNote }),
        });
        const d = await r.json();
        if (r.ok) {
          this.selected = d.visit;
          this.transitionNote = '';
          this.loadBoard();
          const r2 = await fetch(`${VISET.API_BASE}/workflow/log/${this.selected.id}`, { headers: { Authorization: `Bearer ${VISET.token}` } });
          if (r2.ok) this.log = await r2.json();
        } else {
          alert(d.error || 'Transition failed');
        }
      } catch (e) { console.warn(e); }
    },
    async markSuccess(val) {
      if (!this.selected) return;
      try {
        const r = await fetch(`${VISET.API_BASE}/workflow/success`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${VISET.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ visit_id: this.selected.id, is_success: val }),
        });
        const d = await r.json();
        if (r.ok) {
          this.selected = d.visit;
          this.loadBoard();
        } else {
          alert(d.error || 'Failed');
        }
      } catch (e) { console.warn(e); }
    },
    isImageDoc(doc) {
      if (!doc) return false;
      const ext = (doc.original_name || doc.file_url || '').split('.').pop().toLowerCase();
      if (['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) return true;
      if (doc.file_url && doc.file_url.includes('/image/upload/')) return true;
      if (doc.file_type && doc.file_type.startsWith('image/')) return true;
      return false;
    },
  }));

  Alpine.data('reportManager', () => ({
    _ready: false,
    s: { total_visits: 0, pending: 0, approved: 0, flagged: 0, salesmen: [] },
    init() { this._ready = VISET._permReady; if (!VISET._permReady) VISET.ready.then(() => { this._ready = true; if (!VISET.can('reports.view')) window.location.href = '/'; }); else if (!VISET.can('reports.view')) window.location.href = '/'; this.load(); },
    async load() { try { this.s = await VISET.api('reports/summary'); } catch (e) { console.warn(e); } },
  }));
});
