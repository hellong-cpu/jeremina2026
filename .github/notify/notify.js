/* Jeremina push sender — run by GitHub Actions every ~5 minutes.
   Logs only counts, never names, titles or tokens (this repo is public). */
'use strict';
const L = require('./logic.js');
const APP_URL = 'https://hellong-cpu.github.io/jeremina2026/';

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('Secret FIREBASE_SERVICE_ACCOUNT is not set — nothing to do.'); return; }
  let cred; try { cred = JSON.parse(raw); } catch (e) { console.log('Secret is not valid JSON.'); process.exitCode = 1; return; }
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(cred) });
  const db = admin.firestore(), FV = admin.firestore.FieldValue;
  const now = Date.now(), J = L.jp(now);
  const stats = { spaces: 0, changed: 0, sent: 0, failed: 0, removed: 0 };

  const spaces = await db.collection('spaces').get();
  for (const sd of spaces.docs) {
    const space = sd.data() || {}, sid = sd.id;
    if (!Array.isArray(space.members) || !space.members.length) continue;
    stats.spaces++;
    const stRef = db.collection('pushState').doc(sid);
    const stSnap = await stRef.get();
    const first = !stSnap.exists;
    const st = first ? { known: {}, ev: {}, sent: {}, last: now, fullDay: '' } : stSnap.data();
    st.known = st.known || {}; st.ev = st.ev || {}; st.sent = L.prune(st.sent, now);
    const col = c => sd.ref.collection(c);

    /* Full read once a day (first run after 8 AM Japan time), or the very first time */
    const full = first || (st.fullDay !== J.day && J.h >= 8);
    const docs = {}; let todosAll = null;
    if (full) {
      for (const c of L.COLS) docs[c] = (await col(c).get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      todosAll = docs.todos;
      st.ev = {}; docs.events.forEach(e => { if (!e.deleted) st.ev[e.id] = L.evLite(e); });
      st.fullDay = J.day;
    } else {
      const since = (st.last || now) - 10 * 60e3; /* overlap covers phone clocks a bit off */
      for (const c of L.COLS) docs[c] = (await col(c).where('upd', '>', since).get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      docs.events.forEach(e => { if (e.deleted) delete st.ev[e.id]; else st.ev[e.id] = L.evLite(e); });
    }
    stats.changed += L.COLS.reduce((n, c) => n + docs[c].length, 0);

    let msgs = [];
    if (first) { /* learn what exists; don't announce old things */
      for (const c of L.COLS) { st.known[c] = {}; docs[c].forEach(x => { if (!x.deleted) st.known[c][x.id] = L.sig(c, x); }); }
    } else {
      msgs = L.diffChanges(space, st.known, docs, now - 24 * 3600e3);
    }

    /* Reminders */
    const needTodos = J.h >= 8 && J.h < 11 && !st.sent['am:' + J.day];
    if (needTodos && !todosAll) todosAll = (await col('todos').get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
    if (J.h >= 21 && !st.sent['pm:' + J.day] && !full) { /* fresh copy of events before the evening reminder */
      st.ev = {}; (await col('events').get()).docs.forEach(d => { const e = d.data(); if (!e.deleted) st.ev[d.id] = L.evLite(Object.assign({ id: d.id }, e)); });
    }
    const R = L.reminders(space, st.ev, todosAll, st.sent, now);
    for (const m of R.msgs) if (m.check) { /* make sure the event wasn't deleted */
      const ok = (await col('events').doc(m.check).get()).exists;
      if (!ok) { delete st.ev[m.check]; m.skip = true; }
    }
    msgs = msgs.concat(R.msgs.filter(m => !m.skip));
    R.keys.forEach(k => { st.sent[k] = now; });

    /* Who wants what */
    const push = {};
    for (const u of new Set(msgs.map(m => m.to))) {
      const p = await db.collection('users').doc(u).collection('meta').doc('push').get();
      push[u] = p.exists ? p.data() : null;
    }
    msgs = msgs.filter(m => { const P = push[m.to]; return P && P.tokens && Object.keys(P.tokens).length && L.prefsOf(P)[m.pref] !== false; });
    msgs = L.bundle(msgs, space);

    for (const m of msgs) {
      const toks = Object.entries(push[m.to].tokens || {}).filter(([, v]) => v && v.t);
      if (!toks.length) continue;
      const res = await admin.messaging().sendEach(toks.map(([, v]) => ({
        token: v.t,
        data: { title: m.title, body: m.body || '', tag: m.tag || '', url: APP_URL },
        webpush: { headers: { Urgency: 'high', TTL: '43200' } }
      })));
      const dead = {};
      res.responses.forEach((r, i) => {
        if (r.success) { stats.sent++; return; }
        stats.failed++;
        const code = r.error && r.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument') dead['tokens.' + toks[i][0]] = FV.delete();
      });
      if (Object.keys(dead).length) { stats.removed += Object.keys(dead).length; await db.collection('users').doc(m.to).collection('meta').doc('push').update(dead); Object.keys(dead).forEach(k => delete push[m.to].tokens[k.slice(7)]); }
    }

    st.last = now;
    await stRef.set(st);
  }
  console.log(`Done: ${stats.spaces} space(s), ${stats.changed} changed item(s), ${stats.sent} sent, ${stats.failed} failed, ${stats.removed} old device(s) removed.`);
}

main().catch(e => { console.log('Error:', (e && e.code) || (e && e.message ? String(e.message).slice(0, 120) : 'unknown')); process.exitCode = 1; });
