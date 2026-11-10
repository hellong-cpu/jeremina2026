/* Jeremina push notifications — pure logic (no Firebase). Japan time, no DST: UTC+9. */
'use strict';
const TZ_MS = 9 * 3600e3;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const PREF_DEF = { newEvent: true, newTask: true, newExpense: true, newPromise: true, morning: true, before1h: true, eveBefore: true, taskDone: true, signed: true };
const COLS = ['events', 'todos', 'buys', 'expenses', 'promises'];

const pad = n => (n < 10 ? '0' : '') + n;
const iso = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
const parse = s => { const p = String(s).split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; };
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const fromUtc = t => { const x = new Date(t); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const dow = (y, m, d) => new Date(utc(y, m, d)).getUTCDay();
const addDays = (s, n) => { const p = parse(s), r = fromUtc(utc(p.y, p.m, p.d) + n * 864e5); return iso(r.y, r.m, r.d); };
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const daysBetween = (a, b) => { const x = parse(a), y = parse(b); return Math.round((utc(y.y, y.m, y.d) - utc(x.y, x.m, x.d)) / 864e5); };
const md = s => { const p = parse(s); return MON[p.m - 1] + ' ' + p.d; };
const mdw = s => { const p = parse(s); return WD[dow(p.y, p.m, p.d)] + ', ' + MON[p.m - 1] + ' ' + p.d; };
const t12 = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return ((h % 12) || 12) + ':' + pad(m) + (h < 12 ? ' AM' : ' PM'); };
const yen = n => '¥' + Math.round(Number(n) || 0).toLocaleString('en-US');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/* "now" in Japan */
function jp(now) { const x = new Date(now + TZ_MS); return { day: iso(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()), h: x.getUTCHours(), min: x.getUTCMinutes() }; }
/* epoch ms of a Japan wall-clock date+time */
function jpAt(day, time) { const p = parse(day); const [h, m] = (time || '00:00').split(':').map(Number); return utc(p.y, p.m, p.d) + (h * 60 + m) * 60e3 - TZ_MS; }

/* ---- repeat rules: same engine as the apps ---- */
const weekIdx = t => { const p = parse(t); return Math.floor((utc(p.y, p.m, p.d) / 864e5 + 3) / 7); };
function evRule(e) {
  if (e.rr && e.rr.unit) return e.rr;
  const r = e.repeat || 'none', p = parse(e.date);
  if (r === 'daily') return { unit: 'day', every: 1 };
  if (r === 'weekly') return { unit: 'week', every: 1, days: [dow(p.y, p.m, p.d)] };
  if (r === 'monthly') return { unit: 'month', every: 1, mt: 'date' };
  if (r === 'yearly') return { unit: 'year', every: 1 };
  return null;
}
function ruleMatch(date, rr, s) {
  if (s < date) return false;
  if (rr.until && s > rr.until) return false;
  const a = parse(date), b = parse(s), n = Math.max(1, +rr.every || 1);
  if (rr.unit === 'day') return Math.round((utc(b.y, b.m, b.d) - utc(a.y, a.m, a.d)) / 864e5) % n === 0;
  if (rr.unit === 'week') { const ds = (rr.days && rr.days.length) ? rr.days : [dow(a.y, a.m, a.d)]; if (ds.indexOf(dow(b.y, b.m, b.d)) < 0) return false; return (weekIdx(s) - weekIdx(date)) % n === 0; }
  const mo = (b.y - a.y) * 12 + (b.m - a.m);
  if (rr.unit === 'month') {
    if (mo % n) return false;
    if (rr.mt === 'nth' || rr.mt === 'last') { if (dow(b.y, b.m, b.d) !== dow(a.y, a.m, a.d)) return false; return rr.mt === 'last' ? b.d + 7 > dim(b.y, b.m) : Math.ceil(b.d / 7) === Math.ceil(a.d / 7); }
    return b.d === Math.min(a.d, dim(b.y, b.m));
  }
  if (rr.unit === 'year') { if ((b.y - a.y) % n) return false; return b.m === a.m && b.d === Math.min(a.d, dim(b.y, b.m)); }
  return false;
}
/* Does an occurrence START on day s? (multi-day events remind once, on their first day) */
function startsOn(e, s) {
  if (!e || !isDate(e.date) || e.deleted) return false;
  if (s < e.date) return false;
  const rr = evRule(e);
  return rr ? ruleMatch(e.date, rr, s) : e.date === s;
}

/* Small copy of an event, kept in state so reminders don't need to read everything every 5 minutes */
function evLite(e) { const o = { date: e.date || '', time: e.time || '', title: String(e.title || '').slice(0, 80) }; if (e.repeat && e.repeat !== 'none') o.repeat = e.repeat; if (e.rr && e.rr.unit) o.rr = e.rr; return o; }

/* Signature of the parts we watch for changes */
function sig(col, x) {
  if (col === 'todos' || col === 'buys') return x.done ? 'd' : '';
  if (col === 'promises') return Object.keys(x.signs || {}).filter(u => x.signs[u] && x.signs[u].at).sort().join(',');
  return '';
}

/* People */
function nameOf(space, u) { const n = (space.nicks && space.nicks[u]) || (space.names && space.names[u]) || ''; return String(n).trim() || 'Your partner'; }
function others(space, u) { return (space.members || []).filter(m => m && m !== u); }
function firstLine(s) { return String(s || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || ''; }
function prTitle(p) { if (p.title) return p.title; const L = p.lists || {}; for (const k of Object.keys(L)) if ((L[k] || []).length) return L[k][0]; return firstLine(p.body) || 'Promise'; }
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/*
 Compare changed docs with what we knew → list of {to, pref, title, body, tag}.
 known: {col:{id:sig}}  docs: {col:[{id,...}]}  recentMs: only items created after this count as "new".
*/
function diffChanges(space, known, docs, recentMs) {
  const out = [];
  const send = (to, pref, title, body, tag) => to.forEach(u => out.push({ to: u, pref, title, body: cut(body, 160), tag }));
  for (const col of COLS) {
    const K = known[col] || (known[col] = {});
    for (const x of (docs[col] || [])) {
      if (!x || !x.id) continue;
      if (x.deleted) { delete K[x.id]; continue; }
      const had = Object.prototype.hasOwnProperty.call(K, x.id), was = had ? K[x.id] : null, now = sig(col, x);
      K[x.id] = now;
      const by = x.by || x.paidBy || x.from || '', who = nameOf(space, by), to = others(space, by);
      const created = +x.createdAt || +x.upd || 0;
      if (!had) {
        if (!by || created < recentMs) continue;
        if (col === 'events') send(to, 'newEvent', '📅 ' + who + ' added an event', x.title + (isDate(x.date) ? ' · ' + mdw(x.date) + (x.time ? ' ' + t12(x.time) : '') : ''), 'n' + x.id);
        else if (col === 'todos') send(to, 'newTask', '✅ ' + who + ' added a task', x.text + (isDate(x.due) ? ' · due ' + md(x.due) : ''), 'n' + x.id);
        else if (col === 'buys') send(to, 'newTask', '🛒 ' + who + ' added to Shopping', x.text + (x.note ? ' · ' + x.note : ''), 'n' + x.id);
        else if (col === 'expenses') {
          if (x.kind === 'settle') send(to, 'newExpense', '💸 ' + who + ' recorded a payment', yen(x.jpy) + (x.note ? ' · ' + x.note : ''), 'n' + x.id);
          else send(to, 'newExpense', '💴 ' + who + ' added an expense', (x.title || x.cat || 'Expense') + ' · ' + yen(x.jpy), 'n' + x.id);
        } else if (col === 'promises') {
          const need = to.filter(u => !(x.signs && x.signs[u] && x.signs[u].at));
          send(need, 'newPromise', '✍️ ' + who + ' wrote a promise — please sign', prTitle(x), 'n' + x.id);
        }
        continue;
      }
      if ((col === 'todos') && was !== 'd' && now === 'd' && x.doneBy) {
        send(others(space, x.doneBy), 'taskDone', '🎉 ' + nameOf(space, x.doneBy) + ' finished a task', x.text, 'd' + x.id);
      }
      if (col === 'promises' && now !== was) {
        const before = was ? was.split(',') : [], after = now ? now.split(',') : [];
        const fresh = after.filter(u => before.indexOf(u) < 0);
        const all = (space.members || []).length > 1 && (space.members || []).every(u => after.indexOf(u) >= 0);
        fresh.forEach(s => send(others(space, s), 'signed', all ? '🤍 Signed by both of you' : '🖊️ ' + nameOf(space, s) + ' signed the promise', prTitle(x), 's' + x.id));
      }
    }
  }
  return out;
}

/* Reminders. ev: {id:evLite}. todos: array or null. sent: {key:ms}. Returns {msgs, keys} */
function reminders(space, ev, todos, sent, now) {
  const J = jp(now), today = J.day, tomorrow = addDays(today, 1), msgs = [], keys = [];
  const members = (space.members || []).filter(Boolean);
  const list = day => Object.keys(ev).map(id => Object.assign({ id }, ev[id])).filter(e => startsOn(e, day)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const evTxt = e => (e.time ? t12(e.time) + ' ' : '') + e.title;

  /* 1 hour before (timed events, today or just after midnight) */
  for (const day of [today, tomorrow]) for (const e of list(day)) {
    if (!e.time) continue;
    const start = jpAt(day, e.time), key = 'h:' + e.id + ':' + day;
    if (now >= start - 60 * 60e3 && now < start && !sent[key]) {
      const mins = Math.max(1, Math.round((start - now) / 60e3));
      members.forEach(u => msgs.push({ to: u, pref: 'before1h', title: '⏰ ' + e.title, body: t12(e.time) + ' · in ' + (mins >= 55 ? '1 hour' : mins + ' min'), tag: key, check: e.id }));
      keys.push(key);
    }
  }
  /* 8 AM: today's summary */
  if (J.h >= 8 && J.h < 11 && !sent['am:' + today]) {
    keys.push('am:' + today);
    const evs = list(today);
    members.forEach(u => {
      const ts = (todos || []).filter(t => !t.done && !t.deleted && isDate(t.due) && t.due <= today && (!t.assignee || t.assignee === 'together' || t.assignee === u));
      if (!evs.length && !ts.length) return;
      const parts = [];
      if (evs.length) parts.push(evs.map(evTxt).join(' · '));
      if (ts.length) parts.push('Tasks: ' + ts.map(t => t.text).join(', '));
      const head = [evs.length ? evs.length + (evs.length > 1 ? ' events' : ' event') : '', ts.length ? ts.length + (ts.length > 1 ? ' tasks' : ' task') : ''].filter(Boolean).join(', ');
      msgs.push({ to: u, pref: 'morning', title: '☀️ Today · ' + head, body: cut(parts.join('\n'), 220), tag: 'am:' + today });
    });
  }
  /* 9 PM: tomorrow */
  if (J.h >= 21 && !sent['pm:' + today]) {
    keys.push('pm:' + today);
    const evs = list(tomorrow);
    if (evs.length) members.forEach(u => msgs.push({ to: u, pref: 'eveBefore', title: '🌙 Tomorrow · ' + evs.length + (evs.length > 1 ? ' events' : ' event'), body: cut(evs.map(evTxt).join(' · '), 220), tag: 'pm:' + today }));
  }
  return { msgs, keys };
}

/* Several notices for one person in one run → one combined notice */
function bundle(msgs, space) {
  const REM = { before1h: 1, morning: 1, eveBefore: 1 };
  const by = {}, out = [];
  msgs.forEach(m => { if (REM[m.pref]) out.push(m); else (by[m.to] = by[m.to] || []).push(m); });
  for (const u of Object.keys(by)) {
    const a = by[u];
    if (a.length <= 3) { out.push(...a); continue; }
    out.push({ to: u, pref: '', title: '🔔 ' + a.length + ' new updates', body: cut(a.map(m => m.body).filter(Boolean).join(' · '), 220), tag: 'bundle' });
  }
  return out;
}

function prune(sent, now) { const o = {}; for (const k of Object.keys(sent || {})) if (now - sent[k] < 4 * 864e5) o[k] = sent[k]; return o; }
function prefsOf(push) { return Object.assign({}, PREF_DEF, (push && push.prefs) || {}); }

module.exports = { COLS, PREF_DEF, jp, jpAt, addDays, startsOn, evLite, sig, diffChanges, reminders, bundle, prune, prefsOf, t12, mdw };
