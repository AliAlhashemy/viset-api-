function ticketFlows() {
  return {
    production: {
      label: VISET.__('flow.production'),
      color: '#6366f1',
      statuses: [
        { key: 'production', color: '#6366f1' },
        { key: 'create', color: '#3b82f6' },
        { key: 'report_finish', color: '#d97706' },
        { key: 'transfer_warehouse', color: '#f97316' },
        { key: 'received', color: '#059669' },
        { key: 'ended', color: '#6b7280' },
      ],
      transitions: {
        production: ['create'],
        create: ['report_finish'],
        report_finish: ['transfer_warehouse'],
        transfer_warehouse: ['received'],
        received: ['ended'],
      },
      approvals: {
        production: { role: 'manager', user: null },
        create: { role: 'supervisor', user: null },
        report_finish: { role: 'accountant', user: null },
        transfer_warehouse: { role: 'manager', user: null },
      }
    },
    purchase: {
      label: VISET.__('flow.purchase'),
      color: '#0891b2',
      statuses: [
        { key: 'purchase_request', color: '#0891b2' },
        { key: 'payment_request', color: '#7c3aed' },
        { key: 'approved', color: '#059669' },
      ],
      transitions: {
        purchase_request: ['payment_request'],
        payment_request: ['approved'],
      },
      approvals: {
        payment_request: { role: 'admin', user: null },
      }
    },
    outside_orders: {
      label: VISET.__('flow.outside_orders'),
      color: '#dc2626',
      statuses: [
        { key: 'order_placed', color: '#dc2626' },
        { key: 'in_progress', color: '#d97706' },
        { key: 'shipped', color: '#f97316' },
        { key: 'delivered', color: '#059669' },
        { key: 'completed', color: '#6b7280' },
      ],
      transitions: {
        order_placed: ['in_progress'],
        in_progress: ['shipped'],
        shipped: ['delivered'],
        delivered: ['completed'],
      },
      approvals: {
        order_placed: { role: 'manager', user: null },
        in_progress: { role: 'supervisor', user: null },
        shipped: { role: 'manager', user: null },
      }
    }
  };
}

function ticketStatusInfo() {
  const flows = ticketFlows();
  const all = [];
  for (const f of Object.values(flows)) {
    for (const s of f.statuses) {
      if (!all.find(a => a.key === s.key)) {
        all.push({ key: s.key, label: VISET.__('status.' + s.key), color: s.color });
      }
    }
  }
  return all;
}

function ticketPriorityInfo() {
  return {
    urgent: { label: VISET.__('priority.urgent'), color: '#ef4444' },
    high: { label: VISET.__('priority.high'), color: '#f97316' },
    medium: { label: VISET.__('priority.medium'), color: '#3b82f6' },
    low: { label: VISET.__('priority.low'), color: '#9ca3af' },
  };
}

function buildEmptyColumns() {
  const cols = {};
  for (const s of ticketStatusInfo()) cols[s.key] = [];
  return cols;
}

function ticketBoardComponent() {
  return {
    _ready: false,
    board: { columns: buildEmptyColumns() },
    selectedStatus: '',
    selectedPriority: '',
    selectedAssignee: '',
    selectedFlow: 'production',
    searchQuery: '',
    users: [],
    usersLookup: {},
    showModal: false,
    selected: null,
    log: [],
    showCreate: false,
    createForm: { title: '', description: '', flow: 'production', priority: 'medium', assigned_to: '', visit_id: '', customer_name: '' },
    visits: [],
    role: '',
    userName: '',
    dateFrom: '',
    dateTo: '',
    nodes: [],
    newNodeTitle: '',
    savingNode: false,
    nodeMsg: '',
    nodeMsgType: '',
    pendingApprovals: [],
    approvalCount: 0,
    purchaseData: { items: [{ item_number: '', name: '', qty: 1, price: 0 }], vendor_type: 'local', po_number: '', posting_date: '', payment_file_url: '', payment_file_name: '', vat_rate: 15 },
    uploadProgress: false,

    get flows() { return ticketFlows(); },
    get statusInfo() { return ticketStatusInfo(); },
    get priorityInfo() { return ticketPriorityInfo(); },

    get ticketList() {
      const all = [];
      for (const col of Object.values(this.board.columns)) {
        for (const t of col) all.push(t);
      }
      return all;
    },

    get flowList() {
      return Object.entries(this.flows).map(([k, v]) => ({ key: k, label: v.label, color: v.color }));
    },

    activeFlowKeys() {
      if (this.selectedFlow) return [this.selectedFlow];
      return Object.keys(this.flows);
    },

    flowStatuses(flowKey) {
      const f = this.flows[flowKey];
      return f ? f.statuses.map(s => ({ key: s.key, label: VISET.__('status.' + s.key), color: s.color })) : [];
    },

    flowLabel(key) {
      if (!key) return this.flows['production']?.label || 'Production';
      return this.flows[key]?.label || key;
    },

    progressColor(pct) {
      if (pct >= 100) return '#059669';
      if (pct >= 50) return '#6366f1';
      if (pct >= 20) return '#d97706';
      return '#ef4444';
    },

    async init() {
      this._ready = VISET._permReady;
      if (!VISET._permReady) await VISET.ready;
      this._ready = true;
      if (!VISET.user) { window.location.href = '/'; return; }
      this.role = VISET.user.role;
      this.userName = VISET.user.display_name || VISET.user.username || '';
      this.loadTickets();
      this.loadUsers();
      this.loadVisits();
      this.loadPendingApprovals();
    },

    async loadTickets() {
      try {
        const params = new URLSearchParams();
        if (this.selectedFlow) params.set('flow', this.selectedFlow);
        if (this.selectedStatus) params.set('status', this.selectedStatus);
        if (this.selectedPriority) params.set('priority', this.selectedPriority);
        if (this.selectedAssignee) params.set('assigned_to', this.selectedAssignee);
        if (this.searchQuery) params.set('q', this.searchQuery);
        if (this.dateFrom) params.set('date_from', this.dateFrom);
        if (this.dateTo) params.set('date_to', this.dateTo);
        const qs = params.toString();
        const data = await VISET.api(`tickets${qs ? '?' + qs : ''}`);
        const cols = buildEmptyColumns();
        data.forEach(t => {
          if (t.status === 'production_ticket') t.status = 'production';
          let colKey = t.status;
          if (t.status === 'awaiting_approval') {
            const approval = this.pendingApprovals.find(a => Number(a.ticket_id) === t.id);
            colKey = approval?.from_status || 'production';
          }
          const s = cols[colKey] ? colKey : 'production';
          cols[s].push(t);
        });
        this.board.columns = cols;
        this.loadPendingApprovals();
      } catch (e) { console.warn(e); }
    },

    async loadUsers() {
      if (!['admin', 'manager'].includes(VISET.user?.role)) return;
      try {
        this.users = await VISET.api('users');
        this.usersLookup = {};
        this.users.forEach(u => { this.usersLookup[u.id] = u; });
      } catch (e) { console.warn(e); }
    },

    async loadVisits() {
      try {
        this.visits = await VISET.api('visits?limit=100');
      } catch (e) { console.warn(e); }
    },

    async openDetail(t) {
      try {
        const r = await VISET.api(`tickets/${t.id}`);
        if (r.ticket.status === 'production_ticket') r.ticket.status = 'production';
        this.selected = r.ticket;
        this.transitionError = '';
        this.log = r.log;
        this.loadPendingApprovals();
        try { this.purchaseData = JSON.parse(r.ticket.purchase_data || '{}'); } catch { this.purchaseData = {}; }
        if (!this.purchaseData.items) this.purchaseData.items = [{ item_number: '', name: '', qty: 1, price: 0 }];
        this.purchaseData.items.forEach(i => { if (i.name === undefined) i.name = ''; if (i.price === undefined) i.price = 0; });
        if (!this.purchaseData.vendor_type) this.purchaseData.vendor_type = 'local';
        if (!this.purchaseData.vat_rate && this.purchaseData.vat_rate !== 0) this.purchaseData.vat_rate = 15;
        if (!this.purchaseData.po_number) this.purchaseData.po_number = '';
        if (!this.purchaseData.posting_date) this.purchaseData.posting_date = '';
        if (!this.purchaseData.payment_file_url) this.purchaseData.payment_file_url = '';
        if (!this.purchaseData.payment_file_name) this.purchaseData.payment_file_name = '';
        this.nodes = [];
        this.newNodeTitle = '';
        this.nodeMsg = '';
        this.showModal = true;
        this.loadNodes();
      } catch (e) { console.warn(e); }
    },

    async loadNodes() {
      if (!this.selected) return;
      try {
        this.nodes = await VISET.api(`tickets/${this.selected.id}/nodes`);
      } catch (e) { console.warn(e); }
    },

    closeDetail() {
      this.showModal = false;
      this.selected = null;
      this.log = [];
      this.nodes = [];
    },

    getPriorityStyle(p) {
      const pi = ticketPriorityInfo();
      const info = pi[p] || pi.medium;
      return { background: info.color + '18', color: info.color };
    },

    get autoProgress() {
      if (!this.nodes.length) return 0;
      const done = this.nodes.filter(n => n.is_done).length;
      return Math.round((done / this.nodes.length) * 100);
    },

    flowProgressFor(status, flowKey) {
      if (status === 'awaiting_approval') return 0;
      const f = this.flows[flowKey || 'production'];
      if (!f) return 0;
      const idx = f.statuses.findIndex(s => s.key === status);
      if (idx === -1) return 0;
      return Math.round((idx / (f.statuses.length - 1)) * 100);
    },

    get flowProgress() {
      if (!this.selected) return 0;
      return this.flowProgressFor(this.selected.status, this.selected.flow);
    },

    flowProgressForFlow(flowKey) {
      return this.flowProgressFor(this.selected?.status, flowKey);
    },

    async toggleNode(node) {
      try {
        const updated = await VISET.api(`tickets/${this.selected.id}/nodes/${node.id}`, {
          method: 'PUT', headers: VISET.headers(), body: JSON.stringify({ is_done: node.is_done ? 0 : 1 })
        });
        Object.assign(node, updated);
        this.selected.nodes_total = this.nodes.length;
        this.selected.nodes_done = this.nodes.filter(n => n.is_done).length;
        this.selected.progress = this.autoProgress;
        this.loadTickets();
      } catch (e) { console.warn(e); }
    },

    async addNode() {
      if (!this.newNodeTitle.trim()) return;
      this.savingNode = true; this.nodeMsg = '';
      try {
        const newNode = await VISET.api(`tickets/${this.selected.id}/nodes`, {
          method: 'POST', headers: VISET.headers(), body: JSON.stringify({ title: this.newNodeTitle })
        });
        this.nodes.push(newNode);
        this.newNodeTitle = '';
        this.selected.nodes_total = this.nodes.length;
        this.selected.progress = this.autoProgress;
        this.loadTickets();
      } catch (e) {
        this.nodeMsg = e.message || 'Failed';
        this.nodeMsgType = 'error';
      }
      this.savingNode = false;
    },

    async deleteNode(node) {
      try {
        await VISET.api(`tickets/${this.selected.id}/nodes/${node.id}`, { method: 'DELETE' });
        this.nodes = this.nodes.filter(n => n.id !== node.id);
        this.selected.nodes_total = this.nodes.length;
        this.selected.nodes_done = this.nodes.filter(n => n.is_done).length;
        this.selected.progress = this.autoProgress;
        this.loadTickets();
      } catch (e) { console.warn(e); }
    },

    async transitionTo(status) {
      this.transitionError = '';
      try {
        const note = this.transitionNote || '';
        const body = { status, note, assigned_to: this.selected.assigned_to };
        const updated = await VISET.api(`tickets/${this.selected.id}`, {
          method: 'PUT', headers: VISET.headers(), body: JSON.stringify(body)
        });
        this.selected = updated;
        this.transitionNote = '';
        this.loadTickets();
        await this.loadPendingApprovals();
        const r = await VISET.api(`tickets/${this.selected.id}`);
        this.log = r.log;
        if (r.ticket) this.selected.status = r.ticket.status;
      } catch (e) {
        this.transitionError = e.message || 'You are not authorized';
      }
    },

    async loadPendingApprovals() {
      try {
        const data = await VISET.api('tickets/approvals');
        this.pendingApprovals = data;
        this.approvalCount = data.length;
      } catch (e) { console.warn(e); }
    },

    canApprove() {
      if (!this.selected) return false;
      const flowKey = this.selected.flow || 'production';
      const f = this.flows[flowKey];
      if (!f) return false;
      const curStatus = this.selected.status;
      if (curStatus !== 'awaiting_approval') return false;
      const pending = this.pendingApprovals.find(a => Number(a.ticket_id) === this.selected.id);
      if (!pending) return false;
      if (['admin','manager'].includes(VISET.user?.role)) return true;
      if (pending.assigned_user && Number(pending.assigned_user) === VISET.user?.id) return true;
      if (!pending.assigned_user && pending.assigned_role === VISET.user?.role) return true;
      return false;
    },

    async approve(status) {
      this.transitionError = '';
      try {
        const body = { note: this.transitionNote || '' };
        await VISET.api(`tickets/${this.selected.id}/approve`, {
          method: 'POST', headers: VISET.headers(), body: JSON.stringify(body)
        });
        this.transitionNote = '';
        this.loadTickets();
        this.loadPendingApprovals();
        const r = await VISET.api(`tickets/${this.selected.id}`);
        this.log = r.log;
        this.selected = r.ticket;
      } catch (e) { this.transitionError = e.message || 'Failed to approve'; }
    },

    async reject() {
      this.transitionError = '';
      try {
        const body = { note: this.transitionNote || '' };
        await VISET.api(`tickets/${this.selected.id}/reject`, {
          method: 'POST', headers: VISET.headers(), body: JSON.stringify(body)
        });
        this.transitionNote = '';
        this.loadTickets();
        this.loadPendingApprovals();
        const r = await VISET.api(`tickets/${this.selected.id}`);
        this.log = r.log;
        this.selected = r.ticket;
      } catch (e) { this.transitionError = e.message || 'Failed to reject'; }
    },

    transitionNote: '',
    transitionError: '',

    get allowedTransitions() {
      if (!this.selected) return [];
      const flowKey = this.selected.flow || 'production';
      const f = this.flows[flowKey];
      if (!f) return [];
      const curStatus = this.selected.status === 'production_ticket' ? 'production' : this.selected.status;
      if (curStatus === 'awaiting_approval') return [];
      const t = f.transitions[curStatus];
      if (!t) return [];
      const hasApprovals = Object.keys(f.approvals || {}).length > 0;
      if (!hasApprovals) return t;
      const approvalCfg = f.approvals?.[curStatus];
      if (approvalCfg) return t;
      return ['admin','manager'].includes(VISET.user?.role) ? t : [];
    },

    canAssign() {
      return ['admin', 'manager'].includes(VISET.user?.role);
    },

    async openCreate() {
      this.showCreate = true;
      this.createForm = { title: '', description: '', flow: 'production', priority: 'medium', assigned_to: '', visit_id: '', customer_name: '' };
    },

    async setFlow(flow) {
      this.selectedFlow = flow;
      this.loadTickets();
    },

    updateCustomerName() {
      const v = this.visits.find(x => String(x.id) === String(this.createForm.visit_id));
      if (v) this.createForm.customer_name = v.customer_name || '';
    },

    async submitCreate() {
      if (!this.createForm.title.trim()) return alert('Title is required');
      try {
        const body = {
          title: this.createForm.title,
          description: this.createForm.description,
          flow: this.createForm.flow,
          priority: this.createForm.priority,
          assigned_to: this.createForm.assigned_to || null,
          visit_id: this.createForm.visit_id || null,
          customer_name: this.createForm.customer_name || '',
        };
        await VISET.api('tickets', { method: 'POST', headers: VISET.headers(), body: JSON.stringify(body) });
        this.showCreate = false;
        this.loadTickets();
      } catch (e) { alert(e.message); }
    },

    async deleteTicket(t) {
      if (!confirm('Delete this ticket?')) return;
      try {
        await VISET.api(`tickets/${t.id}`, { method: 'DELETE' });
        this.closeDetail();
        this.loadTickets();
      } catch (e) { console.warn(e); }
    },

    canDelete() {
      return ['admin', 'manager'].includes(VISET.user?.role);
    },

    isPurchaseFlow() {
      return this.selected?.flow === 'purchase';
    },

    isPurchaseStatus(st) {
      return this.isPurchaseFlow() && this.selected?.status === st;
    },

    async savePurchaseData() {
      try {
        const body = { purchase_data: this.purchaseData };
        const updated = await VISET.api(`tickets/${this.selected.id}`, {
          method: 'PUT', headers: VISET.headers(), body: JSON.stringify(body)
        });
        this.selected.purchase_data = JSON.stringify(this.purchaseData);
      } catch (e) { this.transitionError = e.message || 'Failed to save'; }
    },

    addItem() {
      this.purchaseData.items.push({ item_number: '', name: '', qty: 1, price: 0 });
    },

    removeItem(idx) {
      if (this.purchaseData.items.length > 1) this.purchaseData.items.splice(idx, 1);
    },

    get purchaseSummary() {
      const items = this.purchaseData.items || [];
      const vatRate = (this.purchaseData.vat_rate || 0) / 100;
      const lines = items.map(i => {
        const qty = Number(i.qty) || 0;
        const price = Number(i.price) || 0;
        const lineTotal = qty * price;
        const lineVat = lineTotal * vatRate;
        return { ...i, qty, price, lineTotal, lineVat, lineTotalWithVat: lineTotal + lineVat };
      });
      const netTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const totalVat = lines.reduce((s, l) => s + l.lineVat, 0);
      return { lines, netTotal, totalVat, grandTotal: netTotal + totalVat, vatRate: this.purchaseData.vat_rate || 0 };
    },

    async handlePaymentFileSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      this.uploadProgress = true;
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`${VISET.API_BASE}/upload/document`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${VISET.token}` },
          body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        this.purchaseData.payment_file_url = data.url;
        this.purchaseData.payment_file_name = data.original_name || data.filename;
        this.transitionError = '';
      } catch (e) { this.transitionError = e.message || 'Upload failed'; }
      this.uploadProgress = false;
      e.target.value = '';
    },

    async requestReversal() {
      if (!confirm('Request admin reversal for this step?')) return;
      try {
        await VISET.api(`tickets/${this.selected.id}/request-reversal`, {
          method: 'POST', headers: VISET.headers(), body: JSON.stringify({ note: this.transitionNote || '' })
        });
        this.transitionNote = '';
        this.loadPendingApprovals();
        this.transitionError = '';
        this.transitionError = 'Reversal requested — waiting for admin approval';
      } catch (e) { this.transitionError = e.message || 'Failed'; }
    },

    async removePaymentFile() {
      this.purchaseData.payment_file_url = '';
      this.purchaseData.payment_file_name = '';
      await this.savePurchaseData();
    },

    async purchaseSubmit() {
      const st = this.selected?.status;
      let next;
      if (st === 'purchase_request') {
        const emptyNum = this.purchaseData.items.some(i => !i.item_number?.trim());
        if (emptyNum) { this.transitionError = 'Please fill in all item numbers'; return; }
        const emptyName = this.purchaseData.items.some(i => !i.name?.trim());
        if (emptyName) { this.transitionError = 'Please fill in all item names'; return; }
        const zeroPrice = this.purchaseData.items.some(i => !(Number(i.price) > 0));
        if (zeroPrice) { this.transitionError = 'Please enter a price for all items'; return; }
        if (!this.purchaseData.vendor_type) { this.transitionError = 'Please select vendor type'; return; }
        next = 'payment_request';
      } else if (st === 'payment_request') {
        next = 'approved';
      }
      if (!next) return;
      this.transitionError = '';
      try {
        const note = this.transitionNote || '';
        const body = { status: next, note, purchase_data: this.purchaseData, assigned_to: this.selected.assigned_to };
        const updated = await VISET.api(`tickets/${this.selected.id}`, {
          method: 'PUT', headers: VISET.headers(), body: JSON.stringify(body)
        });
        this.selected.purchase_data = JSON.stringify(this.purchaseData);
        this.selected = updated;
        this.transitionNote = '';
        this.loadTickets();
        await this.loadPendingApprovals();
        const r = await VISET.api(`tickets/${this.selected.id}`);
        this.log = r.log;
        if (r.ticket) this.selected.status = r.ticket.status;
      } catch (e) {
        this.transitionError = e.message || 'You are not authorized';
      }
    },

    downloadSummary() {
      if (!this.selected) return;
      const lines = this.purchaseSummary.lines;
      const vatRate = this.purchaseSummary.vat_rate || 0;
      let text = '';
      text += '========================================\n';
      text += '   PURCHASE TICKET SUMMARY\n';
      text += '========================================\n\n';
      text += `Ticket #: ${this.selected.id}\n`;
      text += `Title: ${this.selected.title}\n`;
      text += `Flow: ${this.flowLabel(this.selected.flow)}\n`;
      text += `Priority: ${this.priorityInfo[this.selected.priority]?.label || this.selected.priority}\n`;
      text += `Customer: ${this.selected.customer_name || this.selected.visit_customer_name || '—'}\n`;
      text += `Created: ${new Date(this.selected.created_at).toLocaleString()}\n`;
      text += `Status: Closed\n\n`;

      text += '--- Items ---\n';
      text += `${'Item #'.padEnd(12)} ${'Name'.padEnd(25)} ${'Qty'.padEnd(6)} ${'Price'.padEnd(10)} ${'Line Total'.padEnd(12)} ${'VAT'.padEnd(10)} ${'Total'.padEnd(12)}\n`;
      text += `${''.padEnd(12, '-')} ${''.padEnd(25, '-')} ${''.padEnd(6, '-')} ${''.padEnd(10, '-')} ${''.padEnd(12, '-')} ${''.padEnd(10, '-')} ${''.padEnd(12, '-')}\n`;
      for (const l of lines) {
        text += `${l.item_number.padEnd(12)} ${l.name.padEnd(25)} ${String(l.qty).padEnd(6)} ${Number(l.price).toFixed(3).padEnd(10)} ${Number(l.lineTotal).toFixed(3).padEnd(12)} ${Number(l.lineVat).toFixed(3).padEnd(10)} ${Number(l.lineTotalWithVat).toFixed(3).padEnd(12)}\n`;
      }
      text += `${''.padEnd(12, '-')} ${''.padEnd(25, '-')} ${''.padEnd(6, '-')} ${''.padEnd(10, '-')} ${''.padEnd(12, '-')} ${''.padEnd(10, '-')} ${''.padEnd(12, '-')}\n`;
      text += `${'Totals:'.padEnd(55)} ${Number(this.purchaseSummary.netTotal).toFixed(3).padEnd(12)} ${Number(this.purchaseSummary.totalVat).toFixed(3).padEnd(10)} ${Number(this.purchaseSummary.grandTotal).toFixed(3).padEnd(12)}\n`;
      text += `\nVAT Rate: ${vatRate}%\n`;
      text += `Net Total (excl. VAT): ${Number(this.purchaseSummary.netTotal).toFixed(3)}\n`;
      text += `Total VAT: ${Number(this.purchaseSummary.totalVat).toFixed(3)}\n`;
      text += `Grand Total (incl. VAT): ${Number(this.purchaseSummary.grandTotal).toFixed(3)}\n\n`;

      text += '--- Approval Log ---\n';
      if (this.log.length) {
        for (const entry of this.log) {
          const date = new Date(entry.created_at).toLocaleString();
          text += `[${date}] ${entry.action || entry.to_status} — ${entry.user_name}\n`;
          if (entry.note) text += `  Note: ${entry.note}\n`;
        }
      } else {
        text += '(No activity log)\n';
      }
      text += '\n========================================\n';
      text += '   END OF SUMMARY\n';
      text += '========================================\n';

      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `purchase-ticket-${this.selected.id}-summary.txt`;
      a.click();
      URL.revokeObjectURL(url);
    },

    clearFilters() {
      this.selectedStatus = '';
      this.selectedPriority = '';
      this.selectedAssignee = '';
      this.searchQuery = '';
      this.dateFrom = '';
      this.dateTo = '';
      this.loadTickets();
    },
  };
}