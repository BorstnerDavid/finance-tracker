// ═══════════════════════════════════════════════════════════
// Ledger — personal finance app (Firebase Hosting + Auth + Firestore)
// ═══════════════════════════════════════════════════════════
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, writeBatch, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, 'europe-west1');

// ─── Default categories (seeded from the 2026 Excel) ────────
const DEFAULT_CATEGORIES = {
  expense: {
    'Everyday': ['Hrana - trgovina', 'Hrana - malca v službi', 'Hrana - restavracije & dostava', 'Frizer, self care', 'Clothes', 'Cvetko', 'Other'],
    'Entertainment': ['Books', 'Going out', 'Games', 'Hobbies', 'Outdoor activities', 'Koncerti', 'Sports', 'Subscriptions', 'Other'],
    'Investment': ['ETF/Equity/Bond', 'Other'],
    'Gifts': ['Gifts', 'Other'],
    'Health': ['Doctors/dental/vision', 'Pharmacy', 'Emergency', 'Other'],
    'Home': ['Utilities', 'Ikea', 'Ostalo'],
    'Transportation': ['Bencin', 'Parking', 'Javni prevoz', 'Kolo', 'Other'],
    'Travel': ['Airfare', 'Hotels', 'Food', 'Transportation', 'Entertainment', 'Other'],
  },
  income: {
    'Paycheck': ['Paycheck', 'Bonus'],
    'Other': ['Dividends', 'Gifts', 'Dohodnina', 'Other'],
  },
};

const CAT_COLORS = ['#2F5D50', '#C98A2D', '#B0492F', '#5B7FA6', '#8A6FA8', '#6E8B5E', '#C2607E', '#7A6A55', '#4A8B8B', '#A8842F'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── State ───────────────────────────────────────────────────
const S = {
  user: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth(),          // 0-based, for transactions view
  view: 'overview',
  transactions: [],                       // real entries for selected year
  recurring: [],                          // all recurring rules
  settings: { startingBalance: 0, currency: '€', categories: DEFAULT_CATEGORIES },
  investments: {},                        // { "1": {start, invested, pl}, ... } for selected year
  projects: [],                           // all projects (not year-scoped)
  projectExpenses: [],                    // all transactions with source:'project', across every year
  expandedProjects: new Set(),            // project ids currently expanded in the Projects tab (UI-only)
  checklistOpen: new Set(),               // project ids where the (optional) checklist section is revealed
  txFilter: { type: 'all', search: '' },
  unsub: { tx: null, rec: null, set: null, inv: null, bank: null, proj: null, projExp: null },
  bank: null,                             // { requisitionId, institutionName, ... } when connected
  editingTx: null,
  editingRec: null,
  editingProject: null,
  editingPexp: null,                      // { project, expense|null }
  loaded: { tx: false, rec: false, set: false, proj: false },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cents = (n) => Math.round(Number(n) * 100);
const sum = (arr) => arr.reduce((a, b) => a + cents(b.amount), 0) / 100;

function fmt(n, withSign = false) {
  const v = Number(n) || 0;
  const s = new Intl.NumberFormat('sl-SI', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
  const sign = v < 0 ? '−' : withSign && v > 0 ? '+' : '';
  return `${sign}${s} ${S.settings.currency}`;
}
function fmt0(n) {
  const v = Number(n) || 0;
  return new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0 }).format(v);
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 2400);
}

// ─── Auth ────────────────────────────────────────────────────
let authMode = 'signin';

onAuthStateChanged(auth, (user) => {
  S.user = user;
  if (user) {
    $('auth-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    subscribeAll();
  } else {
    unsubscribeAll();
    $('app').classList.add('hidden');
    $('auth-screen').classList.remove('hidden');
  }
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('auth-email').value.trim();
  const pass = $('auth-password').value;
  const err = $('auth-error');
  err.classList.add('hidden');
  $('auth-submit').disabled = true;
  try {
    if (authMode === 'signin') await signInWithEmailAndPassword(auth, email, pass);
    else await createUserWithEmailAndPassword(auth, email, pass);
  } catch (ex) {
    err.textContent = friendlyAuthError(ex.code);
    err.classList.remove('hidden');
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('auth-switch-btn').addEventListener('click', () => {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  $('auth-submit').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
  $('auth-switch-text').textContent = authMode === 'signin' ? 'No account yet?' : 'Already have an account?';
  $('auth-switch-btn').textContent = authMode === 'signin' ? 'Create one' : 'Sign in';
  $('auth-password').autocomplete = authMode === 'signin' ? 'current-password' : 'new-password';
});

$('auth-forgot').addEventListener('click', async () => {
  const email = $('auth-email').value.trim();
  if (!email) { toast('Enter your email first'); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    toast('Password reset email sent');
  } catch (ex) {
    toast(friendlyAuthError(ex.code));
  }
});

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-email': 'That email address looks invalid.',
    'auth/too-many-requests': 'Too many attempts — try again in a minute.',
  };
  return map[code] || 'Something went wrong. Try again.';
}

// ─── Firestore subscriptions ─────────────────────────────────
function userCol(name) { return collection(db, 'users', S.user.uid, name); }
function userDoc(...path) { return doc(db, 'users', S.user.uid, ...path); }

function subscribeAll() {
  subscribeYearData();
  S.unsub.rec = onSnapshot(userCol('recurring'), (snap) => {
    S.recurring = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.loaded.rec = true;
    render();
  });
  S.unsub.set = onSnapshot(userDoc('meta', 'settings'), async (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      S.settings = {
        startingBalance: data.startingBalance ?? 0,
        currency: data.currency || '€',
        categories: data.categories || DEFAULT_CATEGORIES,
        merchantMap: data.merchantMap || {},
      };
    } else {
      await setDoc(userDoc('meta', 'settings'), {
        startingBalance: 0, currency: '€', categories: DEFAULT_CATEGORIES,
      });
    }
    S.loaded.set = true;
    render();
  });
  S.unsub.bank = onSnapshot(userDoc('meta', 'bank'), (snap) => {
    S.bank = snap.exists() ? snap.data() : null;
    if (S.view === 'settings') render();
  });
  S.unsub.proj = onSnapshot(userCol('projects'), (snap) => {
    S.projects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.loaded.proj = true;
    render();
  });
  S.unsub.projExp = onSnapshot(query(userCol('transactions'), where('source', '==', 'project')), (snap) => {
    S.projectExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

function subscribeYearData() {
  S.unsub.tx?.();
  S.unsub.inv?.();
  S.loaded.tx = false;
  const y = S.year;
  const q = query(userCol('transactions'),
    where('date', '>=', `${y}-01-01`), where('date', '<=', `${y}-12-31`));
  S.unsub.tx = onSnapshot(q, (snap) => {
    S.transactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.loaded.tx = true;
    render();
  });
  S.unsub.inv = onSnapshot(userDoc('investments', String(y)), (snap) => {
    S.investments = snap.exists() ? (snap.data().months || {}) : {};
    render();
  });
}

function unsubscribeAll() {
  Object.values(S.unsub).forEach((u) => u?.());
  S.unsub = { tx: null, rec: null, set: null, inv: null, bank: null, proj: null, projExp: null };
  S.transactions = []; S.recurring = []; S.investments = {}; S.bank = null;
  S.projects = []; S.projectExpenses = [];
  S.expandedProjects = new Set(); S.checklistOpen = new Set();
  S.loaded = { tx: false, rec: false, set: false, proj: false };
}

// ─── Recurring expansion ─────────────────────────────────────
// A rule: { name, type, amount, category, subcategory, day, startMonth:'YYYY-MM', endMonth:'YYYY-MM'|null }
// Expanded virtually into one entry per month between start and end (inclusive).
function ym(dateStr) { return dateStr.slice(0, 7); }

function ruleActiveIn(rule, y, m0) {
  const key = `${y}-${String(m0 + 1).padStart(2, '0')}`;
  if (key < rule.startMonth) return false;
  if (rule.endMonth && key > rule.endMonth) return false;
  return true;
}

function expandRecurring(year) {
  const out = [];
  for (const r of S.recurring) {
    for (let m = 0; m < 12; m++) {
      if (!ruleActiveIn(r, year, m)) continue;
      const key = `${year}-${String(m + 1).padStart(2, '0')}`;
      const ovr = r.overrides?.[key];
      if (ovr?.skip) continue;
      const lastDay = new Date(year, m + 1, 0).getDate();
      const day = Math.min(Number(ovr?.day ?? r.day) || 1, lastDay);
      out.push({
        id: `rec:${r.id}:${key}`,
        recurringId: r.id,
        monthKey: key,
        virtual: true,
        adjusted: !!ovr,
        type: r.type,
        amount: ovr?.amount ?? r.amount,
        category: r.category,
        subcategory: r.subcategory || '',
        note: r.name,
        date: `${key}-${String(day).padStart(2, '0')}`,
      });
    }
  }
  return out;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function allEntries() {
  const today = todayStr();
  return [...S.transactions, ...expandRecurring(S.year)]
    .filter((e) => e.type !== 'expense' || e.date <= today);
}

// ─── Aggregation helpers ─────────────────────────────────────
// Money moved into the "Investment" category is still yours — it's tracked in the
// Investments tab, so it shouldn't also reduce Expenses/Net savings. Kept informational
// (visible in Entries) but excluded from every expense sum.
function countsAsExpense(e) { return e.type === 'expense' && e.category !== 'Investment'; }

function monthlyTotals(entries, type) {
  const totals = Array(12).fill(0);
  for (const e of entries) {
    if (e.type !== type) continue;
    if (type === 'expense' && !countsAsExpense(e)) continue;
    totals[Number(e.date.slice(5, 7)) - 1] += cents(e.amount);
  }
  return totals.map((c) => c / 100);
}

function byCategory(entries, type) {
  const map = {};
  for (const e of entries) {
    if (e.type !== type) continue;
    if (type === 'expense' && !countsAsExpense(e)) continue;
    const cat = e.category || 'Other';
    if (!map[cat]) map[cat] = { total: 0, months: Array(12).fill(0), subs: {} };
    const m = Number(e.date.slice(5, 7)) - 1;
    map[cat].total += cents(e.amount);
    map[cat].months[m] += cents(e.amount);
    const sub = e.subcategory || '—';
    if (!map[cat].subs[sub]) map[cat].subs[sub] = { total: 0, months: Array(12).fill(0) };
    map[cat].subs[sub].total += cents(e.amount);
    map[cat].subs[sub].months[m] += cents(e.amount);
  }
  for (const c of Object.values(map)) {
    c.total /= 100;
    c.months = c.months.map((x) => x / 100);
    for (const s of Object.values(c.subs)) {
      s.total /= 100;
      s.months = s.months.map((x) => x / 100);
    }
  }
  return map;
}

function monthsElapsed() {
  const now = new Date();
  if (S.year < now.getFullYear()) return 12;
  if (S.year > now.getFullYear()) return 0;
  return now.getMonth() + 1;
}

// ─── Navigation ──────────────────────────────────────────────
function setView(v) {
  S.view = v;
  document.querySelectorAll('.tab, .tabbar-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((el) =>
    el.classList.toggle('hidden', el.id !== `view-${v}`));
  $('fab').classList.toggle('hidden', v === 'settings' || v === 'investments');
  render();
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('.tab, .tabbar-btn').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view)));

$('year-prev').addEventListener('click', () => { S.year--; $('year-label').textContent = S.year; subscribeYearData(); });
$('year-next').addEventListener('click', () => { S.year++; $('year-label').textContent = S.year; subscribeYearData(); });
$('year-label').textContent = S.year;

$('fab').addEventListener('click', () => {
  if (S.view === 'recurring') openRecModal();
  else if (S.view === 'projects') openProjectModal();
  else openTxModal();
});

// ─── Render root ─────────────────────────────────────────────
function render() {
  if (!S.user) return;
  if (!S.loaded.tx || !S.loaded.set || !S.loaded.rec || !S.loaded.proj) {
    $(`view-${S.view}`).innerHTML = '<div class="loading">Loading your book…</div>';
    return;
  }
  ({ overview: renderOverview,
     transactions: renderTransactions,
     recurring: renderRecurring,
     projects: renderProjects,
     investments: renderInvestments,
     settings: renderSettings })[S.view]();
}

// ═══════════════ OVERVIEW ═══════════════
function renderOverview() {
  const el = $('view-overview');
  const entries = allEntries();
  const inc = monthlyTotals(entries, 'income');
  const exp = monthlyTotals(entries, 'expense');
  const net = inc.map((v, i) => Math.round((v - exp[i]) * 100) / 100);
  const totInc = inc.reduce((a, b) => a + b, 0);
  const totExp = exp.reduce((a, b) => a + b, 0);
  const me = monthsElapsed() || 12;

  // Ending balance per month (like the Summary sheet)
  let bal = Number(S.settings.startingBalance) || 0;
  const ending = net.map((n) => (bal = Math.round((bal + n) * 100) / 100));

  const nowM = (S.year === new Date().getFullYear()) ? new Date().getMonth() : -1;
  const maxAbs = Math.max(...net.map(Math.abs), 1);

  const strip = MONTHS.map((m, i) => {
    const v = net[i];
    const h = Math.max(2, Math.round(Math.abs(v) / maxAbs * 26));
    const cls = v > 0 ? 'saved' : v < 0 ? 'spent' : 'empty';
    return `<div class="ys-cell ${cls} ${i === nowM ? 'now' : ''}" title="${m}: ${fmt(v, true)}">
      <div class="bar"><i style="height:${h}px"></i></div><div class="m">${m}</div></div>`;
  }).join('');

  const expCats = byCategory(entries, 'expense');

  el.innerHTML = `
    <h1>${S.year} at a glance</h1>
    <div class="year-strip">${strip}</div>

    <div class="stat-grid">
      <div class="card stat"><div class="lbl">Income</div><div class="val amber mono">${fmt(totInc)}</div><div class="sub mono">avg ${fmt0(totInc / me)} ${S.settings.currency}/mo</div></div>
      <div class="card stat"><div class="lbl">Expenses</div><div class="val mono">${fmt(totExp)}</div><div class="sub mono">avg ${fmt0(totExp / me)} ${S.settings.currency}/mo</div></div>
      <div class="card stat"><div class="lbl">Net savings</div><div class="val mono ${totInc - totExp >= 0 ? 'pos' : 'neg'}">${fmt(totInc - totExp, true)}</div><div class="sub">this year</div></div>
      <div class="card stat"><div class="lbl">Ending balance</div><div class="val mono">${fmt(ending[11])}</div><div class="sub mono">started at ${fmt0(S.settings.startingBalance)} ${S.settings.currency}</div></div>
    </div>

    <div class="section-title">Income vs expenses by month</div>
    <div class="chart-row">
      <div class="card chart-card">${barChart(inc, exp)}
        <div class="legend">
          <span class="li"><span class="sw" style="background:var(--amber)"></span>Income</span>
          <span class="li"><span class="sw" style="background:var(--pine)"></span>Expenses</span>
        </div>
      </div>
      <div class="card chart-card"><h3>Spending by category</h3>${donutChart(expCats)}</div>
    </div>

    <div class="section-title">Monthly summary</div>
    <div class="card table-wrap">${summaryTable(inc, exp, net, ending)}</div>

    <div class="section-title">Expenses by category</div>
    <div class="card table-wrap">${categoryTable(expCats, me)}</div>
  `;
}

function summaryTable(inc, exp, net, ending) {
  const row = (label, arr, cls = '', signed = false) => `<tr>
    <td>${label}</td>
    ${arr.map((v) => `<td class="${v === 0 ? 'dim' : ''} ${cls && v !== 0 ? (v > 0 ? 'pos' : 'neg') : ''}">${v === 0 && !signed ? '—' : fmt0(v)}</td>`).join('')}
    <td><b>${fmt0(arr.reduce((a, b) => a + b, 0))}</b></td></tr>`;
  return `<table class="ledger">
    <thead><tr><th></th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>
      ${row('Income', inc)}
      ${row('Expenses', exp)}
      ${row('Net savings', net, 'signed', true)}
      <tr class="total"><td>Ending balance</td>${ending.map((v) => `<td>${fmt0(v)}</td>`).join('')}<td></td></tr>
    </tbody></table>`;
}

function categoryTable(cats, monthsEl) {
  const names = Object.keys(cats).sort((a, b) => cats[b].total - cats[a].total);
  if (!names.length) return '<div class="empty">No expenses yet this year. Add your first entry with the + button.</div>';
  let html = `<table class="ledger"><thead><tr><th>Category</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Total</th><th>Avg/mo</th></tr></thead><tbody>`;
  let grand = Array(12).fill(0);
  for (const n of names) {
    const c = cats[n];
    c.months.forEach((v, i) => grand[i] += v);
    html += `<tr class="grp"><td>${esc(n)}</td>${c.months.map((v) => `<td class="mono ${v === 0 ? 'dim' : ''}">${v === 0 ? '—' : fmt0(v)}</td>`).join('')}<td class="mono"><b>${fmt0(c.total)}</b></td><td class="mono">${fmt0(c.total / monthsEl)}</td></tr>`;
    const subs = Object.entries(c.subs).sort((a, b) => b[1].total - a[1].total);
    for (const [sn, sv] of subs) {
      html += `<tr><td style="padding-left:24px" class="dim">${esc(sn)}</td>${sv.months.map((v) => `<td class="mono dim">${v === 0 ? '—' : fmt0(v)}</td>`).join('')}<td class="mono dim">${fmt0(sv.total)}</td><td></td></tr>`;
    }
  }
  html += `<tr class="total"><td>Total</td>${grand.map((v) => `<td>${fmt0(v)}</td>`).join('')}<td>${fmt0(grand.reduce((a, b) => a + b, 0))}</td><td>${fmt0(grand.reduce((a, b) => a + b, 0) / monthsEl)}</td></tr>`;
  return html + '</tbody></table>';
}

// ─── SVG charts (no dependencies) ────────────────────────────
function barChart(inc, exp) {
  const W = 640, H = 220, pad = { l: 8, r: 8, t: 12, b: 22 };
  const max = Math.max(...inc, ...exp, 1);
  const cw = (W - pad.l - pad.r) / 12;
  const bw = cw * 0.32;
  let bars = '';
  for (let i = 0; i < 12; i++) {
    const x = pad.l + i * cw;
    const hi = (inc[i] / max) * (H - pad.t - pad.b);
    const he = (exp[i] / max) * (H - pad.t - pad.b);
    bars += `<rect x="${x + cw / 2 - bw - 1}" y="${H - pad.b - hi}" width="${bw}" height="${Math.max(hi, 1)}" rx="2" fill="var(--amber)"><title>${MONTHS[i]} income: ${fmt(inc[i])}</title></rect>`;
    bars += `<rect x="${x + cw / 2 + 1}" y="${H - pad.b - he}" width="${bw}" height="${Math.max(he, 1)}" rx="2" fill="var(--pine)"><title>${MONTHS[i]} expenses: ${fmt(exp[i])}</title></rect>`;
    bars += `<text x="${x + cw / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--ink-soft)">${MONTHS[i]}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly income vs expenses">
    <line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" stroke="var(--rule)"/>${bars}</svg>`;
}

function donutChart(cats) {
  const names = Object.keys(cats).sort((a, b) => cats[b].total - cats[a].total);
  const total = names.reduce((a, n) => a + cats[n].total, 0);
  if (!total) return '<div class="empty">Nothing to chart yet.</div>';
  const R = 70, r = 44, cx = 90, cy = 90;
  let angle = -Math.PI / 2, paths = '', legend = '';
  names.forEach((n, i) => {
    const frac = Math.min(cats[n].total / total, 0.99999);
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (a, rad) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    const color = CAT_COLORS[i % CAT_COLORS.length];
    paths += `<path d="M${p(angle, R)} A${R},${R} 0 ${large} 1 ${p(a2, R)} L${p(a2, r)} A${r},${r} 0 ${large} 0 ${p(angle, r)} Z" fill="${color}"><title>${esc(n)}: ${fmt(cats[n].total)} (${Math.round(frac * 100)}%)</title></path>`;
    legend += `<span class="li"><span class="sw" style="background:${color}"></span>${esc(n)} · ${Math.round(frac * 100)}%</span>`;
    angle = a2;
  });
  return `<svg viewBox="0 0 180 180" role="img" aria-label="Spending by category" style="max-width:220px;margin:0 auto">${paths}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="13" font-weight="600" fill="var(--ink)" font-family="var(--font-mono)">${fmt0(total)}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9" fill="var(--ink-soft)">${S.settings.currency} total</text></svg>
    <div class="legend">${legend}</div>`;
}

// ═══════════════ TRANSACTIONS ═══════════════
function renderTransactions() {
  const el = $('view-transactions');
  const mKey = `${S.year}-${String(S.month + 1).padStart(2, '0')}`;
  let list = allEntries().filter((e) => ym(e.date) === mKey);
  if (S.txFilter.type !== 'all') list = list.filter((e) => e.type === S.txFilter.type);
  const q = S.txFilter.search.toLowerCase();
  if (q) list = list.filter((e) =>
    (e.note || '').toLowerCase().includes(q) ||
    (e.category || '').toLowerCase().includes(q) ||
    (e.subcategory || '').toLowerCase().includes(q));
  list.sort((a, b) => b.date.localeCompare(a.date));

  const totInc = sum(list.filter((e) => e.type === 'income'));
  const totExp = sum(list.filter(countsAsExpense));

  // group by date
  const groups = {};
  for (const e of list) (groups[e.date] ||= []).push(e);
  const days = Object.keys(groups).sort().reverse();

  const rows = days.map((d) => {
    const dt = new Date(d + 'T00:00:00');
    const head = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const items = groups[d].map((e) => `
      <button class="tx-row ${e.type}" data-txid="${esc(e.id)}" ${e.virtual ? `data-rec="${esc(e.recurringId)}"` : ''}>
        <span class="tx-dot">${e.type === 'income' ? '↑' : '↓'}</span>
        <span class="tx-main">
          <span class="tx-title">${esc(e.note || e.subcategory || e.category)}</span>
          <span class="tx-sub">${esc(e.category)}${e.subcategory ? ' · ' + esc(e.subcategory) : ''}</span>
        </span>
        ${e.virtual ? `<span class="badge ${e.adjusted ? 'adjusted' : ''}">⟳ ${e.adjusted ? 'adjusted' : 'recurring'}</span>` : ''}
        ${e.source === 'project' ? '<span class="badge">▣ project</span>' : ''}
        <span class="tx-amt">${e.type === 'income' ? '+' : '−'}${fmt(e.amount).replace('−', '')}</span>
      </button>`).join('');
    return `<div class="day-group"><div class="day-head">${head}</div>${items}</div>`;
  }).join('');

  el.innerHTML = `
    <h1>Entries</h1>
    <div class="tx-toolbar">
      <div class="month-nav">
        <button class="icon-btn" id="m-prev" aria-label="Previous month">‹</button>
        <span class="month-label">${new Date(S.year, S.month).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
        <button class="icon-btn" id="m-next" aria-label="Next month">›</button>
      </div>
      <label class="field"><select id="f-type">
        <option value="all" ${S.txFilter.type === 'all' ? 'selected' : ''}>All types</option>
        <option value="expense" ${S.txFilter.type === 'expense' ? 'selected' : ''}>Expenses</option>
        <option value="income" ${S.txFilter.type === 'income' ? 'selected' : ''}>Income</option>
      </select></label>
      <label class="field"><input type="search" id="f-search" placeholder="Search notes & categories" value="${esc(S.txFilter.search)}"></label>
    </div>
    <div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr">
      <div class="card stat"><div class="lbl">Income</div><div class="val amber mono">${fmt(totInc)}</div></div>
      <div class="card stat"><div class="lbl">Expenses</div><div class="val mono">${fmt(totExp)}</div></div>
      <div class="card stat"><div class="lbl">Net</div><div class="val mono ${totInc - totExp >= 0 ? 'pos' : 'neg'}">${fmt(totInc - totExp, true)}</div></div>
    </div>
    <div style="height:14px"></div>
    ${rows || '<div class="empty">No entries this month.<br>Tap + to add one, or set up a recurring expense.</div>'}
  `;

  $('m-prev').onclick = () => { S.month--; if (S.month < 0) { S.month = 11; S.year--; $('year-label').textContent = S.year; subscribeYearData(); } render(); };
  $('m-next').onclick = () => { S.month++; if (S.month > 11) { S.month = 0; S.year++; $('year-label').textContent = S.year; subscribeYearData(); } render(); };
  $('f-type').onchange = (e) => { S.txFilter.type = e.target.value; render(); };
  const si = $('f-search');
  si.oninput = (e) => { S.txFilter.search = e.target.value; render(); const el2 = $('f-search'); el2.focus(); el2.setSelectionRange(el2.value.length, el2.value.length); };
  el.querySelectorAll('.tx-row').forEach((b) => b.onclick = () => {
    if (b.dataset.rec) {
      const rule = S.recurring.find((r) => r.id === b.dataset.rec);
      const inst = allEntries().find((e) => e.id === b.dataset.txid);
      if (rule && inst) openOvrModal(rule, inst.monthKey);
    } else {
      const tx = S.transactions.find((t) => t.id === b.dataset.txid);
      if (!tx) return;
      if (tx.source === 'project') {
        const p = S.projects.find((pr) => pr.id === tx.projectId);
        if (p) openPexpModal(p, tx);
      } else openTxModal(tx);
    }
  });
}

// ═══════════════ RECURRING ═══════════════
function renderRecurring() {
  const el = $('view-recurring');
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rules = [...S.recurring].sort((a, b) => a.name.localeCompare(b.name));

  const rows = rules.map((r) => {
    let status = 'active', badge = '<span class="badge">Active</span>';
    if (r.startMonth > nowKey) { status = 'upcoming'; badge = '<span class="badge upcoming">Upcoming</span>'; }
    else if (r.endMonth && r.endMonth < nowKey) { status = 'ended'; badge = '<span class="badge ended">Ended</span>'; }
    const range = `${r.startMonth} → ${r.endMonth || 'ongoing'}`;
    const nOvr = Object.keys(r.overrides || {}).length;
    return `<button class="tx-row ${r.type}" data-recid="${esc(r.id)}">
      <span class="tx-dot">⟳</span>
      <span class="tx-main">
        <span class="tx-title">${esc(r.name)}</span>
        <span class="tx-sub">${esc(r.category)}${r.subcategory ? ' · ' + esc(r.subcategory) : ''} · day ${r.day} · ${range}${nOvr ? ` · ${nOvr} adjusted month${nOvr === 1 ? '' : 's'}` : ''}</span>
      </span>
      ${badge}
      <span class="tx-amt">${r.type === 'income' ? '+' : '−'}${fmt(r.amount).replace('−', '')}/mo</span>
    </button>`;
  }).join('');

  const activeExp = rules.filter((r) => r.type === 'expense' && r.startMonth <= nowKey && (!r.endMonth || r.endMonth >= nowKey));
  const thisMonthInstances = expandRecurring(now.getFullYear())
    .filter((e) => e.type === 'expense' && e.monthKey === nowKey);
  const monthlyLoad = sum(thisMonthInstances);

  el.innerHTML = `
    <h1>Recurring</h1>
    <div class="stat-grid" style="grid-template-columns:1fr 1fr">
      <div class="card stat"><div class="lbl">Active monthly expenses</div><div class="val mono">${fmt(monthlyLoad)}</div><div class="sub">${activeExp.length} rule${activeExp.length === 1 ? '' : 's'} this month</div></div>
      <div class="card stat"><div class="lbl">How it works</div><div class="sub" style="margin-top:6px">Each rule repeats monthly between its start and end month and appears automatically in Entries and Overview.</div></div>
    </div>
    <div style="height:14px"></div>
    ${rows || '<div class="empty">No recurring rules yet.<br>Add rent, subscriptions, salary — anything monthly.</div>'}
  `;
  el.querySelectorAll('.tx-row').forEach((b) => b.onclick = () => {
    const rule = S.recurring.find((r) => r.id === b.dataset.recid);
    if (rule) openRecModal(rule);
  });
}

// ═══════════════ PROJECTS ═══════════════
function projectExpensesFor(id) {
  return S.projectExpenses.filter((e) => e.projectId === id);
}

// A checklist item is { id, name, estimate, expenseId }. It's "checked" iff expenseId
// still resolves to a live expense — so deleting that expense from the Expenses list
// automatically shows the item as unchecked again, instead of drifting out of sync.
function clChecked(item) {
  return !!item.expenseId && S.projectExpenses.some((e) => e.id === item.expenseId);
}

async function toggleChecklistItem(project, itemId, checked) {
  const list = project.checklist || [];
  const idx = list.findIndex((i) => i.id === itemId);
  if (idx === -1) return;
  const item = list[idx];
  const next = [...list];
  if (checked) {
    const ref = await addDoc(userCol('transactions'), {
      type: 'expense',
      amount: Math.round((Number(item.estimate) || 0) * 100) / 100,
      date: todayStr(),
      category: 'Projects',
      subcategory: project.name,
      note: item.name,
      source: 'project',
      projectId: project.id,
    });
    next[idx] = { ...item, expenseId: ref.id };
  } else {
    if (item.expenseId) await deleteDoc(userDoc('transactions', item.expenseId)).catch(() => {});
    next[idx] = { ...item, expenseId: null };
  }
  await updateDoc(userDoc('projects', project.id), { checklist: next });
}

async function addChecklistItem(project, name, estimate) {
  const item = { id: genId(), name, estimate: Math.round((Number(estimate) || 0) * 100) / 100, expenseId: null };
  await updateDoc(userDoc('projects', project.id), { checklist: [...(project.checklist || []), item] });
}

async function deleteChecklistItem(project, itemId) {
  const item = (project.checklist || []).find((i) => i.id === itemId);
  if (!item) return;
  if (clChecked(item) && !confirm('This also deletes the expense it logged. Continue?')) return;
  if (item.expenseId) await deleteDoc(userDoc('transactions', item.expenseId)).catch(() => {});
  await updateDoc(userDoc('projects', project.id),
    { checklist: (project.checklist || []).filter((i) => i.id !== itemId) });
}

function renderProjects() {
  const el = $('view-projects');
  const projects = [...S.projects].sort((a, b) =>
    (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || a.name.localeCompare(b.name));
  const activeCount = projects.filter((p) => !p.archived).length;
  const totalAll = sum(S.projectExpenses);

  const rows = projects.map((p) => {
    const exps = projectExpensesFor(p.id).sort((a, b) => b.date.localeCompare(a.date));
    const spent = sum(exps);
    const pct = p.budget ? Math.min(100, Math.round((spent / p.budget) * 100)) : null;
    const over = p.budget && spent > p.budget;
    const expItems = exps.map((e) => `
      <button class="tx-row expense" data-pexpid="${esc(e.id)}" data-projid="${esc(p.id)}">
        <span class="tx-dot">↓</span>
        <span class="tx-main">
          <span class="tx-title">${esc(e.note || p.name)}</span>
          <span class="tx-sub">${esc(e.date)}</span>
        </span>
        <span class="tx-amt">−${fmt(e.amount).replace('−', '')}</span>
      </button>`).join('');

    const items = p.checklist || [];
    const clIsOpen = items.length > 0 || S.checklistOpen.has(p.id);
    const doneCount = items.filter(clChecked).length;
    const estTotal = items.reduce((a, i) => a + (Number(i.estimate) || 0), 0);
    const addRow = `<div class="settings-row cl-add-row">
      <input type="text" class="cl-name-input" data-projid="${esc(p.id)}" placeholder="Item name" maxlength="60">
      <input type="number" class="cl-est-input" data-projid="${esc(p.id)}" placeholder="Est. €" step="0.01" min="0">
      <button type="button" class="btn btn-sm" data-addcl="${esc(p.id)}">+ Add item</button>
    </div>`;
    const checklistBlock = clIsOpen ? `
      <div class="section-title" style="margin-top:0">Checklist <span class="hint" style="margin:0;text-transform:none;font-weight:400">(optional)</span></div>
      ${items.map((item) => {
        const checked = clChecked(item);
        return `<label class="cl-item">
          <input type="checkbox" data-clid="${esc(item.id)}" data-projid="${esc(p.id)}" ${checked ? 'checked' : ''}>
          <span class="cl-name ${checked ? 'done' : ''}">${esc(item.name)}</span>
          <span class="spacer"></span>
          <span class="mono cl-est">${fmt0(item.estimate)}</span>
          <button type="button" class="icon-btn" data-delcl="${esc(item.id)}" data-projid="${esc(p.id)}" aria-label="Remove ${esc(item.name)}">✕</button>
        </label>`;
      }).join('') || '<p class="hint" style="margin:0 0 8px">Add planned expenses with an estimate — checking one off logs it as a real expense below.</p>'}
      ${addRow}
      ${items.length ? `<p class="hint" style="margin:8px 0 0">${doneCount}/${items.length} checked · est. total ${fmt0(estTotal)} ${S.settings.currency}</p>` : ''}
    ` : `<button type="button" class="btn btn-sm" data-startcl="${esc(p.id)}">+ Add checklist (optional)</button>`;

    return `<div class="card project-card ${p.archived ? 'archived' : ''}">
      <div class="project-head" data-projtoggle="${esc(p.id)}">
        <span><b>${esc(p.name)}</b>${p.archived ? ' <span class="badge ended">Done</span>' : ''}</span>
        <div class="spacer"></div>
        <span class="mono">${fmt(spent)}${p.budget ? ` / ${fmt0(p.budget)} ${S.settings.currency}` : ''}</span>
      </div>
      ${p.budget ? `<div class="proj-bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>` : ''}
      ${p.note ? `<p class="hint" style="margin-top:8px">${esc(p.note)}</p>` : ''}
      <div class="proj-expenses ${S.expandedProjects.has(p.id) ? '' : 'hidden'}" id="proj-exp-${esc(p.id)}">
        ${checklistBlock}
        <div class="section-title">Expenses</div>
        ${expItems || '<div class="empty" style="padding:16px">No expenses logged yet.</div>'}
        <div class="modal-actions" style="flex-wrap:wrap">
          <button type="button" class="btn btn-sm" data-addexp="${esc(p.id)}">+ Add expense</button>
          <div class="spacer"></div>
          <button type="button" class="btn btn-sm" data-editproj="${esc(p.id)}">Edit</button>
          <button type="button" class="btn btn-sm" data-archproj="${esc(p.id)}">${p.archived ? 'Reopen' : 'Mark done'}</button>
        </div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <h1>Projects</h1>
    <div class="stat-grid" style="grid-template-columns:1fr 1fr">
      <div class="card stat"><div class="lbl">Active projects</div><div class="val mono">${activeCount}</div></div>
      <div class="card stat"><div class="lbl">Spent all-time</div><div class="val mono">${fmt(totalAll)}</div></div>
    </div>
    <div class="section-title">Your projects</div>
    <div class="card settings-row" style="margin-bottom:14px">
      <span class="hint" style="margin:0">Track a one-off big spend — a renovation, a trip, a wedding — broken into individual expenses. They also show up in Overview under “Projects”.</span>
      <div class="spacer"></div>
      <button type="button" class="btn btn-primary btn-sm" id="new-project">+ New project</button>
    </div>
    ${rows || '<div class="empty">No projects yet. Tap “+ New project” to start one.</div>'}
  `;

  $('new-project').onclick = () => openProjectModal();
  el.querySelectorAll('[data-projtoggle]').forEach((b) => b.onclick = () => {
    const id = b.dataset.projtoggle;
    if (S.expandedProjects.has(id)) S.expandedProjects.delete(id); else S.expandedProjects.add(id);
    $(`proj-exp-${id}`).classList.toggle('hidden');
  });
  el.querySelectorAll('[data-addexp]').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    const p = S.projects.find((pr) => pr.id === b.dataset.addexp);
    if (p) openPexpModal(p);
  });
  el.querySelectorAll('[data-editproj]').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    const p = S.projects.find((pr) => pr.id === b.dataset.editproj);
    if (p) openProjectModal(p);
  });
  el.querySelectorAll('[data-archproj]').forEach((b) => b.onclick = async (ev) => {
    ev.stopPropagation();
    const p = S.projects.find((pr) => pr.id === b.dataset.archproj);
    if (p) await updateDoc(userDoc('projects', p.id), { archived: !p.archived });
  });
  el.querySelectorAll('[data-pexpid]').forEach((b) => b.onclick = () => {
    const p = S.projects.find((pr) => pr.id === b.dataset.projid);
    const e = S.projectExpenses.find((x) => x.id === b.dataset.pexpid);
    if (p && e) openPexpModal(p, e);
  });
  el.querySelectorAll('[data-startcl]').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    S.checklistOpen.add(b.dataset.startcl);
    render();
  });
  el.querySelectorAll('[data-clid]').forEach((cb) => cb.onchange = async () => {
    const p = S.projects.find((pr) => pr.id === cb.dataset.projid);
    if (p) await toggleChecklistItem(p, cb.dataset.clid, cb.checked);
  });
  el.querySelectorAll('[data-delcl]').forEach((b) => b.onclick = async (ev) => {
    ev.stopPropagation();
    const p = S.projects.find((pr) => pr.id === b.dataset.projid);
    if (p) await deleteChecklistItem(p, b.dataset.delcl);
  });
  el.querySelectorAll('[data-addcl]').forEach((b) => b.onclick = async (ev) => {
    ev.stopPropagation();
    const p = S.projects.find((pr) => pr.id === b.dataset.addcl);
    if (!p) return;
    const nameInput = el.querySelector(`.cl-name-input[data-projid="${p.id}"]`);
    const estInput = el.querySelector(`.cl-est-input[data-projid="${p.id}"]`);
    const name = nameInput.value.trim();
    if (!name) { toast('Give the item a name'); return; }
    await addChecklistItem(p, name, estInput.value);
  });
}

// ═══════════════ INVESTMENTS ═══════════════
function renderInvestments() {
  const el = $('view-investments');
  const inv = S.investments;
  const get = (m, k) => Number(inv[String(m)]?.[k]) || 0;
  const totInvested = MONTHS.reduce((a, _, i) => a + get(i + 1, 'invested'), 0);
  const totPL = MONTHS.reduce((a, _, i) => a + get(i + 1, 'pl'), 0);

  const rows = MONTHS.map((m, i) => {
    const n = i + 1;
    return `<tr>
      <td>${m}</td>
      <td><input class="inv-in mono" data-m="${n}" data-k="start" type="number" step="0.01" value="${get(n, 'start') || ''}" placeholder="—"></td>
      <td><input class="inv-in mono" data-m="${n}" data-k="invested" type="number" step="0.01" value="${get(n, 'invested') || ''}" placeholder="—"></td>
      <td><input class="inv-in mono" data-m="${n}" data-k="pl" type="number" step="0.01" value="${get(n, 'pl') || ''}" placeholder="—"></td>
      <td class="mono">${fmt0(get(n, 'start') + get(n, 'invested') + get(n, 'pl'))}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <h1>Investments ${S.year}</h1>
    <div class="stat-grid" style="grid-template-columns:1fr 1fr">
      <div class="card stat"><div class="lbl">Invested this year</div><div class="val mono">${fmt(totInvested)}</div></div>
      <div class="card stat"><div class="lbl">Profit / loss</div><div class="val mono ${totPL >= 0 ? 'pos' : 'neg'}">${fmt(totPL, true)}</div></div>
    </div>
    <div class="section-title">Monthly tracker</div>
    <div class="card table-wrap">
      <table class="ledger">
        <thead><tr><th>Month</th><th>Starting balance</th><th>Invested</th><th>Profit / loss</th><th>End value</th></tr></thead>
        <tbody>${rows}
          <tr class="total"><td>Total</td><td></td><td>${fmt0(totInvested)}</td><td>${fmt0(totPL)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <p class="hint" style="margin-top:10px">Values save automatically when you leave a field. Tip: entries in the “Investment” category are informational only — they show up in Entries but don't count towards Overview spending or net savings.</p>
  `;

  el.querySelectorAll('.inv-in').forEach((input) => {
    input.style.cssText = 'width:110px;padding:6px 8px;border:1px solid var(--rule);border-radius:6px;text-align:right';
    input.onchange = async () => {
      const m = input.dataset.m, k = input.dataset.k;
      const months = { ...S.investments };
      months[m] = { ...(months[m] || {}), [k]: Number(input.value) || 0 };
      await setDoc(userDoc('investments', String(S.year)), { months }, { merge: true });
      toast('Saved');
    };
  });
}

// ═══════════════ SETTINGS ═══════════════
function renderSettings() {
  const el = $('view-settings');
  const cats = S.settings.categories;
  const catBlock = (type) => Object.entries(cats[type]).map(([c, subs]) => `
    <div style="margin-bottom:10px">
      <b>${esc(c)}</b>
      <div class="chip-list">${subs.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}
        <button class="chip link-btn" style="text-decoration:none" data-addsub="${esc(type)}|${esc(c)}">+ add</button>
      </div>
    </div>`).join('');

  el.innerHTML = `
    <h1>Settings</h1>

    <div class="section-title">Balance</div>
    <div class="card">
      <div class="settings-row">
        <label class="field" style="margin:0">
          <span>Starting balance for the year (${S.settings.currency})</span>
          <input type="number" id="set-start" step="0.01" value="${S.settings.startingBalance}">
        </label>
        <label class="field" style="margin:0;max-width:110px">
          <span>Currency</span>
          <input type="text" id="set-cur" maxlength="4" value="${esc(S.settings.currency)}">
        </label>
        <button class="btn btn-primary btn-sm" id="set-save" style="align-self:end">Save</button>
      </div>
    </div>

    <div class="section-title">Expense categories</div>
    <div class="card">${catBlock('expense')}
      <button class="btn btn-sm" data-addcat="expense">+ New expense category</button></div>

    <div class="section-title">Income categories</div>
    <div class="card">${catBlock('income')}
      <button class="btn btn-sm" data-addcat="income">+ New income category</button></div>

    <div class="section-title">Bank sync — Revolut</div>
    <div class="card">
      ${S.bank ? `
        <div class="settings-row">
          <span><b>Connected</b> · ${esc(S.bank.institutionName || 'Revolut')}${S.bank.lastSync ? ` · last sync ${esc(String(S.bank.lastSync).slice(0, 10))}` : ''}</span>
          <div class="spacer"></div>
          <button class="btn btn-primary btn-sm" id="bank-sync">Sync now</button>
          <button class="btn btn-sm" id="bank-disconnect">Disconnect</button>
        </div>
        <p class="hint" style="margin-top:8px">Sync pulls new Revolut transactions and files them using your saved merchant categories. Entries you've already recategorized are never overwritten.</p>
      ` : `
        <div class="settings-row">
          <span class="hint" style="flex:1;margin:0">Link your Revolut account through the EU open-banking network (GoCardless) and pull transactions automatically. Requires the optional Cloud Functions setup — see the README.</span>
          <button class="btn btn-primary btn-sm" id="bank-connect">Connect Revolut</button>
        </div>
      `}
    </div>

    <div class="section-title">Import</div>
    <div class="card">
      <div class="settings-row" style="margin-bottom:12px">
        <div style="flex:1;min-width:220px">
          <b>Revolut statement (CSV)</b>
          <p class="hint" style="margin:2px 0 0">Revolut app → Statement → Excel/CSV. You'll review and categorize before anything is saved. Re-importing the same file never duplicates.</p>
        </div>
        <button class="btn btn-sm" id="import-revolut">Choose CSV…</button>
      </div>
      <div class="settings-row">
        <div style="flex:1;min-width:220px">
          <b>Finance Excel workbook</b>
          <p class="hint" style="margin:2px 0 0">Imports your Finance_20xx.xlsx: one entry per subcategory per month (dated the 15th), plus starting balance and the Investment sheet.</p>
        </div>
        <button class="btn btn-sm" id="import-excel">Choose .xlsx…</button>
      </div>
      <div class="settings-row" style="margin-top:12px;border-top:1px dashed var(--rule);padding-top:12px">
        <span class="hint" style="margin:0">Imported entries are tagged, so you can undo:</span>
        <button class="btn btn-sm" data-purge="excel">Remove Excel imports (${S.year})</button>
        <button class="btn btn-sm" data-purge="revolut">Remove Revolut imports (${S.year})</button>
      </div>
    </div>

    <div class="section-title">Data</div>
    <div class="card settings-row">
      <button class="btn btn-sm" id="export-csv">Export ${S.year} as CSV</button>
      <span class="hint">Includes recurring entries, ready for Excel.</span>
    </div>
    <div class="card settings-row">
      <button class="btn btn-sm btn-danger" id="clear-year">Clear ${S.year}…</button>
      <span class="hint">Deletes every transaction and the Investment tracker for ${S.year}. Recurring rules are kept (edit them in Recurring if needed).</span>
    </div>

    <div class="section-title">Account</div>
    <div class="card settings-row">
      <span class="hint">${esc(S.user.email)}</span>
      <div class="spacer"></div>
      <button class="btn btn-sm" id="sign-out">Sign out</button>
    </div>
  `;

  $('set-save').onclick = async () => {
    await updateDoc(userDoc('meta', 'settings'), {
      startingBalance: Number($('set-start').value) || 0,
      currency: $('set-cur').value.trim() || '€',
    });
    toast('Settings saved');
  };
  el.querySelectorAll('[data-addsub]').forEach((b) => b.onclick = async () => {
    const [type, cat] = b.dataset.addsub.split('|');
    const name = prompt(`New subcategory for “${cat}”:`);
    if (!name?.trim()) return;
    const c = structuredClone(S.settings.categories);
    if (!c[type][cat].includes(name.trim())) c[type][cat].push(name.trim());
    await updateDoc(userDoc('meta', 'settings'), { categories: c });
    toast('Subcategory added');
  });
  el.querySelectorAll('[data-addcat]').forEach((b) => b.onclick = async () => {
    const type = b.dataset.addcat;
    const name = prompt(`New ${type} category name:`);
    if (!name?.trim()) return;
    const c = structuredClone(S.settings.categories);
    if (!c[type][name.trim()]) c[type][name.trim()] = ['Other'];
    await updateDoc(userDoc('meta', 'settings'), { categories: c });
    toast('Category added');
  });
  $('export-csv').onclick = exportCSV;
  $('clear-year').onclick = clearYear;
  $('sign-out').onclick = () => signOut(auth);
  $('import-excel').onclick = () => $('file-excel').click();
  $('import-revolut').onclick = () => $('file-revolut').click();
  el.querySelectorAll('[data-purge]').forEach((b) => b.onclick = () => purgeImports(b.dataset.purge));
  const bc = $('bank-connect'); if (bc) bc.onclick = bankConnect;
  const bs = $('bank-sync'); if (bs) bs.onclick = bankSync;
  const bd = $('bank-disconnect'); if (bd) bd.onclick = bankDisconnect;
}

function exportCSV() {
  const rows = [['Date', 'Type', 'Category', 'Subcategory', 'Note', 'Amount', 'Recurring']];
  const entries = allEntries().sort((a, b) => a.date.localeCompare(b.date));
  for (const e of entries) {
    rows.push([e.date, e.type, e.category, e.subcategory || '', e.note || '', Number(e.amount).toFixed(2), e.virtual ? 'yes' : 'no']);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `ledger-${S.year}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════ IMPORTS (Excel workbook & Revolut CSV) ═══════════════
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }

async function commitBatch(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const b = writeBatch(db);
    writes.slice(i, i + 400).forEach((w) => b.set(w.ref, w.data));
    await b.commit();
  }
}

async function clearYear() {
  const y = S.year;
  const n = S.transactions.length;
  if (!n && !Object.keys(S.investments).length) { toast(`${y} is already empty`); return; }
  if (prompt(`This deletes all ${n} transactions and the Investment tracker for ${y}. This cannot be undone.\n\nType ${y} to confirm:`) !== String(y)) return;
  for (let i = 0; i < S.transactions.length; i += 400) {
    const b = writeBatch(db);
    S.transactions.slice(i, i + 400).forEach((t) => b.delete(userDoc('transactions', t.id)));
    await b.commit();
  }
  if (Object.keys(S.investments).length) await deleteDoc(userDoc('investments', String(y)));
  toast(`Cleared ${y}`);
}

async function purgeImports(source) {
  const targets = S.transactions.filter((t) => t.source === source);
  if (!targets.length) { toast(`No ${source} imports in ${S.year}`); return; }
  if (!confirm(`Delete ${targets.length} ${source}-imported entries from ${S.year}?`)) return;
  for (let i = 0; i < targets.length; i += 400) {
    const b = writeBatch(db);
    targets.slice(i, i + 400).forEach((t) => b.delete(userDoc('transactions', t.id)));
    await b.commit();
  }
  toast(`Removed ${targets.length} entries`);
}

// ─── Excel workbook import ───────────────────────────────────
let XLSXlib = null;
async function loadXLSX() {
  if (XLSXlib) return XLSXlib;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  XLSXlib = window.XLSX;
  return XLSXlib;
}

$('file-excel').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await importExcel(f); }
  catch (ex) { console.error(ex); toast('Could not read that workbook'); }
});

async function importExcel(file) {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const yGuess = (file.name.match(/20\d\d/) || [])[0] || String(S.year);
  const year = prompt('Import this workbook as which year?', yGuess);
  if (!year || !/^20\d\d$/.test(year.trim())) return;
  const y = year.trim();

  const writes = [];
  const counts = { expense: 0, income: 0 };
  const parseSheet = (name, type) => {
    const ws = wb.Sheets[name];
    if (!ws) return;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    let cat = null;
    for (const row of rows) {
      if (row[0] != null && String(row[0]).trim()) cat = String(row[0]).trim();
      const label = row[2] != null ? String(row[2]).trim() : '';
      if (!label || /monthly totals/i.test(label) || label === 'Expenses' || label === 'Income' || !cat) continue;
      for (let m = 0; m < 12; m++) {
        const v = Number(row[3 + m]);
        if (!v || !isFinite(v)) continue;
        const id = `xl-${y}-${String(m + 1).padStart(2, '0')}-${slug(cat)}-${slug(label)}`;
        writes.push({
          ref: userDoc('transactions', id),
          data: {
            type, amount: Math.round(v * 100) / 100,
            date: `${y}-${String(m + 1).padStart(2, '0')}-15`,
            category: cat, subcategory: label,
            note: 'Imported from Excel', source: 'excel',
          },
        });
        counts[type]++;
      }
    }
  };
  parseSheet('Expenses', 'expense');
  parseSheet('Income', 'income');

  // Starting balance sheet
  let startBal = null;
  const sb = wb.Sheets['Starting balance'];
  if (sb) {
    for (const r of XLSX.utils.sheet_to_json(sb, { header: 1, defval: null })) {
      for (let i = 0; i < r.length; i++) {
        if (typeof r[i] === 'string' && /starting balance/i.test(r[i])) {
          const n = r.slice(i + 1).find((x) => typeof x === 'number');
          if (n != null) startBal = n;
        }
      }
    }
  }

  // Investment sheet
  let invMonths = null;
  const ivs = wb.Sheets['Investment'];
  if (ivs) {
    const rows = XLSX.utils.sheet_to_json(ivs, { header: 1, defval: null });
    const find = (re) => rows.find((r) => typeof r[0] === 'string' && re.test(r[0]));
    const sRow = find(/^starting balance/i), iRow = find(/^invested/i), pRow = find(/^profit/i);
    if (sRow || iRow || pRow) {
      invMonths = {};
      for (let m = 0; m < 12; m++) {
        const o = {};
        if (sRow && Number(sRow[1 + m])) o.start = Number(sRow[1 + m]);
        if (iRow && Number(iRow[1 + m])) o.invested = Number(iRow[1 + m]);
        if (pRow && Number(pRow[1 + m])) o.pl = Number(pRow[1 + m]);
        if (Object.keys(o).length) invMonths[String(m + 1)] = o;
      }
      if (!Object.keys(invMonths).length) invMonths = null;
    }
  }

  const parts = [`${counts.expense} expense + ${counts.income} income entries for ${y} (dated the 15th of each month)`];
  if (startBal != null) parts.push(`starting balance ${startBal}`);
  if (invMonths) parts.push('the Investment tracker');
  const warn = S.recurring.length ? '\n\nHeads-up: months already covered by your recurring rules would be counted twice.' : '';
  if (!confirm(`Import ${parts.join(', ')}?\n\nRe-importing the same workbook updates entries instead of duplicating them.${warn}`)) return;

  await commitBatch(writes);
  if (startBal != null) await updateDoc(userDoc('meta', 'settings'), { startingBalance: startBal });
  if (invMonths) await setDoc(userDoc('investments', y), { months: invMonths }, { merge: true });
  if (Number(y) !== S.year) { S.year = Number(y); $('year-label').textContent = S.year; subscribeYearData(); }
  toast('Excel workbook imported');
}

// ─── Revolut statement CSV import ────────────────────────────
const REV_GUESS = [
  [/spar|mercator|lidl|hofer|tu[sš]|eurospin|aldi|market/i, ['Everyday', 'Hrana - trgovina']],
  [/wolt|glovo|ehrana|bolt food|mcdonald|kfc|pizz|kebab|burger|restaurant|restavracija/i, ['Everyday', 'Hrana - restavracije & dostava']],
  [/frizer|barber/i, ['Everyday', 'Frizer, self care']],
  [/h&m|zara|zalando|about you|c&a/i, ['Everyday', 'Clothes']],
  [/petrol|omv|mol\b|shell/i, ['Transportation', 'Bencin']],
  [/lpp|urbana|arriva|[zž]eleznic|flixbus|nomago/i, ['Transportation', 'Javni prevoz']],
  [/netflix|spotify|youtube|hbo|disney|apple\.com|steam|playstation|xbox|patreon/i, ['Entertainment', 'Subscriptions']],
  [/kino|cinema|bar\b|pub\b|klub/i, ['Entertainment', 'Going out']],
  [/lekarna|pharmac/i, ['Health', 'Pharmacy']],
  [/ikea|obi|bauhaus|merkur/i, ['Home', 'Ikea']],
  [/booking|airbnb|hostel|hotel/i, ['Travel', 'Hotels']],
  [/ryanair|wizz|easyjet|lufthansa|air /i, ['Travel', 'Airfare']],
];

const normMerchant = (d) => String(d).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);

function guessCat(desc, type) {
  const saved = S.settings.merchantMap?.[normMerchant(desc)];
  if (saved && saved.type === type && S.settings.categories[type][saved.category])
    return [saved.category, saved.subcategory];
  if (type === 'expense') for (const [re, val] of REV_GUESS) if (re.test(desc)) return val;
  if (type === 'income' && /salary|pla[cč]a|payroll/i.test(desc)) return ['Paycheck', 'Paycheck'];
  return type === 'expense' ? ['Everyday', 'Other'] : ['Other', 'Other'];
}

function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  return rows;
}

let revRows = [];

$('file-revolut').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { prepareRevolutImport(await f.text()); }
  catch (ex) { console.error(ex); toast('Could not read that CSV'); }
});

function prepareRevolutImport(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) { toast('Empty file'); return; }
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const iType = col('type'), iStart = col('started date'), iDone = col('completed date'),
        iDesc = col('description'), iAmt = col('amount'), iState = col('state');
  if (iDesc < 0 || iAmt < 0) { toast('That doesn’t look like a Revolut statement CSV'); return; }

  revRows = [];
  for (const r of rows.slice(1)) {
    if (iState >= 0 && r[iState] && r[iState].toUpperCase() !== 'COMPLETED') continue;
    const amt = Number(r[iAmt]);
    if (!amt || !isFinite(amt)) continue;
    const date = String((iDone >= 0 && r[iDone]) || (iStart >= 0 && r[iStart]) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const desc = (r[iDesc] || '').trim() || 'Revolut';
    const type = amt < 0 ? 'expense' : 'income';
    const [category, subcategory] = guessCat(desc, type);
    const id = 'rev-' + hashStr(`${date}|${desc}|${amt.toFixed(2)}`);
    const exists = Number(date.slice(0, 4)) === S.year && S.transactions.some((t) => t.id === id);
    const isTransfer = iType >= 0 && /transfer/i.test(r[iType] || '');
    revRows.push({ id, date, desc, type, category, subcategory,
      amount: Math.abs(Math.round(amt * 100) / 100),
      on: !exists && !isTransfer, exists, isTransfer });
  }
  if (!revRows.length) { toast('No completed transactions found in that file'); return; }
  revRows.sort((a, b) => b.date.localeCompare(a.date));
  renderRevPreview();
  $('rev-modal').classList.remove('hidden');
}

function revSummary() {
  const nOn = revRows.filter((r) => r.on).length;
  $('rev-summary').textContent =
    `${revRows.length} transactions · ${nOn} selected. Transfers and already-imported rows start unchecked. Category picks are remembered per merchant for next time.`;
}

function renderRevPreview() {
  const box = $('rev-rows');
  revSummary();
  box.innerHTML = revRows.map((r, i) => {
    const cats = S.settings.categories[r.type];
    const catOpts = Object.keys(cats).map((c) => `<option ${c === r.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const subOpts = (cats[r.category] || []).map((s) => `<option ${s === r.subcategory ? 'selected' : ''}>${esc(s)}</option>`).join('');
    const flags = [r.exists ? 'already in' : '', r.isTransfer ? 'transfer' : ''].filter(Boolean).join(' · ');
    return `<div class="rev-row ${r.on ? '' : 'off'}" id="revrow-${i}">
      <input type="checkbox" data-i="${i}" ${r.on ? 'checked' : ''} aria-label="Include ${esc(r.desc)}">
      <span class="mono">${r.date.slice(5)}</span>
      <span class="desc" title="${esc(r.desc)}">${esc(r.desc)}${flags ? ` <span class="hint" style="margin:0">· ${flags}</span>` : ''}</span>
      <span class="amt ${r.type === 'income' ? 'in' : ''}">${r.type === 'income' ? '+' : '−'}${fmt(r.amount).replace('−', '')}</span>
      <span class="cats">
        <select data-cat="${i}" aria-label="Category">${catOpts}</select>
        <select data-sub="${i}" aria-label="Subcategory">${subOpts}</select>
      </span>
    </div>`;
  }).join('');

  box.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.onchange = () => {
    const r = revRows[cb.dataset.i];
    r.on = cb.checked;
    $(`revrow-${cb.dataset.i}`).classList.toggle('off', !r.on);
    revSummary();
  });
  box.querySelectorAll('[data-cat]').forEach((sel) => sel.onchange = () => {
    const r = revRows[sel.dataset.cat];
    r.category = sel.value;
    r.subcategory = (S.settings.categories[r.type][r.category] || [''])[0] || '';
    const key = normMerchant(r.desc);
    revRows.forEach((o) => {
      if (o !== r && o.type === r.type && normMerchant(o.desc) === key) { o.category = r.category; o.subcategory = r.subcategory; }
    });
    renderRevPreview();
  });
  box.querySelectorAll('[data-sub]').forEach((sel) => sel.onchange = () => {
    const r = revRows[sel.dataset.sub];
    r.subcategory = sel.value;
    const key = normMerchant(r.desc);
    revRows.forEach((o) => { if (o !== r && o.type === r.type && normMerchant(o.desc) === key) o.subcategory = r.subcategory; });
  });
}

$('rev-import-btn').addEventListener('click', async () => {
  const sel = revRows.filter((r) => r.on);
  if (!sel.length) { toast('Nothing selected'); return; }
  const writes = sel.map((r) => ({
    ref: userDoc('transactions', r.id),
    data: { type: r.type, amount: r.amount, date: r.date, category: r.category, subcategory: r.subcategory, note: r.desc, source: 'revolut' },
  }));
  const mm = { ...(S.settings.merchantMap || {}) };
  for (const r of sel) mm[normMerchant(r.desc)] = { type: r.type, category: r.category, subcategory: r.subcategory };
  try {
    await commitBatch(writes);
    await updateDoc(userDoc('meta', 'settings'), { merchantMap: mm });
    closeModal('rev-modal');
    const allThisYear = sel.every((r) => Number(r.date.slice(0, 4)) === S.year);
    toast(`Imported ${sel.length} entries${allThisYear ? '' : ' — some are in another year, switch year to see them'}`);
  } catch (ex) { console.error(ex); toast('Import failed — check your connection'); }
});

// ─── Live bank sync (optional Cloud Functions backend) ───────
async function bankConnect() {
  try {
    toast('Preparing secure bank link…');
    const res = await httpsCallable(fns, 'bankConnect')({ country: 'SI', redirect: window.location.origin });
    window.location.href = res.data.link;
  } catch (ex) {
    console.error(ex);
    const notDeployed = ['functions/not-found', 'functions/unavailable', 'functions/internal'].includes(ex.code);
    toast(notDeployed ? 'Bank sync backend not deployed yet — see the README' : (ex.message || 'Could not start the bank link'));
  }
}

async function bankSync() {
  const btn = $('bank-sync');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    const res = await httpsCallable(fns, 'bankSync')({});
    toast(`Synced: ${res.data.imported} new, ${res.data.skipped} already in`);
  } catch (ex) {
    console.error(ex);
    toast(ex.message || 'Sync failed');
  } finally {
    const b = $('bank-sync');
    if (b) { b.disabled = false; b.textContent = 'Sync now'; }
  }
}

async function bankDisconnect() {
  if (!confirm('Disconnect Revolut? Entries already imported stay in your book.')) return;
  await deleteDoc(userDoc('meta', 'bank'));
  toast('Disconnected');
}

// ═══════════════ TRANSACTION MODAL ═══════════════
let txType = 'expense';

function fillCategorySelects(prefix, type, cat, sub) {
  const cats = S.settings.categories[type];
  const catSel = $(`${prefix}-category`);
  const subSel = $(`${prefix}-subcategory`);
  catSel.innerHTML = Object.keys(cats).map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const fillSubs = () => {
    const subs = cats[catSel.value] || [];
    subSel.innerHTML = subs.map((s) => `<option ${s === sub ? 'selected' : ''}>${esc(s)}</option>`).join('');
  };
  fillSubs();
  catSel.onchange = fillSubs;
}

function openTxModal(tx = null) {
  S.editingTx = tx;
  txType = tx?.type || 'expense';
  $('tx-modal-title').textContent = tx ? 'Edit entry' : 'Add entry';
  $('tx-delete').classList.toggle('hidden', !tx);
  $('tx-amount').value = tx?.amount ?? '';
  $('tx-date').value = tx?.date || new Date().toISOString().slice(0, 10);
  $('tx-note').value = tx?.note || '';
  document.querySelectorAll('[data-txtype]').forEach((b) =>
    b.classList.toggle('active', b.dataset.txtype === txType));
  fillCategorySelects('tx', txType, tx?.category, tx?.subcategory);
  $('tx-modal').classList.remove('hidden');
  setTimeout(() => $('tx-amount').focus(), 50);
}

document.querySelectorAll('[data-txtype]').forEach((b) => b.addEventListener('click', () => {
  txType = b.dataset.txtype;
  document.querySelectorAll('[data-txtype]').forEach((x) => x.classList.toggle('active', x === b));
  fillCategorySelects('tx', txType);
}));

$('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    type: txType,
    amount: Math.round(Number($('tx-amount').value) * 100) / 100,
    date: $('tx-date').value,
    category: $('tx-category').value,
    subcategory: $('tx-subcategory').value || '',
    note: $('tx-note').value.trim(),
  };
  if (!data.amount || !data.date) return;
  const wasEditing = !!S.editingTx;
  try {
    if (wasEditing) await updateDoc(userDoc('transactions', S.editingTx.id), data);
    else await addDoc(userCol('transactions'), data);
    closeModal('tx-modal');
    if (Number(data.date.slice(0, 4)) !== S.year) toast(`Saved to ${data.date.slice(0, 4)} — switch year to see it`);
    else toast(wasEditing ? 'Entry updated' : 'Entry added');
  } catch { toast('Could not save — check your connection'); }
});

$('tx-delete').addEventListener('click', async () => {
  if (!S.editingTx) return;
  if (!confirm('Delete this entry?')) return;
  await deleteDoc(userDoc('transactions', S.editingTx.id));
  closeModal('tx-modal');
  toast('Entry deleted');
});

// ═══════════════ RECURRING MODAL ═══════════════
let recType = 'expense';

function openRecModal(rule = null) {
  S.editingRec = rule;
  recType = rule?.type || 'expense';
  $('rec-modal-title').textContent = rule ? 'Edit recurring' : 'Add recurring';
  $('rec-delete').classList.toggle('hidden', !rule);
  $('rec-name').value = rule?.name || '';
  $('rec-amount').value = rule?.amount ?? '';
  $('rec-day').value = rule?.day || 1;
  $('rec-start').value = rule?.startMonth || new Date().toISOString().slice(0, 7);
  $('rec-end').value = rule?.endMonth || '';
  document.querySelectorAll('[data-rectype]').forEach((b) =>
    b.classList.toggle('active', b.dataset.rectype === recType));
  fillCategorySelects('rec', recType, rule?.category, rule?.subcategory);
  renderRecOverrides(rule);
  $('rec-modal').classList.remove('hidden');
  setTimeout(() => $('rec-name').focus(), 50);
}

function renderRecOverrides(rule) {
  const box = $('rec-overrides');
  const ovr = rule?.overrides || {};
  const keys = Object.keys(ovr).sort();
  if (!keys.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="section-title" style="margin:12px 0 4px">Month adjustments</div>` +
    keys.map((k) => `<div class="ovr-item">
      <span class="mono">${k}</span>
      <span class="hint" style="margin:0">${ovr[k].skip ? 'skipped' : `${fmt(ovr[k].amount)} · day ${ovr[k].day ?? rule.day}`}</span>
      <div class="spacer"></div>
      <button type="button" class="icon-btn" data-clearovr="${k}" aria-label="Remove adjustment for ${k}">✕</button>
    </div>`).join('');
  box.querySelectorAll('[data-clearovr]').forEach((b) => b.onclick = async () => {
    await updateDoc(userDoc('recurring', rule.id), { [`overrides.${b.dataset.clearovr}`]: deleteField() });
    const fresh = S.recurring.find((r) => r.id === rule.id);
    renderRecOverrides({ ...rule, overrides: Object.fromEntries(Object.entries(ovr).filter(([kk]) => kk !== b.dataset.clearovr)) });
    if (fresh) S.editingRec = fresh;
    toast('Adjustment removed');
  });
}

document.querySelectorAll('[data-rectype]').forEach((b) => b.addEventListener('click', () => {
  recType = b.dataset.rectype;
  document.querySelectorAll('[data-rectype]').forEach((x) => x.classList.toggle('active', x === b));
  fillCategorySelects('rec', recType);
}));

$('rec-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const start = $('rec-start').value;
  const end = $('rec-end').value || null;
  if (end && end < start) { toast('End month must be after start month'); return; }
  const data = {
    type: recType,
    name: $('rec-name').value.trim(),
    amount: Math.round(Number($('rec-amount').value) * 100) / 100,
    day: Math.min(31, Math.max(1, Number($('rec-day').value) || 1)),
    category: $('rec-category').value,
    subcategory: $('rec-subcategory').value || '',
    startMonth: start,
    endMonth: end,
  };
  if (!data.name || !data.amount) return;
  const wasEditing = !!S.editingRec;
  try {
    if (wasEditing) await updateDoc(userDoc('recurring', S.editingRec.id), data);
    else await addDoc(userCol('recurring'), data);
    closeModal('rec-modal');
    toast(wasEditing ? 'Recurring updated' : 'Recurring added');
  } catch { toast('Could not save — check your connection'); }
});

$('rec-delete').addEventListener('click', async () => {
  if (!S.editingRec) return;
  if (!confirm(`Delete “${S.editingRec.name}”? All its monthly entries disappear from every month.`)) return;
  await deleteDoc(userDoc('recurring', S.editingRec.id));
  closeModal('rec-modal');
  toast('Recurring deleted');
});

// ═══════════════ PROJECT MODAL ═══════════════
function openProjectModal(project = null) {
  S.editingProject = project;
  $('project-modal-title').textContent = project ? 'Edit project' : 'New project';
  $('project-delete').classList.toggle('hidden', !project);
  $('project-name').value = project?.name || '';
  $('project-budget').value = project?.budget ?? '';
  $('project-note').value = project?.note || '';
  $('project-modal').classList.remove('hidden');
  setTimeout(() => $('project-name').focus(), 50);
}

$('project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('project-name').value.trim();
  if (!name) return;
  const data = {
    name,
    budget: $('project-budget').value ? Math.round(Number($('project-budget').value) * 100) / 100 : null,
    note: $('project-note').value.trim(),
  };
  const editing = S.editingProject;
  try {
    if (editing) {
      data.archived = !!editing.archived;
      await updateDoc(userDoc('projects', editing.id), data);
      if (editing.name !== name) {
        const linked = projectExpensesFor(editing.id);
        for (let i = 0; i < linked.length; i += 400) {
          const b = writeBatch(db);
          linked.slice(i, i + 400).forEach((e2) => b.update(userDoc('transactions', e2.id), { subcategory: name }));
          await b.commit();
        }
      }
    } else {
      await addDoc(userCol('projects'), { ...data, archived: false });
    }
    closeModal('project-modal');
    toast(editing ? 'Project updated' : 'Project created');
  } catch { toast('Could not save — check your connection'); }
});

$('project-delete').addEventListener('click', async () => {
  if (!S.editingProject) return;
  const linked = projectExpensesFor(S.editingProject.id);
  if (!confirm(`Delete “${S.editingProject.name}” and its ${linked.length} expense${linked.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  for (let i = 0; i < linked.length; i += 400) {
    const b = writeBatch(db);
    linked.slice(i, i + 400).forEach((e2) => b.delete(userDoc('transactions', e2.id)));
    await b.commit();
  }
  await deleteDoc(userDoc('projects', S.editingProject.id));
  closeModal('project-modal');
  toast('Project deleted');
});

// ═══════════════ PROJECT EXPENSE MODAL ═══════════════
function openPexpModal(project, expense = null) {
  S.editingPexp = { project, expense };
  $('pexp-modal-title').textContent = expense ? `Edit expense — ${project.name}` : `Add expense — ${project.name}`;
  $('pexp-delete').classList.toggle('hidden', !expense);
  $('pexp-amount').value = expense?.amount ?? '';
  $('pexp-date').value = expense?.date || todayStr();
  $('pexp-note').value = expense?.note || '';
  $('pexp-modal').classList.remove('hidden');
  setTimeout(() => $('pexp-amount').focus(), 50);
}

$('pexp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { project, expense } = S.editingPexp;
  const data = {
    type: 'expense',
    amount: Math.round(Number($('pexp-amount').value) * 100) / 100,
    date: $('pexp-date').value,
    category: 'Projects',
    subcategory: project.name,
    note: $('pexp-note').value.trim(),
    source: 'project',
    projectId: project.id,
  };
  if (!data.amount || !data.date) return;
  try {
    if (expense) await updateDoc(userDoc('transactions', expense.id), data);
    else await addDoc(userCol('transactions'), data);
    closeModal('pexp-modal');
    toast(expense ? 'Expense updated' : 'Expense added');
  } catch { toast('Could not save — check your connection'); }
});

$('pexp-delete').addEventListener('click', async () => {
  const { expense } = S.editingPexp || {};
  if (!expense) return;
  if (!confirm('Delete this expense?')) return;
  await deleteDoc(userDoc('transactions', expense.id));
  closeModal('pexp-modal');
  toast('Expense deleted');
});

// ═══════════════ PER-MONTH OVERRIDE MODAL ═══════════════
let ovrCtx = null; // { rule, monthKey }

function openOvrModal(rule, monthKey) {
  ovrCtx = { rule, monthKey };
  const ovr = rule.overrides?.[monthKey];
  const [y, m] = monthKey.split('-').map(Number);
  const monthName = new Date(y, m - 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  $('ovr-title').textContent = `${rule.name} — ${monthName}`;
  $('ovr-sub').textContent = ovr
    ? `Adjusted for this month (rule amount: ${fmt(rule.amount)} on day ${rule.day}).`
    : `Change this month only — every other month keeps the rule (${fmt(rule.amount)} on day ${rule.day}).`;
  $('ovr-amount').value = ovr?.amount ?? rule.amount;
  $('ovr-day').value = ovr?.day ?? rule.day;
  $('ovr-reset').classList.toggle('hidden', !ovr);
  $('ovr-modal').classList.remove('hidden');
}

async function saveOverride(patch) {
  const { rule, monthKey } = ovrCtx;
  await updateDoc(userDoc('recurring', rule.id),
    patch === null
      ? { [`overrides.${monthKey}`]: deleteField() }
      : { [`overrides.${monthKey}`]: patch });
  closeModal('ovr-modal');
}

$('ovr-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Math.round(Number($('ovr-amount').value) * 100) / 100;
  const day = Math.min(31, Math.max(1, Number($('ovr-day').value) || 1));
  if (!amount) return;
  await saveOverride({ amount, day });
  toast('Month adjusted');
});
$('ovr-skip').addEventListener('click', async () => {
  await saveOverride({ skip: true });
  toast('Skipped this month');
});
$('ovr-reset').addEventListener('click', async () => {
  await saveOverride(null);
  toast('Back to the rule');
});
$('ovr-edit-rule').addEventListener('click', () => {
  const rule = ovrCtx.rule;
  closeModal('ovr-modal');
  openRecModal(S.recurring.find((r) => r.id === rule.id) || rule);
});

// ─── Modal plumbing ──────────────────────────────────────────
function closeModal(id) {
  $(id).classList.add('hidden');
  S.editingTx = null; S.editingRec = null; S.editingProject = null; S.editingPexp = null;
}
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => closeModal(b.dataset.close)));
document.querySelectorAll('.modal-backdrop').forEach((bd) =>
  bd.addEventListener('click', (e) => { if (e.target === bd) closeModal(bd.id); }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ['tx-modal', 'rec-modal', 'ovr-modal', 'rev-modal', 'project-modal', 'pexp-modal'].forEach(closeModal);
});
