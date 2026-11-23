/* Candle Quest — diario de trading gamificado. Todo local (IndexedDB). */
'use strict';

// ---------- IndexedDB ----------
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('candlequest', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('trades', { keyPath: 'id' });
      d.createObjectStore('images');
      d.createObjectStore('meta');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store);
    const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
  });
  return {
    open,
    all: store => tx(store, 'readonly', s => s.getAll()),
    get: (store, k) => tx(store, 'readonly', s => s.get(k)),
    put: (store, v, k) => tx(store, 'readwrite', s => k === undefined ? s.put(v) : s.put(v, k)),
    del: (store, k) => tx(store, 'readwrite', s => s.delete(k)),
    clear: store => tx(store, 'readwrite', s => s.clear()),
    keys: store => tx(store, 'readonly', s => s.getAllKeys()),
  };
})();

// ---------- State ----------
const DEFAULT_SETTINGS = {
  trader: 'Trader', petName: 'Velita', account: 'Cuenta principal', capital: 500, ccy: '€', riskPct: 1, goal: 10000, goalDate: (() => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10); })(),
  rules: ['Opero a favor de la tendencia del marco superior', 'Esperé el cierre de la vela de confirmación',
    'Riesgo ≤ 1% de la cuenta', 'SL colocado antes de entrar y respetado', 'R:R planificado ≥ 1.5',
    'No es un trade de revancha ni por aburrimiento'].join('\n'),
};
const EMOTIONS = ['', '😌 Tranquilo', '🎯 Enfocado', '💪 Confiado', '😰 Ansioso', '😨 Miedo', '😤 Revancha', '🤑 Codicioso', '😴 Cansado', '😵 Frustrado', '🙂 Satisfecho'];
const PAIRS = ['USDJPY', 'GBPJPY', 'EURJPY', 'GBPUSD', 'EURUSD', 'AUDJPY', 'XAUUSD'];
const SETUPS = ['Pin bar en S/R', 'Envolvente', 'Ruptura + retesteo', 'Pullback a EMA', 'Doble techo/suelo', 'Inside bar', 'Rango asiático'];
const state = { trades: [], settings: { ...DEFAULT_SETTINGS }, thumbs: {}, charts: {}, calMonth: null, form: { imgBefore: null, imgAfter: null, activeSlot: 'imgBefore' } };
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const num = v => (v === '' || v === null || v === undefined || isNaN(+v)) ? null : +v;
const rulesList = () => state.settings.rules.split('\n').map(s => s.trim()).filter(Boolean);

// ---------- Formatting ----------
const money = (v, sign = true) => v == null ? '—' : (sign && v > 0 ? '+' : '') + v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + state.settings.ccy;
const pct = (v, d = 1) => v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d) + '%';
const fx = (v, d = 2) => v == null || !isFinite(v) ? '—' : v.toFixed(d);
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const fmtDate = d => d ? new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtDT = d => d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const monthKey = d => dayKey(d).slice(0, 7);
const toLocalInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

// ---------- Trade math ----------
const pipSize = pair => /JPY/i.test(pair) ? 0.01 : /XAU/i.test(pair) ? 0.1 : 0.0001;
function derive(t) {
  const d = t.dir === 'short' ? -1 : 1, ps = pipSize(t.pair || '');
  const out = { pips: null, R: null, plannedRR: null, riskPips: null };
  if (t.entry != null && t.exit != null) out.pips = (t.exit - t.entry) * d / ps;
  if (t.entry != null && t.sl != null && t.sl !== t.entry) {
    const risk = Math.abs(t.entry - t.sl);
    out.riskPips = risk / ps;
    if (t.exit != null) out.R = (t.exit - t.entry) * d / risk;
    if (t.tp != null) out.plannedRR = Math.abs(t.tp - t.entry) / risk;
  }
  return out;
}
function session(date) {
  const h = new Date(date).getUTCHours();
  if (h < 7) return 'Asia (Tokio)';
  if (h < 12) return 'Londres';
  if (h < 16) return 'Solape Londres/NY';
  if (h < 21) return 'Nueva York';
  return 'Cierre / rollover';
}
// Resultado: victoria / stop loss / derrota (cierre manual en pérdida) / break-even
function outcome(t) {
  if (t.pnl > 0) return 'win';
  if (!t.pnl) return 'be';
  if (t.sl != null && t.exit != null) {
    const d = t.dir === 'short' ? -1 : 1;
    if ((t.exit - t.sl) * d <= pipSize(t.pair || '') * 1.5) return 'sl';
  }
  return 'loss';
}
const OUTCOME = { win: ['🏆', 'Victoria', 'pos'], sl: ['🛑', 'Stop loss', 'neg'], loss: ['❌', 'Derrota', 'neg'], be: ['➖', 'Break-even', ''] };
function goalInfo(s) {
  const st = state.settings, start = +st.capital || 0, goal = +st.goal || 0, eq = s.finalEq;
  if (!goal || goal <= start) return null;
  const prog = Math.max(0, Math.min(1, (eq - start) / (goal - start)));
  const end = st.goalDate ? new Date(st.goalDate + 'T23:59:59') : null;
  const monthsLeft = end ? Math.max(0, (end - Date.now()) / (30.44 * 864e5)) : null;
  const need = eq > 0 ? goal / eq : null;
  const monthly = need && monthsLeft > 0.25 && need > 1 ? Math.pow(need, 1 / monthsLeft) - 1 : null;
  const daysLeft = end ? Math.max(0, Math.ceil((end - Date.now()) / 864e5)) : null;
  return { start, goal, eq, prog, need, monthly, daysLeft, end };
}
function goalText(gi) {
  if (!gi) return ['', 'Define tu meta en Ajustes'];
  if (gi.eq >= gi.goal) return [`${money(gi.eq, false)} / ${money(gi.goal, false)}`, '🏁 ¡META CONSEGUIDA!'];
  return [`${money(gi.eq, false)} / ${money(gi.goal, false)}`,
    `${pct(gi.prog, 1)} del camino · te falta x${fx(gi.need, 1)}` + (gi.daysLeft != null ? ` · ${gi.daysLeft} días` : '') + (gi.monthly != null ? ` · ~${pct(gi.monthly, 1)} al mes` : '')];
}
const discipline = t => { const n = rulesList().length; return n ? Math.min(1, (t.rules || []).length / n) : 1; };
const ruleBroken = t => discipline(t) < 1;
function completeness(t) {
  const parts = [(t.reason || '').trim().length >= 20, !!t.imgBefore, !!t.imgAfter, (t.review || '').trim().length >= 20, !!(t.emoBefore && t.emoAfter)];
  return parts.filter(Boolean).length / parts.length;
}
function tradeXP(t) {
  let xp = 10;
  if ((t.reason || '').trim().length >= 20) xp += 10;
  if (t.imgBefore) xp += 10;
  if (t.imgAfter) xp += 10;
  if ((t.review || '').trim().length >= 20) xp += 10;
  if (t.emoBefore && t.emoAfter) xp += 5;
  xp += Math.round(25 * discipline(t));
  return xp;
}

// ---------- Stats ----------
function computeStats(trades, capital = +state.settings.capital || 0) {
  const ts = [...trades].sort((a, b) => new Date(a.closeDate || a.date) - new Date(b.closeDate || b.date));
  const n = ts.length;
  const s = { n, trades: ts, capital };
  const pnls = ts.map(t => t.pnl || 0);
  const wins = ts.filter(t => t.pnl > 0), losses = ts.filter(t => t.pnl < 0);
  s.wins = wins.length; s.losses = losses.length; s.be = n - s.wins - s.losses;
  s.net = pnls.reduce((a, b) => a + b, 0);
  s.grossP = wins.reduce((a, t) => a + t.pnl, 0);
  s.grossL = -losses.reduce((a, t) => a + t.pnl, 0);
  s.winRate = n ? s.wins / n : null;
  s.pf = s.grossL ? s.grossP / s.grossL : (s.grossP ? Infinity : null);
  s.avgWin = wins.length ? s.grossP / wins.length : null;
  s.avgLoss = losses.length ? -s.grossL / losses.length : null;
  s.payoff = s.avgWin != null && s.avgLoss ? s.avgWin / -s.avgLoss : null;
  s.expectancy = n ? s.net / n : null;
  s.ret = capital ? s.net / capital : null;
  const rs = ts.map(t => derive(t).R).filter(r => r != null);
  s.rCount = rs.length;
  s.avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  s.totalR = rs.reduce((a, b) => a + b, 0);
  s.best = n ? Math.max(...pnls) : null; s.worst = n ? Math.min(...pnls) : null;
  // equity + drawdown
  let eq = capital, peak = capital, maxDD = 0, maxDDpct = 0;
  s.equity = [{ x: ts[0] ? new Date(ts[0].date) : new Date(), y: capital }];
  s.dd = [];
  ts.forEach(t => {
    eq += t.pnl || 0; peak = Math.max(peak, eq);
    const dd = peak - eq, ddp = peak ? dd / peak : 0;
    maxDD = Math.max(maxDD, dd); maxDDpct = Math.max(maxDDpct, ddp);
    s.equity.push({ x: new Date(t.closeDate || t.date), y: eq });
    s.dd.push({ x: new Date(t.closeDate || t.date), y: -ddp * 100 });
  });
  s.finalEq = eq; s.maxDD = maxDD; s.maxDDpct = maxDDpct;
  s.recovery = maxDD ? s.net / maxDD : null;
  // streaks
  let cw = 0, cl = 0; s.maxW = 0; s.maxL = 0;
  ts.forEach(t => { if (t.pnl > 0) { cw++; cl = 0; } else if (t.pnl < 0) { cl++; cw = 0; } s.maxW = Math.max(s.maxW, cw); s.maxL = Math.max(s.maxL, cl); });
  // daily sharpe
  const days = {}; ts.forEach(t => { const k = dayKey(t.closeDate || t.date); days[k] = (days[k] || 0) + (t.pnl || 0); });
  const dr = Object.values(days).map(v => capital ? v / capital : v);
  if (dr.length > 1) { const m = dr.reduce((a, b) => a + b, 0) / dr.length; const sd = Math.sqrt(dr.reduce((a, b) => a + (b - m) ** 2, 0) / (dr.length - 1)); s.sharpe = sd ? m / sd * Math.sqrt(252) : null; } else s.sharpe = null;
  s.tradingDays = Object.keys(days).length; s.days = days;
  // hold time
  const holds = ts.filter(t => t.closeDate).map(t => new Date(t.closeDate) - new Date(t.date)).filter(h => h >= 0);
  s.avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;
  // process
  s.discipline = n ? ts.reduce((a, t) => a + discipline(t), 0) / n : null;
  s.journal = n ? ts.reduce((a, t) => a + completeness(t), 0) / n : null;
  const plan = ts.filter(t => !ruleBroken(t)), broke = ts.filter(ruleBroken);
  s.plan = { n: plan.length, net: plan.reduce((a, t) => a + t.pnl, 0), wr: plan.length ? plan.filter(t => t.pnl > 0).length / plan.length : null };
  s.broke = { n: broke.length, net: broke.reduce((a, t) => a + t.pnl, 0), wr: broke.length ? broke.filter(t => t.pnl > 0).length / broke.length : null };
  // monthly
  s.months = {}; let runEq = capital;
  ts.forEach(t => { const k = monthKey(t.closeDate || t.date); if (!s.months[k]) s.months[k] = { pnl: 0, n: 0, startEq: runEq }; s.months[k].pnl += t.pnl; s.months[k].n++; runEq += t.pnl; });
  return s;
}
function groupBy(ts, keyFn) {
  const g = {};
  ts.forEach(t => { const k = keyFn(t) || '—'; (g[k] = g[k] || []).push(t); });
  return Object.entries(g).map(([k, arr]) => {
    const w = arr.filter(t => t.pnl > 0), l = arr.filter(t => t.pnl < 0);
    const gp = w.reduce((a, t) => a + t.pnl, 0), gl = -l.reduce((a, t) => a + t.pnl, 0);
    const rs = arr.map(t => derive(t).R).filter(r => r != null);
    return { k, n: arr.length, net: gp - gl, wr: w.length / arr.length, pf: gl ? gp / gl : (gp ? Infinity : null), avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
  }).sort((a, b) => b.net - a.net);
}

// ---------- Gamification ----------
const BADGES = [
  { id: 'first', i: '🥚', n: 'Rompe el cascarón', d: 'Registra tu primer trade', t: (s) => s.n >= 1 },
  { id: 'j10', i: '📒', n: 'Escribano', d: '10 trades registrados', t: s => s.n >= 10 },
  { id: 'j50', i: '📚', n: 'Archivista', d: '50 trades registrados', t: s => s.n >= 50 },
  { id: 'j100', i: '🏛️', n: 'Centurión', d: '100 trades registrados', t: s => s.n >= 100 },
  { id: 'j250', i: '🗿', n: 'Monumento', d: '250 trades registrados', t: s => s.n >= 250 },
  { id: 'full10', i: '🖼️', n: 'Fotógrafo', d: '10 trades con diario 100% completo', t: s => s.trades.filter(t => completeness(t) === 1).length >= 10 },
  { id: 'disc5', i: '🛡️', n: 'Disciplina de hierro', d: '5 trades seguidos cumpliendo todas tus reglas', t: s => streak(s.trades, t => !ruleBroken(t)) >= 5 },
  { id: 'disc20', i: '⚔️', n: 'Samurái', d: '20 trades seguidos cumpliendo todas tus reglas', t: s => streak(s.trades, t => !ruleBroken(t)) >= 20 },
  { id: 'stoic', i: '🧘', n: 'Estoico', d: 'Una pérdida con todas las reglas cumplidas y la lección escrita', t: s => s.trades.some(t => t.pnl < 0 && !ruleBroken(t) && (t.review || '').length >= 20) },
  { id: 'sniper', i: '🎯', n: 'Francotirador', d: 'Un trade de +3R o más', t: s => s.trades.some(t => (derive(t).R || 0) >= 3) },
  { id: 'pf15', i: '📈', n: 'Ventaja real', d: 'Profit factor ≥ 1.5 con 30+ trades', t: s => s.n >= 30 && s.pf >= 1.5 },
  { id: 'pf2', i: '💎', n: 'Edge de élite', d: 'Profit factor ≥ 2 con 50+ trades', t: s => s.n >= 50 && s.pf >= 2 },
  { id: 'dd10', i: '🏰', n: 'Fortaleza', d: '50+ trades con drawdown máximo < 10%', t: s => s.n >= 50 && s.maxDDpct < 0.10 },
  { id: 'green', i: '🌱', n: 'Mes verde', d: 'Un mes en positivo con 10+ trades', t: s => Object.values(s.months).some(m => m.n >= 10 && m.pnl > 0) },
  { id: 'green3', i: '🌳', n: 'Consistencia', d: '3 meses seguidos en positivo', t: s => { let c = 0, mx = 0; Object.keys(s.months).sort().forEach(k => { c = s.months[k].pnl > 0 ? c + 1 : 0; mx = Math.max(mx, c); }); return mx >= 3; } },
  { id: 'days7', i: '📅', n: 'Hábito', d: 'Registros en 7 días distintos', t: s => s.tradingDays >= 7 },
  { id: 'days30', i: '🗓️', n: 'Rutina profesional', d: 'Registros en 30 días distintos', t: s => s.tradingDays >= 30 },
  { id: 'focus', i: '🔬', n: 'Especialista', d: '30+ trades y 80% en tus 2 pares principales', t: s => { if (s.n < 30) return false; const g = groupBy(s.trades, t => t.pair).sort((a, b) => b.n - a.n); return ((g[0]?.n || 0) + (g[1]?.n || 0)) / s.n >= 0.8; } },
];
function streak(ts, ok) { let c = 0, m = 0; ts.forEach(t => { c = ok(t) ? c + 1 : 0; m = Math.max(m, c); }); return m; }
const levelFromXP = xp => Math.floor(Math.sqrt(xp / 30)) + 1;
const xpForLevel = l => 30 * (l - 1) ** 2;
const RANKS = [[1, 'Huevo'], [2, 'Aprendiz'], [5, 'Trader en formación'], [10, 'Trader disciplinado'], [15, 'Semi-profesional'], [20, 'Profesional'], [30, 'Leyenda del mercado']];
function game(stats) {
  const unlocked = BADGES.filter(b => b.t(stats));
  const xp = stats.trades.reduce((a, t) => a + tradeXP(t), 0) + unlocked.length * 50;
  const level = stats.n ? levelFromXP(xp) : 1;
  const rank = stats.n ? [...RANKS].reverse().find(r => level >= r[0])[1] : 'Huevo';
  // HP: disciplina + diario de los últimos 10, menos trades sin revisar
  let hp = 60;
  const last = stats.trades.slice(-10);
  const pendingList = stats.trades.filter(t => completeness(t) < 1);
  if (last.length) {
    const d = last.reduce((a, t) => a + discipline(t), 0) / last.length;
    const j = last.reduce((a, t) => a + completeness(t), 0) / last.length;
    hp = 100 * (0.55 * d + 0.45 * j);
    const stale = stats.trades.filter(t => (t.review || '').length < 20 && Date.now() - new Date(t.closeDate || t.date) > 864e5).length;
    hp -= Math.min(30, stale * 5);
  }
  hp = Math.max(0, Math.min(100, Math.round(hp)));
  const mood = hp >= 75 ? 'happy' : hp >= 50 ? 'ok' : hp >= 25 ? 'sad' : 'sick';
  const lastAt = stats.trades.length ? Math.max(...stats.trades.map(t => +new Date(t.closeDate || t.date))) : 0;
  const idleDays = lastAt ? (Date.now() - lastAt) / 864e5 : 0;
  const stage = !stats.n ? 'egg' : level < 5 ? 'baby' : level < 10 ? 'teen' : level < 20 ? 'adult' : 'legend';
  return { unlocked, xp, level, rank, hp, mood, stage, idleDays, pendingList };
}

// ---------- Pet sprite (pixel art original: un espíritu-vela japonesa) ----------
const SPRITES = {
  egg: ['................', '......kkkk......', '....kkwwwwkk....', '...kwwwwwwwwk...', '..kwwwbwwwwwwk..', '..kwwwwwwwbwwk..', '.kwwbbwwwwwwwwk.', '.kwwwwwwbbwwwwk.', '.kwwwwwwwwwwbwk.', '.kwbwwwwwwwwwwk.', '.kwwwwwbbwwwwwk.', '..kwwwwwwwwbwk..', '..kwwwwwwwwwwk..', '...kkwwwwwwkk...', '.....kkkkkk.....'],
  baby: ['........y.......', '.......yoy......', '.......yy.......', '.......k........', '.....kkkkkk.....', '....kbbbbbbk....', '....kbwpbwpk....', '....kbbbbbbk....', '....kcbmmbck....', '....kbbbbbbk....', '....kdbbbbdk....', '....kddddddk....', '.....kkkkkk.....', '.......k........', '......kkk.......'],
  teen: ['.......y........', '......yoy.......', '......yooy......', '.......yy.......', '.......k........', '....kkkkkkkk....', '...kbbbbbbbbk...', '...kbwpbbwpbk...', '...kbwwbbwwbk...', '.kkkcbbmmbbckkk.', '.kbkbbbbbbbbkbk.', '..kkbbbbbbbbkk..', '...kdbbbbbbdk...', '...kddddddddk...', '....kkkkkkkk....', '.......kk.......', '......kkkk......'],
  adult: ['.......yy.......', '......yooy......', '.....yoooy......', '......yooy......', '.......yy.......', '.......kk.......', '...kkkkkkkkkk...', '..kbbbbbbbbbbk..', '..kbbwpbbwpbbk..', '..kbbwwbbwwbbk..', 'kkkbcbbmmbbcbkkk', 'kbkbbbbbbbbbbkbk', '.kkbbbbbbbbbbkk.', '..kdbbbbbbbbdk..', '..kdbbbbbbbbdk..', '..kddddddddddk..', '...kkkkkkkkkk...', '.......kk.......', '......kkkk......'],
  legend: ['.s.....yy.....s.', '......yooy......', '..s..yoooy...s..', '......yooy......', '.......yy.......', '....g..g..g.....', '...kgggggggggk..', '..kbbbbbbbbbbk..', '..kbbwpbbwpbbk..', '..kbbwwbbwwbbk..', 'kkkbcbbmmbbcbkkk', 'kbkbbbbbbbbbbkbk', '.kkbbbbbbbbbbkk.', '..kdbbbbbbbbdk..', '..kdbbbbbbbbdk..', '..kddddddddddk..', '...kkkkkkkkkk...', '.......kk.......', '......kkkk......'],
};
const MOOD_COL = { happy: ['#3ddc84', '#1f9e5a'], ok: ['#f5c542', '#c9971c'], sad: ['#ff6b6b', '#b83236'], sick: ['#8a8f98', '#5c6068'] };
let flameTick = 0;
function drawPet(stage, mood) {
  const c = $('#pet-canvas'), x = c.getContext('2d');
  const sp = SPRITES[stage]; const H = sp.length, W = 16, px = Math.floor(Math.min(200 / W, 190 / H));
  c.width = W * px; c.height = H * px;
  const [b, d] = MOOD_COL[mood];
  const flick = flameTick % 2;
  const col = { k: '#141420', w: stage === 'egg' ? '#f4efe1' : '#ffffff', p: '#141420', b, d, c: '#ff9ab3', y: flick ? '#ffd23f' : '#ffb13f', o: flick ? '#ff7a1a' : '#ffe14d', g: '#ffd23f', s: flick ? '#ffffff' : 'transparent', m: mood === 'happy' || mood === 'ok' ? '#141420' : d };
  if (stage === 'egg') col.b = '#c9b98f';
  x.clearRect(0, 0, c.width, c.height);
  sp.forEach((row, yy) => [...row].forEach((ch, xx) => {
    if (ch === '.' || !col[ch] || col[ch] === 'transparent') return;
    let chh = ch;
    if ((mood === 'sad' || mood === 'sick') && ch === 'p' && yy % 2) chh = 'k';
    x.fillStyle = col[chh]; x.fillRect(xx * px, yy * px, px, px);
  }));
  // boca triste: invierte la "m"
  if (mood === 'sad' || mood === 'sick') {
    sp.forEach((row, yy) => [...row].forEach((ch, xx) => { if (ch === 'm') { x.fillStyle = col.b; x.fillRect(xx * px, yy * px, px, px); x.fillStyle = '#141420'; x.fillRect(xx * px, yy * px + px / 2, px, px / 2); } }));
  }
  const m = document.getElementById('m-pet-canvas');
  if (m) { m.width = c.width; m.height = c.height; const mx = m.getContext('2d'); mx.clearRect(0, 0, m.width, m.height); mx.drawImage(c, 0, 0); }
}
function petMessage(s, g) {
  const name = state.settings.petName;
  if (!s.n) return `¡Hola ${esc(state.settings.trader)}! Soy un huevo de vela 🕯️. Me alimento de <b>trades bien documentados</b>. Registra el primero y naceré.`;
  if (g.idleDays > 5) return `Zzz... llevo ${Math.floor(g.idleDays)} días sin datos. ¿Has operado sin apuntar? Cada trade sin registrar es un trade del que no aprendes.`;
  if (g.pendingList.length >= 3) return `Tengo hambre... hay <b>${g.pendingList.length} trades</b> con el diario incompleto. Falta la captura o la lección. ¡5 minutos y me pongo verde!`;
  const lastT = s.trades[s.trades.length - 1];
  if (lastT && ruleBroken(lastT)) return `Ay... el último trade rompió reglas de tu checklist. No pasa nada si lo anotas y aprendes. Los amateurs esconden sus errores; los profesionales los estudian.`;
  if (s.broke.n >= 3 && s.plan.n >= 3 && s.plan.net > s.broke.net) return `Dato: cuando sigues tus reglas llevas <b class="pos">${money(s.plan.net)}</b>. Cuando las rompes: <b class="neg">${money(s.broke.net)}</b>. Los números hablan solos.`;
  if (g.mood === 'happy') return `¡Me siento fuerte! Disciplina al ${pct(s.discipline, 0)} y diario al ${pct(s.journal, 0)}. Así es como trabaja un profesional. ${name} está orgullosa 💚`;
  if (g.mood === 'ok') return `Voy bien, pero puedo brillar más. Sube el nivel del diario: capturas ANTES y DESPUÉS + lección en cada trade.`;
  return `Me noto débil... mi HP depende de tu disciplina y de lo completo que esté tu diario. Revisa la lista de pendientes.`;
}
function quests(s) {
  const today = dayKey(new Date());
  const tt = s.trades.filter(t => dayKey(t.date) === today);
  const week = s.trades.filter(t => Date.now() - new Date(t.date) < 7 * 864e5);
  return [
    { t: 'Registra al menos un trade hoy (o anota que no hubo setup)', done: tt.length > 0, xp: 10 },
    { t: 'Todos los trades de hoy con captura ANTES y DESPUÉS', done: tt.length > 0 && tt.every(t => t.imgBefore && t.imgAfter), xp: 20 },
    { t: 'Todos los trades de hoy cumpliendo tu checklist', done: tt.length > 0 && tt.every(t => !ruleBroken(t)), xp: 25 },
    { t: 'Escribe la lección de cada trade de la semana', done: week.length > 0 && week.every(t => (t.review || '').length >= 20), xp: 10 },
    { t: 'Sin trades de revancha esta semana', done: week.length > 0 && !week.some(t => /Revancha/.test(t.emoBefore || '')), xp: 15 },
  ];
}

// ---------- Charts (motor propio, sin dependencias: funciona offline) ----------
// spec: { type:'line'|'bar', values:[], labels:[], color, colors?, light?, fmt?, fill? }
function mkChart(id, spec) {
  const el = document.getElementById(id); if (!el) return;
  state.charts[id] = spec; drawChart(el, spec);
}
function drawChart(el, spec) {
  const box = el.parentElement, W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  el.width = W * dpr; el.height = H * dpr; el.style.width = W + 'px'; el.style.height = H + 'px';
  const x = el.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
  const { values = [], labels = [], light, fmt = v => fx(v), color } = spec;
  const grid = light ? '#e3e3e3' : '#262a55', tick = light ? '#555' : '#8d91bd';
  x.font = '11px "IBM Plex Mono", monospace';
  if (!values.length) { x.fillStyle = tick; x.textAlign = 'center'; x.fillText('Sin datos todavía', W / 2, H / 2); return; }
  let lo = Math.min(...values), hi = Math.max(...values);
  if (spec.type === 'bar') lo = Math.min(0, lo);
  if (lo === hi) { const k = Math.abs(lo) * 0.05 || 1; lo -= k; hi += k; }
  const pad = (hi - lo) * 0.08; if (spec.type !== 'bar') lo -= pad; hi += pad;
  const yLabels = 5, ylw = Math.max(...Array.from({ length: yLabels }, (_, i) => x.measureText(fmt(lo + (hi - lo) * i / (yLabels - 1))).width));
  const L = ylw + 12, R = 10, T = 10, B = 24, cw = W - L - R, ch = H - T - B;
  const Y = v => T + ch - (v - lo) / (hi - lo) * ch;
  x.textAlign = 'right'; x.textBaseline = 'middle';
  for (let i = 0; i < yLabels; i++) {
    const v = lo + (hi - lo) * i / (yLabels - 1), yy = Math.round(Y(v)) + 0.5;
    x.strokeStyle = grid; x.lineWidth = 1; x.beginPath(); x.moveTo(L, yy); x.lineTo(W - R, yy); x.stroke();
    x.fillStyle = tick; x.fillText(fmt(v), L - 6, yy);
  }
  const n = values.length;
  x.textAlign = 'center'; x.textBaseline = 'top';
  if (spec.type === 'bar') {
    const bw = cw / n;
    values.forEach((v, i) => {
      x.fillStyle = spec.colors ? spec.colors[i] : color;
      const y0 = Y(0), y1 = Y(v); x.fillRect(L + i * bw + bw * 0.15, Math.min(y0, y1), bw * 0.7, Math.abs(y1 - y0));
      x.fillStyle = tick; x.fillText(labels[i] ?? '', L + i * bw + bw / 2, H - B + 6);
    });
    return;
  }
  const X = i => L + (n === 1 ? cw / 2 : i / (n - 1) * cw);
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(cw / 90))));
  for (let i = 0; i < n; i += step) { x.fillStyle = tick; x.fillText(labels[i] ?? '', X(i), H - B + 6); }
  // relleno
  if (spec.fill !== false) {
    const base = Y(Math.max(lo, Math.min(hi, spec.baseline ?? lo)));
    x.beginPath(); x.moveTo(X(0), base); values.forEach((v, i) => x.lineTo(X(i), Y(v))); x.lineTo(X(n - 1), base); x.closePath();
    x.fillStyle = color + '30'; x.fill();
  }
  if (spec.baseline != null) { const by = Y(spec.baseline); x.setLineDash([4, 4]); x.strokeStyle = tick; x.beginPath(); x.moveTo(L, by); x.lineTo(W - R, by); x.stroke(); x.setLineDash([]); }
  x.beginPath(); values.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v)));
  x.strokeStyle = color; x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
  if (n <= 60) values.forEach((v, i) => { x.fillStyle = color; x.fillRect(X(i) - 2, Y(v) - 2, 4, 4); });
}
function equityCfg(s, light) {
  return { type: 'line', values: s.equity.map(p => p.y), labels: s.equity.map(p => fmtDate(p.x)), color: light ? '#1f5fd1' : '#ffd23f', light, baseline: s.capital, fmt: v => Math.round(v).toLocaleString('es-ES') };
}
let resizeT; window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(redrawCharts, 150); });
function redrawCharts() { Object.entries(state.charts).forEach(([id, spec]) => { const el = document.getElementById(id); if (el && el.offsetParent) drawChart(el, spec); }); }

// ---------- Render ----------
function kpi(k, v, sub = '', c = '') { return `<div class="kpi"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${sub}</div></div>`; }
function render() {
  const s = computeStats(state.trades);
  const g = game(s);
  state.lastGame = state.lastGame || g;
  renderHome(s, g); renderMobile(s, g); renderJournal(); renderStats(s); renderBadges(s, g); renderReport();
  $$('.ccy').forEach(e => e.textContent = state.settings.ccy);
  // datalists
  const pairs = [...new Set([...PAIRS, ...state.trades.map(t => t.pair)])];
  $('#pairs').innerHTML = pairs.map(p => `<option value="${esc(p)}">`).join('');
  $('#setups').innerHTML = [...new Set([...SETUPS, ...state.trades.map(t => t.setup).filter(Boolean)])].map(p => `<option value="${esc(p)}">`).join('');
  const fp = $('#f-pair'), cur = fp.value;
  fp.innerHTML = '<option value="">Todos los pares</option>' + [...new Set(state.trades.map(t => t.pair))].sort().map(p => `<option>${esc(p)}</option>`).join('');
  fp.value = cur;
  // level-up / badge toasts
  const prev = state.lastGame;
  if (g.level > prev.level) toast(`⭐ ¡NIVEL ${g.level}! ⭐<br>${g.rank}`, 'lvl');
  g.unlocked.filter(b => !prev.unlocked.some(p => p.id === b.id)).forEach(b => toast(`${b.i} LOGRO: ${b.n}<br>+50 XP`));
  if (prev.stage !== g.stage && prev.stage) toast(`✨ ¡${state.settings.petName} ha evolucionado! ✨`, 'lvl');
  state.lastGame = g;
}

function renderHome(s, g) {
  $('#pet-name').textContent = state.settings.petName.toUpperCase();
  $('#pet-level').textContent = 'LV ' + g.level;
  $('#pet-rank').textContent = g.rank.toUpperCase();
  $('#hp-txt').textContent = g.hp + '/100';
  const hb = $('#hp-bar'); hb.style.width = g.hp + '%'; hb.style.background = MOOD_COL[g.mood][0];
  const cur = xpForLevel(g.level), nxt = xpForLevel(g.level + 1);
  $('#xp-txt').textContent = `${g.xp - cur}/${nxt - cur}`;
  $('#xp-bar').style.width = Math.min(100, (g.xp - cur) / (nxt - cur) * 100) + '%';
  $('#pet-stage').className = 'pet-stage mood-' + g.mood;
  $('#pet-zzz').classList.toggle('hidden', !(g.idleDays > 5));
  $('#pet-dialog').innerHTML = petMessage(s, g);
  state.pet = { stage: g.stage, mood: g.mood }; drawPet(g.stage, g.mood);

  $('#home-kpis').innerHTML = [
    kpi('Resultado neto', money(s.net), pct(s.ret, 2) + ' de la cuenta', cls(s.net)),
    kpi('Win rate', pct(s.winRate), `${s.wins}G / ${s.losses}P / ${s.be}BE`),
    kpi('Profit factor', fx(s.pf), 'ganancia bruta / pérdida bruta', s.pf >= 1 ? 'pos' : s.pf != null ? 'neg' : ''),
    kpi('Expectativa', fx(s.avgR) + 'R', money(s.expectancy) + ' por trade', cls(s.avgR)),
    kpi('Drawdown máx.', pct(s.maxDDpct), money(-s.maxDD, false), 'neg'),
  ].join('');
  mkChart('home-equity', equityCfg(s));

  $('#quests').innerHTML = quests(s).map(q => `<li class="${q.done ? 'done' : ''}"><span class="chk">${q.done ? '✓' : ''}</span><span class="t">${q.t}</span><span class="xp">+${q.xp}</span></li>`).join('');
  const pend = g.pendingList.slice(-8).reverse();
  $('#pending').innerHTML = pend.length ? pend.map(t => {
    const miss = [!t.imgBefore && 'captura antes', !t.imgAfter && 'captura después', (t.review || '').length < 20 && 'lección', (t.reason || '').length < 20 && 'motivo', !(t.emoBefore && t.emoAfter) && 'emociones'].filter(Boolean);
    return `<li data-edit="${t.id}"><b>${esc(t.pair)}</b> ${fmtDate(t.date)} <span class="muted">· falta: ${miss.join(', ')}</span></li>`;
  }).join('') : '<li class="muted">Nada pendiente. Diario al día 💚</li>';
}

const MOOD_TXT = { happy: '💚 Feliz y fuerte', ok: '💛 Bien, puede mejorar', sad: '❤️ Triste: revisa tus trades', sick: '🩶 Enferma: disciplina baja' };
function renderMobile(s, g) {
  const gi = goalInfo(s), [gt, gs] = goalText(gi);
  $('#m-pet-name').textContent = state.settings.petName.toUpperCase();
  $('#m-lvl').textContent = `LV ${g.level} · ${g.rank.toUpperCase()}`;
  const hb = $('#m-hp'); hb.style.width = g.hp + '%'; hb.style.background = MOOD_COL[g.mood][0];
  $('#m-mood').textContent = s.n ? MOOD_TXT[g.mood] : '🥚 Registra tu primer trade';
  $('#m-eq').textContent = money(s.finalEq, false);
  $('#m-pnl').innerHTML = `PNL <b class="${cls(s.net)}">${money(s.net)}</b> <span class="${cls(s.net)}">(${s.ret != null ? (s.ret > 0 ? '+' : '') + pct(s.ret, 1) : '—'})</span>`;
  [['m-goal-txt', 'm-goal-bar', 'm-goal-sub'], ['d-goal-txt', 'd-goal-bar', 'd-goal-sub']].forEach(([a, b, c]) => {
    $('#' + a).textContent = gt; $('#' + b).style.width = (gi ? gi.prog * 100 : 0) + '%'; $('#' + c).textContent = gs;
  });
  const cnt = { win: 0, sl: 0, loss: 0, be: 0 }; s.trades.forEach(t => cnt[outcome(t)]++);
  $('#m-wl').innerHTML = ['win', 'sl', 'loss', 'be'].map(k => `<div class="m-wl-i ${k}"><div class="m-wl-n">${cnt[k]}</div><div class="m-wl-l">${OUTCOME[k][0]} ${OUTCOME[k][1]}</div></div>`).join('');
  const last = s.trades.slice(-10).reverse();
  $('#m-last').innerHTML = last.length ? last.map(t => {
    const o = OUTCOME[outcome(t)];
    return `<div class="m-row" data-open="${t.id}"><span class="m-o">${o[0]}</span><div class="m-row-main"><b>${esc(t.pair)}</b> <span class="dir ${t.dir}">${t.dir === 'long' ? '▲' : '▼'}</span><br><small>${fmtDate(t.closeDate || t.date)} · ${o[1]}</small></div><b class="${cls(t.pnl)}">${money(t.pnl)}</b></div>`;
  }).join('') : '<div class="empty">Aún no hay trades. Pulsa + para registrar el primero.</div>';
}
function filteredTrades() {
  const p = $('#f-pair').value, r = $('#f-res').value, m = $('#f-month').value, q = $('#f-q').value.toLowerCase();
  return [...state.trades].filter(t => (!p || t.pair === p) && (!m || monthKey(t.date) === m)
    && (!r || (r === 'win' && t.pnl > 0) || (r === 'loss' && t.pnl < 0) || (r === 'plan' && !ruleBroken(t)) || (r === 'noplan' && ruleBroken(t)) || (r === 'incomplete' && completeness(t) < 1))
    && (!q || [t.pair, t.setup, t.reason, t.review, t.tags].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
function renderJournal() {
  const ts = filteredTrades();
  if (!ts.length) { $('#journal-list').innerHTML = '<div class="empty">No hay trades. Pulsa <b>+ Trade</b> para registrar el primero.</div>'; return; }
  const head = `<div class="trade-row head"><div>Fecha</div><div>Par</div><div>Dir.</div><div>R</div><div>Resultado</div><div class="hide-m">Setup</div><div class="hide-m">Disciplina · Diario</div><div>Capturas</div></div>`;
  $('#journal-list').innerHTML = head + ts.map(t => {
    const d = derive(t), di = discipline(t), co = completeness(t);
    return `<div class="trade-row" data-open="${t.id}">
      <div>${fmtDT(t.date)}</div><div><b>${esc(t.pair)}</b><br><span class="muted">${esc(t.tf || '')}</span></div>
      <div class="dir ${t.dir}">${t.dir === 'long' ? '▲ BUY' : '▼ SELL'}</div>
      <div class="${cls(d.R)}">${d.R != null ? fx(d.R) + 'R' : '—'}</div>
      <div class="${cls(t.pnl)}"><b>${money(t.pnl)}</b></div>
      <div class="hide-m">${esc(t.setup || '')} ${(t.emoBefore || '').split(' ')[0]}</div>
      <div class="hide-m"><div class="meter" title="Disciplina ${pct(di, 0)}"><div style="width:${di * 100}%;background:${di === 1 ? 'var(--green)' : 'var(--red)'}"></div></div><div class="meter" style="margin-top:3px" title="Diario ${pct(co, 0)}"><div style="width:${co * 100}%;background:var(--blue)"></div></div></div>
      <div class="thumbs">${['imgBefore', 'imgAfter'].map(k => t[k] && state.thumbs[t[k]] ? `<img src="${state.thumbs[t[k]]}">` : '<div class="ph"></div>').join('')}</div>
    </div>`;
  }).join('');
}

function breakdownTable(title, rows) {
  if (!rows.length) return '';
  const mx = Math.max(...rows.map(r => Math.abs(r.net)), 1);
  return `<div class="panel"><h3 class="pixel">${title}</h3><table class="tbl"><thead><tr><th></th><th class="r">Trades</th><th class="r">Win%</th><th class="r">PF</th><th class="r">R medio</th><th class="r">Neto</th><th></th></tr></thead><tbody>
  ${rows.map(r => `<tr><td>${esc(r.k)}</td><td class="r">${r.n}</td><td class="r">${pct(r.wr, 0)}</td><td class="r">${r.pf === Infinity ? '∞' : fx(r.pf)}</td><td class="r ${cls(r.avgR)}">${fx(r.avgR)}</td><td class="r ${cls(r.net)}">${money(r.net)}</td><td style="width:70px"><span class="hbar ${r.net < 0 ? 'neg' : ''}" style="width:${Math.abs(r.net) / mx * 60}px"></span></td></tr>`).join('')}
  </tbody></table></div>`;
}
const WD = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
function renderStats(s) {
  const hold = s.avgHold == null ? '—' : s.avgHold > 864e5 ? fx(s.avgHold / 864e5, 1) + ' d' : s.avgHold > 36e5 ? fx(s.avgHold / 36e5, 1) + ' h' : Math.round(s.avgHold / 6e4) + ' min';
  $('#stats-kpis').innerHTML = [
    kpi('Neto', money(s.net), pct(s.ret, 2), cls(s.net)), kpi('Trades', s.n, s.tradingDays + ' días operados'),
    kpi('Win rate', pct(s.winRate), `${s.wins}/${s.losses}/${s.be}`), kpi('Profit factor', s.pf === Infinity ? '∞' : fx(s.pf), '', s.pf >= 1 ? 'pos' : 'neg'),
    kpi('Expectativa', fx(s.avgR) + 'R', money(s.expectancy) + '/trade', cls(s.avgR)), kpi('R total', fx(s.totalR, 1) + 'R', s.rCount + ' trades con SL', cls(s.totalR)),
    kpi('Ganancia media', money(s.avgWin), 'Mayor: ' + money(s.best), 'pos'), kpi('Pérdida media', money(s.avgLoss), 'Mayor: ' + money(s.worst), 'neg'),
    kpi('Payoff', fx(s.payoff), 'gan. media / pérd. media'), kpi('Drawdown máx.', pct(s.maxDDpct), money(-s.maxDD, false), 'neg'),
    kpi('Recovery factor', fx(s.recovery), 'neto / DD máx.'), kpi('Sharpe', fx(s.sharpe), 'anualizado, días operados'),
    kpi('Rachas', `${s.maxW}🟢 ${s.maxL}🔴`, 'máx. ganadoras / perdedoras'), kpi('Duración media', hold, ''),
    kpi('Disciplina', pct(s.discipline, 0), 'cumplimiento checklist', s.discipline >= 0.8 ? 'pos' : 'neg'), kpi('Diario completo', pct(s.journal, 0), 'capturas, motivo, lección'),
    kpi('Capital actual', money(s.finalEq, false), 'inicial ' + money(s.capital, false)), kpi('Trades/día', s.tradingDays ? fx(s.n / s.tradingDays, 1) : '—', ''),
  ].join('');

  // insight
  const byPair = groupBy(s.trades, t => t.pair), bySes = groupBy(s.trades, t => session(t.date)), bySet = groupBy(s.trades, t => t.setup);
  const bits = [];
  if (s.n < 30) bits.push(`Llevas <b>${s.n}</b> trades. Con menos de 30 las estadísticas aún son ruido: sigue registrando hasta tener muestra.`);
  if (s.plan.n && s.broke.n) bits.push(`Con reglas cumplidas: <b>${s.plan.n}</b> trades, win rate ${pct(s.plan.wr, 0)}, neto <span class="${cls(s.plan.net)}">${money(s.plan.net)}</span>. Rompiendo reglas: <b>${s.broke.n}</b> trades, win rate ${pct(s.broke.wr, 0)}, neto <span class="${cls(s.broke.net)}">${money(s.broke.net)}</span>.`);
  const sigPair = byPair.filter(r => r.n >= 5), sigSes = bySes.filter(r => r.n >= 5), sigSet = bySet.filter(r => r.n >= 5 && r.k !== '—');
  if (sigPair.length > 1) bits.push(`Mejor par: <b>${esc(sigPair[0].k)}</b> (${money(sigPair[0].net)}). Peor: <b>${esc(sigPair.at(-1).k)}</b> (${money(sigPair.at(-1).net)}).`);
  if (sigSes.length > 1) bits.push(`Tu mejor sesión es <b>${sigSes[0].k}</b>; la peor <b>${sigSes.at(-1).k}</b>.`);
  if (sigSet.length > 1) bits.push(`Tu setup estrella: <b>${esc(sigSet[0].k)}</b> (R medio ${fx(sigSet[0].avgR)}). El que más te cuesta: <b>${esc(sigSet.at(-1).k)}</b>.`);
  $('#insight').innerHTML = '<h3 class="pixel">🔮 LO QUE DICEN TUS DATOS</h3>' + (bits.length ? bits.map(b => `<div>▸ ${b}</div>`).join('') : '<div class="muted">Registra trades para ver conclusiones.</div>');

  mkChart('ch-equity', equityCfg(s));
  mkChart('ch-dd', { type: 'line', values: [0, ...s.dd.map(p => p.y)], labels: [fmtDate(s.equity[0].x), ...s.dd.map(p => fmtDate(p.x))], color: '#ff5a5f', baseline: 0, fmt: v => v.toFixed(1) + '%' });
  // R histogram
  const bins = ['≤-2', '-2/-1', '-1/0', '0/1', '1/2', '2/3', '≥3'], cnt = Array(7).fill(0);
  s.trades.forEach(t => { const r = derive(t).R; if (r == null) return; const i = r <= -2 ? 0 : r < -1 ? 1 : r < 0 ? 2 : r < 1 ? 3 : r < 2 ? 4 : r < 3 ? 5 : 6; cnt[i]++; });
  mkChart('ch-r', { type: 'bar', values: cnt, labels: bins, colors: bins.map((_, i) => i < 3 ? '#ff5a5f' : '#3ddc84'), fmt: v => Math.round(v) });
  renderCalendar(s);
  $('#breakdowns').innerHTML = [
    breakdownTable('POR PAR', byPair), breakdownTable('POR SESIÓN (UTC)', bySes), breakdownTable('POR SETUP', bySet),
    breakdownTable('POR DÍA', groupBy(s.trades, t => WD[new Date(t.date).getDay()])),
    breakdownTable('POR DIRECCIÓN', groupBy(s.trades, t => t.dir === 'long' ? 'Compra' : 'Venta')),
    breakdownTable('POR EMOCIÓN AL ENTRAR', groupBy(s.trades, t => t.emoBefore || 'Sin registrar')),
    breakdownTable('POR TIMEFRAME', groupBy(s.trades, t => t.tf)),
    breakdownTable('POR CALIDAD DE EJECUCIÓN', groupBy(s.trades, t => t.rating ? '★'.repeat(t.rating) : 'Sin nota')),
  ].join('');
}
function renderCalendar(s) {
  if (!state.calMonth) { const last = s.trades.at(-1); state.calMonth = monthKey(last ? last.date : new Date()); }
  const [y, m] = state.calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate(), off = (first.getDay() + 6) % 7;
  let html = `<div class="cal-nav"><button class="btn sm" data-cal="-1">◀</button><b>${first.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}</b> <span class="${cls(s.months[state.calMonth]?.pnl)}">${money(s.months[state.calMonth]?.pnl ?? 0)}</span><button class="btn sm" data-cal="1">▶</button></div><div class="cal">`;
  html += ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => `<div class="dh">${d}</div>`).join('');
  for (let i = 0; i < off; i++) html += '<div class="d o"></div>';
  for (let d = 1; d <= days; d++) {
    const k = `${state.calMonth}-${String(d).padStart(2, '0')}`, v = s.days[k];
    html += `<div class="d ${v > 0 ? 'w' : v < 0 ? 'l' : ''}"><span class="n">${d}</span>${v != null ? `<span class="p ${cls(v)}">${Math.round(v)}</span>` : ''}</div>`;
  }
  $('#calendar').innerHTML = html + '</div>';
}

function renderBadges(s, g) {
  $('#badges').innerHTML = BADGES.map(b => `<div class="bdg ${g.unlocked.includes(b) ? 'on' : ''}"><div class="i">${b.i}</div><div class="n">${b.n}</div><div class="d">${b.d}</div></div>`).join('');
}

function renderReport() {
  const from = $('#r-from').value, to = $('#r-to').value;
  const ts = state.trades.filter(t => (!from || dayKey(t.date) >= from) && (!to || dayKey(t.date) <= to));
  // capital al inicio del periodo
  const before = state.trades.filter(t => from && dayKey(t.date) < from).reduce((a, t) => a + t.pnl, 0);
  const s = computeStats(ts, (+state.settings.capital || 0) + before);
  const st = state.settings;
  const period = s.n ? `${fmtDate(s.trades[0].date)} – ${fmtDate(s.trades.at(-1).date)}` : 'Sin datos';
  const years = [...new Set(Object.keys(s.months).map(k => k.slice(0, 4)))].sort();
  const M = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const monthTbl = `<table><thead><tr><th>Año</th>${M.map(x => `<th>${x}</th>`).join('')}<th>Total</th></tr></thead><tbody>${years.map(y => {
    let tot = 1; const cells = M.map((_, i) => { const mm = s.months[`${y}-${String(i + 1).padStart(2, '0')}`]; if (!mm) return '<td></td>'; const r = mm.startEq ? mm.pnl / mm.startEq : 0; tot *= 1 + r; return `<td class="${cls(r)}">${(r * 100).toFixed(1)}</td>`; }).join('');
    return `<tr><td>${y}</td>${cells}<td class="${cls(tot - 1)}"><b>${((tot - 1) * 100).toFixed(1)}%</b></td></tr>`;
  }).join('')}</tbody></table>`;
  const brk = (title, rows) => `<h2>${title}</h2><table><thead><tr><th></th><th>Trades</th><th>Win%</th><th>PF</th><th>R medio</th><th>Neto</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.k)}</td><td>${r.n}</td><td>${pct(r.wr, 0)}</td><td>${r.pf === Infinity ? '∞' : fx(r.pf)}</td><td>${fx(r.avgR)}</td><td class="${cls(r.net)}">${money(r.net)}</td></tr>`).join('')}</tbody></table>`;
  const rk = (k, v, c = '') => `<div><small>${k}</small><b class="${c}">${v}</b></div>`;
  $('#report').innerHTML = `
    <h1>Track Record — ${esc(st.trader)}</h1>
    <div class="sub">${esc(st.account)} · Periodo: ${period} · Divisa: ${esc(st.ccy)} · Generado ${new Date().toLocaleDateString('es-ES')}</div>
    <div class="rk">
      ${rk('Rentabilidad', pct(s.ret, 2), cls(s.ret))}${rk('Resultado neto', money(s.net), cls(s.net))}${rk('Drawdown máx.', pct(s.maxDDpct, 2), 'neg')}${rk('Ratio retorno/DD', s.maxDDpct ? fx(s.ret / s.maxDDpct) : '—')}
      ${rk('Nº operaciones', s.n)}${rk('Win rate', pct(s.winRate))}${rk('Profit factor', s.pf === Infinity ? '∞' : fx(s.pf))}${rk('Expectativa', fx(s.avgR) + ' R')}
      ${rk('Ganancia media', money(s.avgWin))}${rk('Pérdida media', money(s.avgLoss))}${rk('Payoff ratio', fx(s.payoff))}${rk('Sharpe (anualiz.)', fx(s.sharpe))}
      ${rk('Racha máx. perdedora', s.maxL)}${rk('Días operados', s.tradingDays)}${rk('Cumplimiento de reglas', pct(s.discipline, 0))}${rk('Trades documentados', pct(s.journal, 0))}
    </div>
    <h2>Curva de capital</h2><div class="chart-box"><canvas id="rep-equity"></canvas></div>
    <h2>Rentabilidad mensual (%)</h2>${monthTbl}
    <div class="cols"><div>${brk('Por instrumento', groupBy(s.trades, t => t.pair))}</div><div>${brk('Por sesión (UTC)', groupBy(s.trades, t => session(t.date)))}</div></div>
    <div class="cols"><div>${brk('Por setup', groupBy(s.trades, t => t.setup))}</div><div>
      <h2>Disciplina vs resultado</h2><table><thead><tr><th></th><th>Trades</th><th>Win%</th><th>Neto</th></tr></thead><tbody>
      <tr><td>Reglas cumplidas</td><td>${s.plan.n}</td><td>${pct(s.plan.wr, 0)}</td><td class="${cls(s.plan.net)}">${money(s.plan.net)}</td></tr>
      <tr><td>Reglas incumplidas</td><td>${s.broke.n}</td><td>${pct(s.broke.wr, 0)}</td><td class="${cls(s.broke.net)}">${money(s.broke.net)}</td></tr></tbody></table>
      <h2>Reglas de trading</h2><ol style="font-size:12px;line-height:1.6;padding-left:18px">${rulesList().map(r => `<li>${esc(r)}</li>`).join('')}</ol>
    </div></div>
    <div class="foot">Riesgo objetivo por operación: ${esc(st.riskPct)}%. R = (salida − entrada) / (entrada − stop). Sharpe calculado sobre retornos diarios de los días operados. Cada operación está documentada con motivo de entrada, capturas antes/después y revisión posterior.</div>`;
  mkChart('rep-equity', equityCfg(s, true));
}

// ---------- Form ----------
function fillSelects() {
  $$('select.emo').forEach(s => s.innerHTML = EMOTIONS.map(e => `<option value="${e}">${e || '—'}</option>`).join(''));
}
function renderRulesCheck(checked = []) {
  $('#rules-check').innerHTML = rulesList().map((r, i) => `<label class="rule"><input type="checkbox" name="rule" value="${esc(r)}" ${checked.includes(r) ? 'checked' : ''}> ${esc(r)}</label>`).join('');
}
function setStars(n) { $('[name=rating]').value = n; $('#stars').innerHTML = [1, 2, 3, 4, 5].map(i => `<span data-s="${i}" class="${i <= n ? 'on' : ''}">★</span>`).join(''); }
function setDir(v) { $('[name=dir]').value = v; $$('#dir-seg button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
function setSlot(slot, dataUrl) {
  state.form[slot] = dataUrl;
  const el = $(`.drop[data-slot=${slot}]`);
  el.style.backgroundImage = dataUrl ? `url(${dataUrl})` : '';
  el.classList.toggle('has', !!dataUrl);
  el.querySelector('.x')?.remove();
  if (dataUrl) { const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = 'X'; x.onclick = e => { e.stopPropagation(); setSlot(slot, null); updatePreview(); }; el.appendChild(x); }
  updatePreview();
}
function readForm() {
  const f = $('#trade-form'), v = n => f.elements[n].value;
  return {
    id: v('id') || uid(), pair: v('pair').toUpperCase().replace(/[^A-Z0-9]/g, ''), dir: v('dir'),
    date: v('date') ? new Date(v('date')).toISOString() : null, closeDate: v('closeDate') ? new Date(v('closeDate')).toISOString() : null,
    entry: num(v('entry')), sl: num(v('sl')), tp: num(v('tp')), exit: num(v('exit')), lots: num(v('lots')), pnl: num(v('pnl')) ?? 0,
    tf: v('tf'), setup: v('setup').trim(), reason: v('reason'), review: v('review'), emoBefore: v('emoBefore'), emoAfter: v('emoAfter'),
    rating: +v('rating') || 0, tags: v('tags'), rules: $$('[name=rule]:checked').map(c => c.value),
    imgBefore: state.form.imgBefore ? 'x' : null, imgAfter: state.form.imgAfter ? 'x' : null,
  };
}
function updatePreview() {
  const t = readForm(), d = derive(t);
  $('#xp-preview').textContent = `+${tradeXP(t)} XP`;
  const sesh = t.date ? session(t.date) : '—';
  const riskMoney = d.R && t.pnl ? Math.abs(t.pnl / d.R) : null;
  const riskPct = riskMoney && state.settings.capital ? riskMoney / state.settings.capital : null;
  $('#live-calc').innerHTML = `<span>Pips: <b>${fx(d.pips, 1)}</b></span><span>R: <b>${fx(d.R)}</b></span><span>R:R plan: <b>${d.plannedRR ? '1:' + fx(d.plannedRR, 1) : '—'}</b></span><span>Riesgo: <b>${fx(d.riskPips, 1)} pips${riskPct ? ' · ' + pct(riskPct, 2) : ''}</b></span><span>Sesión: <b>${sesh}</b></span>`
    + (riskPct && riskPct > state.settings.riskPct / 100 * 1.1 ? `<span class="neg">⚠ Riesgo por encima de tu objetivo (${state.settings.riskPct}%)</span>` : '');
}
async function compress(file) {
  const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  const img = await new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = url; });
  const max = 1800, k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
async function thumb(dataUrl) {
  const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = dataUrl; });
  const c = document.createElement('canvas'); c.width = 120; c.height = 80;
  const k = Math.max(120 / img.width, 80 / img.height); c.getContext('2d').drawImage(img, (120 - img.width * k) / 2, (80 - img.height * k) / 2, img.width * k, img.height * k);
  return c.toDataURL('image/jpeg', 0.7);
}
async function handleImageFile(file, slot) {
  if (!file || !file.type.startsWith('image/')) return;
  setSlot(slot, await compress(file));
  if (slot === 'imgBefore' && !state.form.imgAfter) state.form.activeSlot = 'imgAfter';
}
function resetForm(t) {
  const f = $('#trade-form'); f.reset();
  f.elements.id.value = t?.id || '';
  $('#form-title').textContent = t ? 'EDITAR TRADE' : 'NUEVO TRADE';
  f.elements.date.value = toLocalInput(t?.date || new Date());
  if (t) {
    ['pair', 'entry', 'sl', 'tp', 'exit', 'lots', 'pnl', 'tf', 'setup', 'reason', 'review', 'emoBefore', 'emoAfter', 'tags'].forEach(k => { if (t[k] != null) f.elements[k].value = t[k]; });
    if (t.closeDate) f.elements.closeDate.value = toLocalInput(t.closeDate);
  }
  setDir(t?.dir || 'long'); setStars(t?.rating || 0); renderRulesCheck(t?.rules || []);
  state.form = { imgBefore: null, imgAfter: null, activeSlot: 'imgBefore', edit: t };
  setSlot('imgBefore', null); setSlot('imgAfter', null);
  if (t) Promise.all(['imgBefore', 'imgAfter'].map(async k => t[k] && setSlot(k, await DB.get('images', t[k])))).then(updatePreview);
  updatePreview();
}
async function saveTrade(e) {
  e.preventDefault();
  const t = readForm(); const old = state.form.edit;
  if (!t.pair || !t.date) return toast('Falta el par o la fecha');
  for (const k of ['imgBefore', 'imgAfter']) {
    const data = state.form[k];
    if (old?.[k] && (!data || data !== await DB.get('images', old[k]))) { await DB.del('images', old[k]); delete state.thumbs[old[k]]; }
    if (data) {
      const existing = old?.[k] && await DB.get('images', old[k]);
      if (existing === data) { t[k] = old[k]; continue; }
      const id = uid(); await DB.put('images', data, id); t[k] = id; state.thumbs[id] = await thumb(data);
    } else t[k] = null;
  }
  t.createdAt = old?.createdAt || new Date().toISOString();
  await DB.put('trades', t);
  const i = state.trades.findIndex(x => x.id === t.id); if (i >= 0) state.trades[i] = t; else state.trades.push(t);
  toast(`✔ Trade guardado · +${tradeXP(t)} XP`);
  resetForm(); render(); go('home');
}

// ---------- Detail modal ----------
async function openTrade(id) {
  const t = state.trades.find(x => x.id === id); if (!t) return;
  const d = derive(t);
  const imgs = await Promise.all(['imgBefore', 'imgAfter'].map(k => t[k] ? DB.get('images', t[k]) : null));
  const brokenRules = rulesList().filter(r => !(t.rules || []).includes(r));
  $('#modal-card').innerHTML = `
    <div class="modal-head"><h2 class="pixel">${esc(t.pair)} <span class="dir ${t.dir}">${t.dir === 'long' ? '▲ BUY' : '▼ SELL'}</span> <span class="${cls(t.pnl)}">${money(t.pnl)}</span></h2>
      <div class="btn-row"><button class="btn sm" data-edit="${t.id}">✏ Editar</button><button class="btn sm danger" data-del="${t.id}">🗑 Borrar</button><button class="btn sm" data-close>✕</button></div></div>
    <div class="detail-grid">
      <div><small>Apertura</small>${fmtDT(t.date)}</div><div><small>Cierre</small>${fmtDT(t.closeDate)}</div><div><small>Sesión</small>${session(t.date)}</div><div><small>TF · Setup</small>${esc(t.tf)} · ${esc(t.setup || '—')}</div>
      <div><small>Entrada / Salida</small>${t.entry ?? '—'} → ${t.exit ?? '—'}</div><div><small>SL / TP</small>${t.sl ?? '—'} / ${t.tp ?? '—'}</div><div><small>Pips · R</small>${fx(d.pips, 1)} · <span class="${cls(d.R)}">${fx(d.R)}R</span></div><div><small>Lotes · XP</small>${t.lots ?? '—'} · +${tradeXP(t)}</div>
      <div><small>Emoción antes</small>${esc(t.emoBefore || '—')}</div><div><small>Emoción después</small>${esc(t.emoAfter || '—')}</div><div><small>Ejecución</small><span class="gold">${'★'.repeat(t.rating || 0)}</span>${'☆'.repeat(5 - (t.rating || 0))}</div><div><small>Disciplina</small><span class="${ruleBroken(t) ? 'neg' : 'pos'}">${pct(discipline(t), 0)}</span></div>
    </div>
    <div class="detail-imgs">${['ANTES', 'DESPUÉS'].map((l, i) => `<figure><figcaption>${l}</figcaption>${imgs[i] ? `<img src="${imgs[i]}" data-zoom>` : '<div class="empty">Sin captura</div>'}</figure>`).join('')}</div>
    <div class="small-title">Por qué entré</div><div class="text-block">${esc(t.reason || '—')}</div>
    <div class="small-title">Lección</div><div class="text-block lesson">${esc(t.review || '—')}</div>
    ${brokenRules.length ? `<div class="small-title neg">Reglas no cumplidas</div><div class="text-block" style="border-color:var(--red)">${brokenRules.map(esc).join('\n')}</div>` : ''}
    ${t.tags ? `<div>${t.tags.split(',').map(x => `<span class="pill">#${esc(x.trim())}</span>`).join('')}</div>` : ''}`;
  $('#modal').classList.remove('hidden');
}
const closeModal = () => $('#modal').classList.add('hidden');

// ---------- Misc ----------
function ask(msg, okText = 'Sí, continuar') {
  return new Promise(res => {
    const w = document.createElement('div'); w.className = 'modal ask';
    w.innerHTML = `<div class="modal-card ask-card"><p>${esc(msg)}</p><div class="btn-row"><button class="btn" data-a="0">Cancelar</button><button class="btn primary" data-a="1">${esc(okText)}</button></div></div>`;
    w.onclick = e => { const b = e.target.closest('[data-a]'); if (b || e.target === w) { w.remove(); res(!!b && b.dataset.a === '1'); } };
    document.body.appendChild(w); w.querySelector('[data-a="1"]').focus();
  });
}
function zoom(src) {
  const w = document.createElement('div'); w.className = 'modal zoom';
  w.innerHTML = `<img src="${src}" alt="Captura ampliada">`; w.onclick = () => w.remove();
  document.body.appendChild(w);
}
function toast(msg, k = '') { const d = document.createElement('div'); d.className = 'toast ' + k; d.innerHTML = msg; $('#toasts').appendChild(d); setTimeout(() => d.remove(), 3500); }
function go(tab) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  document.body.dataset.tab = tab;
  window.scrollTo(0, 0);
  requestAnimationFrame(redrawCharts);
}
async function editTrade(id) { closeModal(); resetForm(state.trades.find(t => t.id === id)); go('new'); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }

async function loadAll() {
  state.trades = await DB.all('trades') || [];
  const st = await DB.get('meta', 'settings'); if (st) state.settings = { ...DEFAULT_SETTINGS, ...st };
  for (const t of state.trades) for (const k of ['imgBefore', 'imgAfter']) if (t[k] && !state.thumbs[t[k]]) { const d = await DB.get('images', t[k]); if (d) state.thumbs[t[k]] = await thumb(d); }
}
function fillSettings() {
  const f = $('#settings-form'); Object.entries(state.settings).forEach(([k, v]) => { if (f.elements[k]) f.elements[k].value = v; });
}

// Demo: genera un historial realista para ver la app en acción
function demoChart(win, dir) {
  const c = document.createElement('canvas'); c.width = 900; c.height = 500; const x = c.getContext('2d');
  x.fillStyle = '#131722'; x.fillRect(0, 0, 900, 500);
  x.strokeStyle = '#1f2433'; for (let i = 0; i < 900; i += 60) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 500); x.stroke(); }
  let p = 250; const n = win === null ? 40 : 60;
  for (let i = 0; i < n; i++) {
    const trend = win === null ? 0 : (i > 40 ? (win ? -dir : dir) * -6 : 0);
    const o = p, cl = o + (Math.random() - 0.5) * 30 - trend, h = Math.min(o, cl) - Math.random() * 12, l = Math.max(o, cl) + Math.random() * 12;
    const X = 20 + i * 14; x.strokeStyle = x.fillStyle = cl < o ? '#26a69a' : '#ef5350';
    x.beginPath(); x.moveTo(X + 4, h); x.lineTo(X + 4, l); x.stroke(); x.fillRect(X, Math.min(o, cl), 9, Math.max(2, Math.abs(cl - o)));
    p = Math.max(60, Math.min(440, cl));
  }
  x.fillStyle = '#ffd23f'; x.font = '20px monospace'; x.fillText(win === null ? 'ENTRADA ▶' : 'RESULTADO', 20, 30);
  return c.toDataURL('image/jpeg', 0.7);
}
async function loadDemo() {
  if (state.trades.length && !await ask('Esto añadirá 80 trades de ejemplo a tus datos.', 'Añadir ejemplo')) return;
  const rules = rulesList(); const now = Date.now();
  const reasons = ['Rechazo limpio en resistencia H4 con envolvente bajista en M15, tendencia diaria bajista.', 'Pullback a EMA 50 en H1 a favor de tendencia, pin bar alcista de confirmación.', 'Ruptura del rango asiático con retesteo y cierre por encima.', 'Doble suelo en soporte diario, divergencia en RSI.'];
  const lessons = ['Ejecución correcta, dejé correr hasta TP. Repetir.', 'Entré antes del cierre de la vela, impaciencia. Esperar confirmación.', 'Pérdida aceptable, el setup era válido. Nada que cambiar.', 'Moví el SL a BE demasiado pronto y me sacó. Respetar el plan.'];
  for (let i = 0; i < 80; i++) {
    const pair = ['USDJPY', 'GBPJPY', 'USDJPY', 'GBPJPY', 'EURJPY', 'GBPUSD'][i % 6], dir = Math.random() > 0.5 ? 'long' : 'short', ps = pipSize(pair);
    const date = new Date(now - (80 - i) * 1.6 * 864e5); while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1); date.setUTCHours([1, 8, 9, 13, 14, 15, 17][i % 7], [0, 15, 30, 45][i % 4]);
    const disciplined = Math.random() > 0.25; const winP = disciplined ? 0.55 : 0.32;
    const win = Math.random() < winP; const riskP = 15 + Math.round(Math.random() * 20);
    const R = win ? 1 + Math.random() * (disciplined ? 2.5 : 1.2) : -(disciplined ? 1 : 1 + Math.random() * 0.8);
    const entry = pair.includes('JPY') ? 145 + Math.random() * 45 : 1.1 + Math.random() * 0.2;
    const d = dir === 'long' ? 1 : -1, sl = entry - d * riskP * ps, exit = entry + d * R * riskP * ps, tp = entry + d * 2 * riskP * ps;
    const pnl = Math.round(R * (+state.settings.capital || 500) * 0.02 * (1 + i / 40) * 100) / 100;
    const full = i > 30 || Math.random() > 0.5;
    const t = {
      id: uid(), pair, dir, date: date.toISOString(), closeDate: new Date(+date + (1 + Math.random() * 8) * 36e5).toISOString(),
      entry: +entry.toFixed(pair.includes('JPY') ? 3 : 5), sl: +sl.toFixed(5), tp: +tp.toFixed(5), exit: +exit.toFixed(5), lots: 0.5, pnl, tf: ['M15', 'H1', 'M15', 'H4'][i % 4],
      setup: SETUPS[i % 5], reason: reasons[i % 4], review: full ? lessons[win ? 0 : disciplined ? 2 : 1] : '',
      emoBefore: disciplined ? EMOTIONS[1 + (i % 3)] : EMOTIONS[4 + (i % 4)], emoAfter: full ? EMOTIONS[win ? 10 : 9] : '',
      rating: disciplined ? 4 + (win ? 1 : 0) : 2, tags: disciplined ? '' : 'impulsivo', rules: disciplined ? rules : rules.slice(0, 3), createdAt: new Date().toISOString(),
      imgBefore: null, imgAfter: null,
    };
    if (full && i % 2 === 0) for (const [k, w] of [['imgBefore', null], ['imgAfter', win]]) { const data = demoChart(w, d); const id = uid(); await DB.put('images', data, id); t[k] = id; state.thumbs[id] = await thumb(data); }
    await DB.put('trades', t); state.trades.push(t);
  }
  state.lastGame = null; render(); toast('🎲 Datos de ejemplo cargados');
}
async function exportJSON() {
  const images = {}; for (const k of await DB.keys('images')) images[k] = await DB.get('images', k);
  download(`candlequest-backup-${dayKey(new Date())}.json`, JSON.stringify({ version: 1, settings: state.settings, trades: state.trades, images }), 'application/json');
}
async function importJSON(file) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.trades)) return toast('Archivo no válido');
  if (!await ask(`¿Importar ${data.trades.length} trades? Se fusionarán con los actuales.`, 'Importar')) return;
  for (const [k, v] of Object.entries(data.images || {})) { await DB.put('images', v, k); }
  for (const t of data.trades) await DB.put('trades', t);
  if (data.settings) { state.settings = { ...DEFAULT_SETTINGS, ...data.settings }; await DB.put('meta', state.settings, 'settings'); }
  await loadAll(); fillSettings(); state.lastGame = null; render(); toast('✔ Copia importada');
}
function exportCSV() {
  const cols = ['date', 'closeDate', 'pair', 'dir', 'entry', 'sl', 'tp', 'exit', 'lots', 'pnl', 'tf', 'setup', 'emoBefore', 'emoAfter', 'rating', 'tags', 'reason', 'review'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [...state.trades].sort((a, b) => new Date(a.date) - new Date(b.date)).map(t => { const d = derive(t); return [...cols.map(c => q(t[c])), q(fx(d.pips, 1)), q(fx(d.R)), q(session(t.date)), q(pct(discipline(t), 0))].join(','); });
  download('candlequest-trades.csv', '﻿' + [...cols, 'pips', 'R', 'session', 'discipline'].join(',') + '\n' + rows.join('\n'), 'text/csv');
}

// ---------- Events ----------
function bind() {
  $('#tabs').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.tab === 'new' && !$('[name=id]').value) resetForm(); go(b.dataset.tab); };
  const f = $('#trade-form');
  f.addEventListener('input', updatePreview); f.addEventListener('change', updatePreview);
  f.onsubmit = saveTrade;
  $('#form-reset').onclick = () => resetForm();
  $('#dir-seg').onclick = e => { const b = e.target.closest('button'); if (b) { setDir(b.dataset.v); updatePreview(); } };
  $('#stars').onclick = e => { const s = e.target.dataset.s; if (s) { setStars(+s); updatePreview(); } };
  $$('.drop').forEach(d => {
    d.onclick = () => { state.form.activeSlot = d.dataset.slot; $('#file-pick').click(); };
    d.onmouseenter = d.onfocus = () => { state.form.activeSlot = d.dataset.slot; $$('.drop').forEach(x => x.classList.toggle('active', x === d)); };
    d.ondragover = e => { e.preventDefault(); d.classList.add('active'); };
    d.ondragleave = () => d.classList.remove('active');
    d.ondrop = e => { e.preventDefault(); d.classList.remove('active'); handleImageFile(e.dataTransfer.files[0], d.dataset.slot); };
  });
  $('#file-pick').onchange = e => { handleImageFile(e.target.files[0], state.form.activeSlot); e.target.value = ''; };
  document.addEventListener('paste', e => {
    if (!$('#tab-new').classList.contains('active')) return;
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return; e.preventDefault();
    let slot = state.form.activeSlot; if (state.form[slot] && !state.form[slot === 'imgBefore' ? 'imgAfter' : 'imgBefore']) slot = slot === 'imgBefore' ? 'imgAfter' : 'imgBefore';
    handleImageFile(item.getAsFile(), slot);
  });
  document.addEventListener('click', e => {
    const gg = e.target.closest('[data-go]');
    if (gg) { if (gg.dataset.go === 'new') resetForm(); return go(gg.dataset.go); }
    const o = e.target.closest('[data-open]'); if (o) return openTrade(o.dataset.open);
    const ed = e.target.closest('[data-edit]'); if (ed) return editTrade(ed.dataset.edit);
    const del = e.target.closest('[data-del]');
    if (del) {
      ask('¿Borrar este trade y sus capturas?', 'Borrar').then(ok => {
        if (!ok) return;
        const t = state.trades.find(x => x.id === del.dataset.del);
        ['imgBefore', 'imgAfter'].forEach(k => t[k] && DB.del('images', t[k]));
        DB.del('trades', t.id); state.trades = state.trades.filter(x => x !== t); closeModal(); render(); toast('Trade borrado');
      });
      return;
    }
    if (e.target.closest('[data-close]') || e.target.id === 'modal') return closeModal();
    if (e.target.matches('[data-zoom]')) return zoom(e.target.src);
    const cal = e.target.closest('[data-cal]');
    if (cal) { const [y, m] = state.calMonth.split('-').map(Number); const d = new Date(y, m - 1 + +cal.dataset.cal, 1); state.calMonth = monthKey(d); renderCalendar(computeStats(state.trades)); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); document.querySelectorAll('.modal.zoom,.modal.ask').forEach(m => m.remove()); } });
  ['#f-pair', '#f-res', '#f-month', '#f-q'].forEach(s => $(s).addEventListener('input', renderJournal));
  ['#r-from', '#r-to'].forEach(s => $(s).addEventListener('change', renderReport));
  $('#settings-form').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    Object.keys(DEFAULT_SETTINGS).forEach(k => { state.settings[k] = f.elements[k].value; });
    state.settings.capital = +state.settings.capital || 0; state.settings.riskPct = +state.settings.riskPct || 1;
    await DB.put('meta', state.settings, 'settings'); renderRulesCheck(); render(); toast('✔ Ajustes guardados');
  };
  $('#btn-export').onclick = exportJSON;
  $('#btn-csv').onclick = exportCSV;
  $('#btn-import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = e => e.target.files[0] && importJSON(e.target.files[0]);
  $('#btn-demo').onclick = loadDemo;
  $('#btn-wipe').onclick = async () => {
    if (!await ask('¿Borrar TODOS los trades y capturas? Exporta una copia antes.', 'Borrar todo')) return;
    await DB.clear('trades'); await DB.clear('images'); state.trades = []; state.thumbs = {}; state.lastGame = null; render(); toast('Datos borrados');
  };
  setInterval(() => { flameTick++; if (state.pet) drawPet(state.pet.stage, state.pet.mood); }, 450);
}

(async function init() {
  if (window.self !== window.top) document.body.classList.add('embedded');
  document.body.dataset.tab = 'home';
  await DB.open(); await loadAll();
  fillSelects(); fillSettings(); bind(); resetForm(); render();
})();
