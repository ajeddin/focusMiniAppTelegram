// The planner's data rules, with no DOM: the page uses window.FocusCodec, `bun miniapp/check.js` uses module.exports.
// Times are minutes from midnight of the planned day. Nothing here turns them into a clock time object.
(function (root) {
  "use strict";

  const PLAN_MAX = 16;
  const B64 = /^[A-Za-z0-9_-]*$/;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]; // day 0 of the epoch was a Thursday

  // ---- the URL: base64url (no padding) of compact JSON, as miniapp_pack in server.py
  function pack(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function unpack(s) {
    if (typeof s !== "string" || !s || !B64.test(s) || s.length % 4 === 1) throw new Error("bad data");
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("bad data");
    return obj;
  }

  function _param(str, lead) {
    if (!str) return null;
    for (const part of (str[0] === lead ? str.slice(1) : str).split("&")) {
      if (part.slice(0, 2) === "d=") return part.slice(2);
    }
    return null;
  }

  // `d` from the fragment (Telegram's tgWebApp… parameters may sit around it), else from the query string
  function readParam(hash, search) {
    const h = _param(hash, "#");
    return h !== null ? h : _param(search, "?");
  }

  function byteLen(s) {
    return new TextEncoder().encode(s).length;
  }

  // ---- times and days
  function fmt(m) {
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }

  function parseTime(s) {
    const r = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s));
    if (!r) return null;
    const h = +r[1], m = +r[2];
    if (h === 24 && m === 0) return 1440;
    return h < 24 && m < 60 ? h * 60 + m : null;
  }

  // "2026-11-06" -> "Fri Nov 6", by UTC arithmetic so no time zone can shift it
  function dayLabel(iso) {
    const [y, mo, d] = iso.split("-").map(Number);
    const days = Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
    return `${WEEKDAYS[((days % 7) + 7) % 7]} ${MONTHS[mo - 1]} ${d}`;
  }

  // ---- the plan
  function _sort(st) {
    st.blocks.sort((a, b) => a.start - b.start);
  }

  function planState(p) {
    const st = {
      day: p.d, head: p.h, rev: p.r, win: p.w, trim: p.x || 0,
      cal: (p.e || []).map(([start, end, title], k) => ({ k, start, end, title, gone: false })),
      blocks: (p.b || []).map(([start, end, title, on], i) => ({ i, start, end, title, title0: title, on: !!on })),
      prayers: (p.p || []).map(([start, end, title]) => ({ start, end, title })),   // busy, never deleted; older pages: none
      dirty: false,
    };
    _sort(st);
    return st;
  }

  function _changed(st) {
    _sort(st);
    st.dirty = true;
    return true;
  }

  function setTime(st, k, start, end) {
    Object.assign(st.blocks[k], { start, end });
    return _changed(st);
  }

  // a time input changed: only that end is rounded to 5 minutes; the other is kept exactly (10:07 stays 10:07)
  function editTime(start, end, which, value) {
    if (value === null || value === undefined) return [start, end];
    const v = Math.round(value / 5) * 5;
    return which === "start" ? [v, end] : [start, v];
  }

  function setTitle(st, k, title) {
    st.blocks[k].title = title;
    return _changed(st);
  }

  function toggle(st, k) {
    st.blocks[k].on = !st.blocks[k].on;
    return _changed(st);
  }

  // a calendar event marked for deletion (or kept again): it stops blocking and is sent back under x
  function toggleCal(st, k) {
    st.cal[k].gone = !st.cal[k].gone;
    st.dirty = true;
    return true;
  }

  const _live = (st) => st.cal.filter((e) => !e.gone);
  const _busy = (st) => _live(st).concat(st.prayers || []);   // calendar events you keep, and prayer times

  function remove(st, k) {
    st.blocks.splice(k, 1);
    return _changed(st);
  }

  // block k trades places with its neighbour: the earlier start is kept and the second follows the first
  function swap(st, k, dir) {
    const j = k + dir;
    if (j < 0 || j >= st.blocks.length || j === k) return false;
    const first = st.blocks[Math.max(k, j)], second = st.blocks[Math.min(k, j)];
    const s = Math.min(first.start, second.start), len1 = first.end - first.start, len2 = second.end - second.start;
    Object.assign(first, { start: s, end: s + len1 });
    Object.assign(second, { start: s + len1, end: s + len1 + len2 });
    return _changed(st);
  }

  function _hit(s, e, busy) {
    return busy.find((b) => s < b[1] && b[0] < e) || null;
  }

  // the first `minutes` in [from, to] that touch nothing busy; the same rule as plan_gap in server.py
  function firstGap(busy, minutes, from, to) {
    const cands = [...new Set([from, ...busy.map((b) => b[1])])].sort((a, b) => a - b);
    for (const c of cands) {
      const s = Math.max(from, Math.ceil(c / 5) * 5);
      if (s + minutes <= to && !_hit(s, s + minutes, busy)) return [s, s + minutes];
    }
    return null;
  }

  function add(st, title, minutes = 30) {
    if (st.blocks.length >= PLAN_MAX) return false;
    const busy = _busy(st).concat(st.blocks).map((b) => [b.start, b.end]);
    const g = firstGap(busy, minutes, st.win[0], st.win[1]);
    if (!g) return false;
    st.blocks.push({ i: -1, start: g[0], end: g[1], title, title0: null, on: true });
    return _changed(st);
  }

  // what stops a save, one reason per block that is on
  function problems(st) {
    const out = [];
    st.blocks.forEach((b, k) => {
      if (!b.on) return;
      let why = null;
      if (b.end < b.start) why = "Ends before it starts";
      else if (!String(b.title || "").trim()) why = "Needs a title";
      else if (b.end - b.start < 5) why = "Shorter than 5 minutes";
      else {
        const earlier = st.blocks.slice(0, k).filter((x) => x.on);
        const hit = _hit(b.start, b.end, _busy(st).concat(earlier).map((x) => [x.start, x.end, x.title]));
        if (hit) why = hit[2] ? `Overlaps “${hit[2]}”` : "Overlaps a calendar event";
      }
      if (why) out.push({ k, why });
    });
    return out;
  }

  function planOut(st) {
    const b = st.blocks.map((x) => {
      const row = [x.i, x.start, x.end, x.on ? 1 : 0];
      if (x.i === -1 || x.title !== x.title0) row.push(x.title);
      return row;
    });
    const x = st.cal.filter((e) => e.gone).map((e) => [e.start, e.end, e.title]);
    return JSON.stringify(x.length ? { t: "p", d: st.day, r: st.rev, b, x } : { t: "p", d: st.day, r: st.rev, b });
  }

  // ---- the benchmark
  function benchState(p) {
    const items = (p.i || []).map(([key, label, type, max]) => ({ key, label, type, max }));
    const vals = {}, orig = {}, wasted = {}, adj = {};
    for (const [day, row, w] of p.v || []) {
      vals[day] = {};
      orig[day] = {};
      items.forEach((it, n) => { vals[day][it.key] = orig[day][it.key] = row[n] === undefined ? null : row[n]; });
      wasted[day] = typeof w === "number" ? w : null; // null: the day's wasted time can't be changed here
      adj[day] = 0;
    }
    return { day: p.d, items, days: (p.v || []).map((r) => r[0]), vals, orig, wasted, adj };
  }

  // phone minutes on top of the day's wasted time: never below 0 in all, at most 600 added
  function benchAdj(st, day, by) {
    const w = st.wasted[day];
    if (w === null || w === undefined) return false;
    const next = Math.min(Math.max(st.adj[day] + by, -w), 600);
    if (next === st.adj[day]) return false;
    st.adj[day] = next;
    return true;
  }

  function benchSet(st, day, key, value) {
    st.vals[day][key] = value;
    return true;
  }

  // bench_step in server.py: minutes by 5 up to 600, counts by 1 up to max (999 when 0)
  function benchStep(type, value, up, max) {
    const minutes = type === "m" || type === "minutes";
    const n = minutes ? 5 : 1, top = minutes ? 600 : max || 999, v0 = value || 0;
    const v = up ? (Math.floor(v0 / n) + 1) * n : (Math.ceil(v0 / n) - 1) * n;
    return Math.min(Math.max(v, 0), top);
  }

  function benchOut(st) {
    const v = {};
    for (const day of st.days) {
      for (const it of st.items) {
        if (st.vals[day][it.key] !== st.orig[day][it.key]) (v[day] = v[day] || {})[it.key] = st.vals[day][it.key];
      }
    }
    const a = {};
    for (const day of st.days) if (st.adj && st.adj[day]) a[day] = st.adj[day];
    if (!Object.keys(v).length && !Object.keys(a).length) return null;
    return JSON.stringify(Object.keys(a).length ? { t: "b", v, a } : { t: "b", v });
  }

  const FocusCodec = {
    pack, unpack, readParam, byteLen, fmt, parseTime, dayLabel,
    planState, setTime, editTime, setTitle, toggle, toggleCal, remove, swap, firstGap, add, problems, planOut,
    benchState, benchSet, benchStep, benchAdj, benchOut,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = FocusCodec;
  else root.FocusCodec = FocusCodec;
})(typeof window !== "undefined" ? window : globalThis);
