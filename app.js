import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storageKey: "timealign-auth", persistSession: true, autoRefreshToken: true },
});
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ===================================================== state
const state = {
  user: null,
  areas: [],
  todos: [],            // master to-do list
  entries: [],          // last ~84 days + any running entry
  plan: [],             // today's plan_items
  settings: null,
  running: null,
  pick: { areaId: null, mode: "timer" },
  editId: null,
  todoEditId: null,
  personFilter: "",
  todoSort: "title",
  todoSearch: "",
  showDone: false,
  tick: null,
};

// ===================================================== helpers
const pad = (n) => String(n).padStart(2, "0");
const fmtDur = (min) => {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
};
const fmtClock = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};
const minutesOf = (e) => {
  const end = e.ended_at ? new Date(e.ended_at) : new Date();
  let ms = end - new Date(e.started_at) - (e.paused_ms || 0);
  if (e.paused_at && !e.ended_at) ms -= (Date.now() - new Date(e.paused_at)); // freeze while paused
  return Math.max(0, ms) / 60000;
};
const localDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a, b) => localDateStr(a) === localDateStr(b);
// Returns {text, cls} for a YYYY-MM-DD deadline, or null.
function dueLabel(due) {
  if (!due) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(due + "T00:00"); d.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (days < 0) return { text: `⚑ ${days === -1 ? "Yesterday" : Math.abs(days) + "d overdue"} · ${date}`, cls: "overdue" };
  if (days === 0) return { text: `⚑ Today · ${date}`, cls: "soon" };
  if (days === 1) return { text: `⚑ Tomorrow · ${date}`, cls: "soon" };
  if (days <= 3) return { text: `⚑ ${days}d · ${date}`, cls: "soon" };
  return { text: `⚑ ${date}`, cls: "" };
}
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function weekStartOf(date) {
  const ws = state.settings?.week_start ?? 1;       // 1=Mon, 0=Sun
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() - ws + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}
const areaById = (id) => state.areas.find((a) => a.id === id);
const hasTarget = (a) => a.target_pct != null && a.target_pct > 0;

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 1800);
}
function toastUndo(msg, undoFn) {
  const t = $("#toast");
  t.innerHTML = `<span></span><button class="toast-undo">Undo</button>`;
  t.querySelector("span").textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  t.querySelector(".toast-undo").onclick = () => {
    clearTimeout(toast._t); t.classList.add("hidden"); undoFn();
  };
  toast._t = setTimeout(() => t.classList.add("hidden"), 5000);
}
// Promise-based confirm dialog.
let _confirmResolve = null;
function askConfirm(message, okLabel = "Delete") {
  $("#confirm-msg").textContent = message;
  $("#confirm-ok").textContent = okLabel;
  $("#confirm").classList.remove("hidden");
  return new Promise((resolve) => { _confirmResolve = resolve; });
}
function settleConfirm(val) {
  $("#confirm").classList.add("hidden");
  if (_confirmResolve) { _confirmResolve(val); _confirmResolve = null; }
}
function fillAreaSelect(sel, selectedId) {
  sel.innerHTML = "";
  for (const a of state.areas) {
    const o = document.createElement("option");
    o.value = a.id; o.textContent = a.name;
    if (a.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

// ===================================================== scoring (targets optional → null treated as 0)
function allocation(entries) {
  const byArea = new Map();
  let total = 0;
  for (const e of entries) {
    const m = minutesOf(e);
    if (m <= 0) continue;
    byArea.set(e.area_id, (byArea.get(e.area_id) || 0) + m);
    total += m;
  }
  return { total, byArea };
}
function alignmentScore(entries) {
  const { total, byArea } = allocation(entries);
  if (total <= 0) return { score: null, total, byArea };
  let dev = 0;
  const ids = new Set([...byArea.keys(), ...state.areas.map((a) => a.id)]);
  for (const id of ids) {
    const actual = ((byArea.get(id) || 0) / total) * 100;
    const target = areaById(id)?.target_pct || 0;
    dev += Math.abs(actual - target);
  }
  return { score: Math.max(0, Math.min(100, 100 - dev / 2)), total, byArea };
}
const entriesInRange = (from, to) =>
  state.entries.filter((e) => { const s = new Date(e.started_at); return s >= from && s < to; });
function weekEntries(refDate = new Date()) {
  const start = weekStartOf(refDate);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  return { start, end, list: entriesInRange(start, end) };
}

// ===================================================== data
async function loadAll() {
  const uid = state.user.id;
  const since = new Date(); since.setDate(since.getDate() - 84);
  const planSince = new Date(); planSince.setDate(planSince.getDate() - 30);
  const today = localDateStr(new Date());
  const [areas, settings, entries, plan, todos] = await Promise.all([
    sb.from("areas").select("*").eq("archived", false).order("sort_order"),
    sb.from("settings").select("*").eq("user_id", uid).maybeSingle(),
    sb.from("entries").select("*").or(`started_at.gte.${since.toISOString()},ended_at.is.null`).order("started_at", { ascending: false }),
    sb.from("plan_items").select("*").gte("date", localDateStr(planSince)).order("date").order("sort_order"),
    sb.from("todos").select("*").eq("archived", false).order("title"),
  ]);
  state.areas = areas.data || [];
  state.settings = settings.data || { week_start: 1 };
  state.entries = entries.data || [];
  state.planHistory = plan.data || [];                       // last ~30 days of plans
  state.plan = state.planHistory.filter((p) => p.date === today);  // today's plan
  state.todos = todos.data || [];
  state.running = state.entries.find((e) => !e.ended_at) || null;
}

// Tasks planned on an earlier day whose to-do still isn't done and that aren't
// already in today's plan — surfaced so they aren't forgotten.
function carryForwardCandidates() {
  const today = localDateStr(new Date());
  const inToday = new Set(state.plan.map((p) => p.task.trim().toLowerCase()));
  const seen = new Set();
  const out = [];
  const past = (state.planHistory || []).filter((p) => p.date < today)
    .sort((a, b) => b.date.localeCompare(a.date));   // most recent first
  for (const p of past) {
    const key = p.task.trim().toLowerCase();
    if (seen.has(key) || inToday.has(key)) continue;
    const todo = p.todo_id ? state.todos.find((t) => t.id === p.todo_id) : todoByTitle(p.task);
    if (!todo || todo.done_at || todo.carry_silenced) continue;   // no live to-do, done, or silenced
    seen.add(key);
    out.push({ ...p, todo });
  }
  return out;
}

// ===================================================== render: TODAY
function render() {
  renderCarryForward();
  renderPlan();
  renderTimer();
  renderTodayList();
  renderPVA();
}

function relDay(dateStr) {
  const d = new Date(dateStr + "T00:00"); const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = Math.round((t - d) / 86400000);
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function renderCarryForward() {
  const card = $("#carry-card"), box = $("#carry-list");
  const cands = carryForwardCandidates();
  if (!cands.length) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  $("#carry-count").textContent = cands.length;
  box.innerHTML = "";
  for (const c of cands) {
    const a = areaById(c.area_id);
    const row = document.createElement("div");
    row.className = "plan-item";
    row.innerHTML = `<span class="dot" style="background:${a?.color || "#555"}"></span>
      <div class="body"><div class="title">${escapeHtml(c.task)}</div>
      <div class="sub">${a ? escapeHtml(a.name) : "No category"} · from ${relDay(c.date)}</div></div>
      <button class="iconaction cf-add" title="Add to today's plan">＋</button>
      <button class="iconaction cf-done" title="Mark done">✓</button>
      <button class="iconaction cf-silence" title="Silence — stop carrying forward">🔕</button>`;
    row.querySelector(".cf-add").onclick = () => carryToToday(c);
    row.querySelector(".cf-done").onclick = () => carryMarkDone(c);
    row.querySelector(".cf-silence").onclick = () => carrySilence(c);
    box.appendChild(row);
  }
}
async function carryToToday(c) {
  if (inTodayPlan(c.task)) { renderCarryForward(); return; }
  const { data, error } = await sb.from("plan_items").insert({
    user_id: state.user.id, date: localDateStr(new Date()), area_id: c.area_id,
    task: c.task, planned_min: c.planned_min, sort_order: state.plan.length + 1,
    todo_id: c.todo_id || null, persons: c.persons || [],
  }).select().single();
  if (error) return toast(error.message);
  state.plan.push(data); state.planHistory.push(data);
  renderPlan(); renderPVA(); renderCarryForward(); toast("Added to today");
}
async function carryAllToToday() {
  const cands = carryForwardCandidates();
  for (const c of cands) {
    if (inTodayPlan(c.task)) continue;
    const { data, error } = await sb.from("plan_items").insert({
      user_id: state.user.id, date: localDateStr(new Date()), area_id: c.area_id,
      task: c.task, planned_min: c.planned_min, sort_order: state.plan.length + 1,
      todo_id: c.todo_id || null, persons: c.persons || [],
    }).select().single();
    if (!error && data) { state.plan.push(data); state.planHistory.push(data); }
  }
  renderPlan(); renderPVA(); renderCarryForward(); toast("Added to today");
}
async function carrySilence(c) {
  const todo = c.todo;
  if (!todo) return;
  const { error } = await sb.from("todos").update({ carry_silenced: true }).eq("id", todo.id);
  if (error) return toast(error.message);
  todo.carry_silenced = true;
  renderCarryForward();
  toastUndo("Silenced — won't carry forward", async () => {
    await sb.from("todos").update({ carry_silenced: false }).eq("id", todo.id);
    todo.carry_silenced = false; renderCarryForward();
  });
}
async function carryMarkDone(c) {
  const todo = c.todo;
  if (!todo) return;
  if (!(await askConfirm(`Mark “${todo.title}” as done?`, "Mark done"))) return;
  const ts = new Date().toISOString();
  const { error } = await sb.from("todos").update({ done_at: ts }).eq("id", todo.id);
  if (error) return toast(error.message);
  todo.done_at = ts;
  renderCarryForward(); renderTodos(); toast("Marked done");
}

// ---------- start-of-day "due soon" prompt (today + tomorrow) ----------
function dueSoonCandidates() {
  const today = localDateStr(new Date());
  const t = new Date(); t.setDate(t.getDate() + 1);
  const tomorrow = localDateStr(t);
  const inToday = new Set(state.plan.map((p) => p.task.trim().toLowerCase()));
  return state.todos
    .filter((td) => td.due_date && !td.done_at &&
      (td.due_date === today || td.due_date === tomorrow) &&
      !inToday.has(td.title.trim().toLowerCase()))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.title.localeCompare(b.title));
}
function showDueAsk() {
  const today = localDateStr(new Date());
  const key = "ta-dueask-" + state.user.id;
  if (localStorage.getItem(key) === today) return;   // already prompted today
  const cands = dueSoonCandidates();
  if (!cands.length) return;
  const box = $("#dueask-list"); box.innerHTML = "";
  for (const td of cands) {
    const a = areaById(td.area_id), due = dueLabel(td.due_date);
    const row = document.createElement("label");
    row.className = "dueask-item";
    row.innerHTML = `<input type="checkbox" checked data-id="${td.id}" />
      <span class="dot" style="background:${a?.color || "#555"}"></span>
      <span class="da-title">${escapeHtml(td.title)}</span>
      <span class="due-badge ${due.cls}">${due.text}</span>`;
    box.appendChild(row);
  }
  $("#dueask").classList.remove("hidden");
}
function dismissDueAsk() {
  localStorage.setItem("ta-dueask-" + state.user.id, localDateStr(new Date()));
  $("#dueask").classList.add("hidden");
}
async function dueAskAdd() {
  const ids = [...document.querySelectorAll("#dueask-list input:checked")].map((i) => i.dataset.id);
  for (const id of ids) {
    const td = state.todos.find((x) => x.id === id);
    if (!td || inTodayPlan(td.title)) continue;
    const { data, error } = await sb.from("plan_items").insert({
      user_id: state.user.id, date: localDateStr(new Date()), area_id: td.area_id,
      task: td.title, planned_min: td.default_min || 0, sort_order: state.plan.length + 1,
      todo_id: td.id, persons: personsOf(td),
    }).select().single();
    if (!error && data) { state.plan.push(data); state.planHistory.push(data); }
  }
  dismissDueAsk();
  render();
  toast(ids.length ? "Added to today" : "Nothing selected");
}

function renderTimer() {
  const idle = $("#timer-idle"), run = $("#timer-running");
  clearInterval(state.tick);
  if (state.running) {
    idle.classList.add("hidden"); run.classList.remove("hidden");
    const a = areaById(state.running.area_id);
    const paused = !!state.running.paused_at;
    run.classList.toggle("paused", paused);
    $("#running-label").textContent = (paused ? "⏸ " : "") +
      ([a?.name, state.running.note].filter(Boolean).join(" · ") || "Tracking");
    $("#pause-timer").textContent = paused ? "▶ Resume" : "⏸ Pause";
    const upd = () => { $("#running-elapsed").textContent = fmtClock(Math.floor(minutesOf(state.running) * 60)); };
    upd();
    if (!paused) state.tick = setInterval(upd, 1000);   // frozen while paused
  } else {
    idle.classList.remove("hidden"); run.classList.add("hidden");
  }
}
async function pauseTimer() {
  if (!state.running || state.running.paused_at) return;
  const ts = new Date().toISOString();
  const { error } = await sb.from("entries").update({ paused_at: ts }).eq("id", state.running.id);
  if (error) return toast(error.message);
  state.running.paused_at = ts; renderTimer(); toast("Paused");
}
async function resumeTimer() {
  if (!state.running || !state.running.paused_at) return;
  const newMs = (state.running.paused_ms || 0) + (Date.now() - new Date(state.running.paused_at));
  const { error } = await sb.from("entries").update({ paused_ms: newMs, paused_at: null }).eq("id", state.running.id);
  if (error) return toast(error.message);
  state.running.paused_ms = newMs; state.running.paused_at = null; renderTimer(); toast("Resumed");
}

function renderTodayList() {
  const today = new Date();
  const list = state.entries
    .filter((e) => sameDay(new Date(e.started_at), today))
    .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const box = $("#today-list"); box.innerHTML = "";
  let total = 0;
  for (const e of list) {
    if (e.ended_at) total += minutesOf(e);
    const a = areaById(e.area_id);
    const t = new Date(e.started_at);
    const endTxt = e.ended_at ? new Date(e.ended_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "now";
    const sub = `${a?.name || "—"} · ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${endTxt}`;
    const dur = e.ended_at ? fmtDur(minutesOf(e)) : "running…";
    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `<div class="bar" style="background:${a?.color || "#555"}"></div>
      <div class="body"><div class="title">${e.note ? escapeHtml(e.note) : (a?.name || "—")}</div>
      <div class="sub">${sub}</div></div>
      <div class="dur">${dur}</div>
      <button class="iconaction edit" title="Edit">✎</button>`;
    row.querySelector(".edit").onclick = () => openEditor(e);
    box.appendChild(row);
  }
  if (!list.length) box.innerHTML = `<div class="empty">Nothing logged yet today.</div>`;
  $("#today-total").textContent = total ? `${fmtDur(total)} tracked` : "";
}

// ---------- plan ----------
function renderPlan() {
  const pa = $("#plan-area"); const prev = pa.value;
  pa.innerHTML = `<option value="">All categories</option>` +
    state.areas.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  pa.value = prev;   // preserve choice; "" (All) on first render
  fillPlanTodoOptions();
  const box = $("#plan-list"); box.innerHTML = "";
  let totalMin = 0;
  for (const pi of state.plan) {
    totalMin += pi.planned_min;
    const a = areaById(pi.area_id);
    const todo = pi.todo_id ? state.todos.find((t) => t.id === pi.todo_id) : todoByTitle(pi.task);
    const isDone = !!todo?.done_at;
    const row = document.createElement("div");
    row.className = "plan-item" + (isDone ? " is-done" : "");
    const lead = todo
      ? `<button class="done-toggle${isDone ? " done" : ""}" title="${isDone ? "Mark not done" : "Mark done"}">${isDone ? "✓" : ""}</button><span class="dot" style="background:${a?.color || "#555"}"></span>`
      : `<span class="dot" style="background:${a?.color || "#555"}"></span>`;
    row.innerHTML = `${lead}
      <div class="body"><div class="title${isDone ? " struck" : ""}">${escapeHtml(pi.task)}</div>
      <div class="sub">${a?.name || "—"} · ${pi.planned_min}m planned${personsOf(pi).length ? ` · <span class="person">👤 ${escapeHtml(personsOf(pi).join(", "))}</span>` : ""}</div></div>
      ${isDone ? "" : `<button class="iconaction play" title="Start timer">▶</button>`}
      <button class="iconaction del" title="Remove">✕</button>`;
    if (todo) row.querySelector(".done-toggle").onclick = () => toggleDone(todo);
    if (!isDone) row.querySelector(".play").onclick = () => startTimer(pi.area_id, pi.task, personsOf(pi));
    row.querySelector(".del").onclick = () => deletePlan(pi.id);
    box.appendChild(row);
  }
  if (!state.plan.length) box.innerHTML = `<div class="empty">No tasks planned yet. Add a few above.</div>`;
  $("#plan-total").textContent = totalMin ? `${fmtDur(totalMin)} planned` : "";
}

// ---------- planned vs actual ----------
function renderPVA() {
  const today = new Date();
  const todays = state.entries.filter((e) => sameDay(new Date(e.started_at), today) && e.ended_at);
  const actualByTask = new Map();
  for (const e of todays) {
    const k = (e.note || "").trim().toLowerCase();
    actualByTask.set(k, (actualByTask.get(k) || 0) + minutesOf(e));
  }
  const box = $("#pva"); box.innerHTML = "";
  if (!state.plan.length) { box.innerHTML = `<div class="empty">Plan some tasks to compare against what you actually did.</div>`; return; }

  const matched = new Set();
  const rows = state.plan.map((pi) => {
    const key = pi.task.trim().toLowerCase(); matched.add(key);
    return { pi, planned: pi.planned_min, actual: Math.round(actualByTask.get(key) || 0) };
  });
  let unplanned = 0;
  for (const [k, m] of actualByTask) if (k && !matched.has(k)) unplanned += m;
  const plannedTotal = rows.reduce((s, r) => s + r.planned, 0);
  const doneOnPlan = rows.reduce((s, r) => s + r.actual, 0);
  const pct = plannedTotal > 0 ? Math.min(100, Math.round(doneOnPlan / plannedTotal * 100)) : 0;
  const doneCount = rows.filter((r) => r.planned > 0 && r.actual >= r.planned).length;

  // ----- summary -----
  let html = `<div class="pva-summary">
    <div class="pva-sumtop"><span><b>${fmtDur(doneOnPlan)}</b> done of ${fmtDur(plannedTotal)} planned</span>
      <span class="pva-pct">${pct}%</span></div>
    <div class="track big"><div class="fill" style="width:${pct}%;background:var(--good)"></div></div>
    <div class="pva-meta muted small">${doneCount}/${rows.length} tasks done${Math.round(unplanned) >= 1 ? ` · ＋${fmtDur(unplanned)} unplanned` : ""}</div>
  </div><div class="pva-rows">`;

  // ----- per task -----
  for (const { pi, planned, actual } of rows) {
    const a = areaById(pi.area_id);
    let status, scls, w, col;
    if (planned > 0) {
      if (actual >= planned) { status = actual > planned ? `✓ done · +${fmtDur(actual - planned)}` : "✓ done"; scls = "met"; w = 100; col = "var(--good)"; }
      else if (actual > 0) { status = `${fmtDur(planned - actual)} left`; scls = "partial"; w = actual / planned * 100; col = a?.color || "var(--warn)"; }
      else { status = "not started"; scls = "none"; w = 0; col = "var(--line)"; }
    } else {
      status = actual > 0 ? `${fmtDur(actual)} done` : "—"; scls = actual > 0 ? "met" : "none"; w = actual > 0 ? 100 : 0; col = "var(--good)";
    }
    html += `<div class="pvarow">
      <div class="pvarow-top">
        <span class="pvarow-name"><span class="dot" style="background:${a?.color || "#777"}"></span>${escapeHtml(pi.task)}</span>
        <span class="pvarow-status ${scls}">${status}</span></div>
      <div class="track"><div class="fill" style="width:${w}%;background:${col}"></div></div></div>`;
  }
  box.innerHTML = html + `</div>`;
}

// ===================================================== entry actions
async function startTimer(areaId, note, persons = []) {
  if (state.running) { toast("Stop the running timer first"); return; }
  if (!areaId) { toast("Pick a category"); return; }
  if (!note || !note.trim()) { toast("Add a task name"); return; }
  const { data, error } = await sb.from("entries").insert({
    user_id: state.user.id, area_id: areaId, note: note.trim(), persons: persons || [],
    started_at: new Date().toISOString(), source: "timer",
  }).select().single();
  if (error) return toast(error.message);
  state.entries.unshift(data); state.running = data;
  render(); toast("Timer started");
}
async function stopTimer() {
  if (!state.running) return;
  const end = new Date().toISOString();
  const note = state.running.note;
  const patch = { ended_at: end };
  if (state.running.paused_at) {   // finalize any in-progress pause
    patch.paused_ms = (state.running.paused_ms || 0) + (Date.now() - new Date(state.running.paused_at));
    patch.paused_at = null;
  }
  const { error } = await sb.from("entries").update(patch).eq("id", state.running.id);
  if (error) return toast(error.message);
  Object.assign(state.running, patch); state.running = null;
  render(); toast("Saved");
  await maybeAskDone(note);
}
async function quickAdd(areaId, note, persons, startISO, endISO) {
  const { data, error } = await sb.from("entries").insert({
    user_id: state.user.id, area_id: areaId, note: note.trim(), persons: persons || [],
    started_at: startISO, ended_at: endISO, source: "quick_add",
  }).select().single();
  if (error) return toast(error.message);
  state.entries.unshift(data);
  render(); toast("Block added");
  await maybeAskDone(note);
}
// After logging time on a task that matches an existing to-do, offer to mark it done.
async function maybeAskDone(note) {
  const t = todoByTitle((note || "").trim());
  if (!t || t.done_at) return;
  if (await askConfirm(`Logged time on “${t.title}”. Mark it done?`, "Mark done")) {
    const ts = new Date().toISOString();
    const { error } = await sb.from("todos").update({ done_at: ts }).eq("id", t.id);
    if (error) return toast(error.message);
    t.done_at = ts; renderTodos(); toast("Marked done");
  }
}
async function deleteEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  if (!(await askConfirm("Delete this logged entry?"))) return;
  const { error } = await sb.from("entries").delete().eq("id", id);
  if (error) return toast(error.message);
  state.entries = state.entries.filter((x) => x.id !== id);
  if (state.running?.id === id) state.running = null;
  render(); refreshOpenReportDay();
  toastUndo("Entry deleted", async () => {
    const { data, error: e2 } = await sb.from("entries").insert({
      user_id: state.user.id, area_id: e.area_id, note: e.note, persons: e.persons || [],
      started_at: e.started_at, ended_at: e.ended_at, source: e.source,
    }).select().single();
    if (e2) return toast(e2.message);
    state.entries.unshift(data);
    state.running = state.entries.find((x) => !x.ended_at) || null;
    render(); refreshOpenReportDay();
  });
}

// ---------- to-do helpers ----------
const todoByTitle = (title) =>
  state.todos.find((t) => t.title.trim().toLowerCase() === title.trim().toLowerCase());
const inTodayPlan = (title) =>
  state.plan.some((p) => p.task.trim().toLowerCase() === title.trim().toLowerCase());

async function ensureTodo(title, areaId, min, persons = [], due = null) {
  const existing = todoByTitle(title);
  if (existing) return existing;
  const { data, error } = await sb.from("todos").insert({
    user_id: state.user.id, title: title.trim(), area_id: areaId || null,
    default_min: min || 0, persons: persons || [], due_date: due || null,
  }).select().single();
  if (error) { toast(error.message); return null; }
  state.todos.push(data);
  state.todos.sort((a, b) => a.title.localeCompare(b.title));
  return data;
}

// Narrow the task suggestions to the chosen category, so picking from a long
// list is easy: pick category → only its tasks suggest. Blank category = all.
function fillPlanTodoOptions() {
  const aid = $("#plan-area").value;
  const list = state.todos.filter((t) => !t.done_at && (!aid || t.area_id === aid));
  $("#todo-options").innerHTML = list.map((t) => `<option value="${escapeAttr(t.title)}">`).join("");
}

// When a to-do is picked in the plan box, prefill its category + minutes.
function onPlanTaskInput() {
  const t = todoByTitle($("#plan-task").value);
  if (!t) return;
  if (t.area_id) $("#plan-area").value = t.area_id;
  if (t.default_min && !Number($("#plan-min").value)) $("#plan-min").value = t.default_min;
}

// ---------- plan actions ----------
async function addPlanItem() {
  const task = $("#plan-task").value.trim();
  const areaId = $("#plan-area").value;
  const min = Number($("#plan-min").value) || 0;
  if (!task) return toast("Enter or pick a task");
  if (!areaId) return toast("Pick a category");
  let todo = todoByTitle(task);
  if (!todo) {   // new task — ask before adding it to the master To-Do list
    if (await askConfirm(`“${task}” isn't in your To-Do list. Add it there too?`, "Add to To-Do")) {
      todo = await ensureTodo(task, areaId, min, [], null);
      if (todo) toast(`“${todo.title}” added to your to-do list`);
    }
  }
  const { data, error } = await sb.from("plan_items").insert({
    user_id: state.user.id, date: localDateStr(new Date()), area_id: areaId,
    task, planned_min: min, sort_order: state.plan.length + 1,
    todo_id: todo?.id || null, persons: todo ? personsOf(todo) : [],
  }).select().single();
  if (error) return toast(error.message);
  state.plan.push(data);
  $("#plan-task").value = ""; $("#plan-min").value = "";
  renderPlan(); renderPVA(); renderTodos();
}

// ---------- people helpers ----------
// Parse a free-text field ("Pratik & Pooja, Rohan") into a clean list of names.
function parsePersons(str) {
  return [...new Set((str || "").split(/[,&;]+/).map((s) => s.trim()).filter(Boolean))];
}
const personsOf = (row) => (row && Array.isArray(row.persons) ? row.persons : []);

// ---------- to-do list management ----------
function distinctPersons() {
  const set = new Set();
  for (const t of state.todos) for (const p of personsOf(t)) if (p.trim()) set.add(p.trim());
  return [...set].sort((a, b) => a.localeCompare(b));
}
function renderPersonControls() {
  const persons = distinctPersons();
  $("#person-options").innerHTML = persons.map((p) => `<option value="${escapeAttr(p)}">`).join("");
  const sel = $("#todo-filter-person");
  if (sel) {
    sel.innerHTML = `<option value="">All people</option>` +
      persons.map((p) => `<option value="${escapeAttr(p)}"${p === state.personFilter ? " selected" : ""}>${escapeHtml(p)}</option>`).join("");
  }
}
function renderTodos() {
  fillAreaSelect($("#todo-area"));
  renderPersonControls();
  const box = $("#todo-list"); box.innerHTML = "";
  const doneCount = state.todos.filter((t) => t.done_at).length;
  $("#showdone-label").textContent = `Show done${doneCount ? ` (${doneCount})` : ""}`;
  let list = state.todos.filter((t) => !state.personFilter || personsOf(t).includes(state.personFilter));
  if (!state.showDone) list = list.filter((t) => !t.done_at);
  const q = state.todoSearch.trim().toLowerCase();
  if (q) list = list.filter((t) =>
    t.title.toLowerCase().includes(q) ||
    (areaById(t.area_id)?.name || "").toLowerCase().includes(q) ||
    personsOf(t).some((p) => p.toLowerCase().includes(q)));
  if (state.todoSort === "due") {
    // soonest deadline first; tasks without a deadline go last
    list = [...list].sort((a, b) =>
      (a.due_date || "9999-12-31").localeCompare(b.due_date || "9999-12-31") ||
      a.title.localeCompare(b.title));
  } else if (state.todoSort === "category") {
    list = [...list].sort((a, b) =>
      ((areaById(a.area_id)?.sort_order ?? 999) - (areaById(b.area_id)?.sort_order ?? 999)) ||
      a.title.localeCompare(b.title));
  }
  for (const t of list) {
    const a = areaById(t.area_id);
    const planned = inTodayPlan(t.title);
    const due = dueLabel(t.due_date);
    const ppl = personsOf(t);
    const sub = [a?.name || "No category", t.default_min ? t.default_min + "m" : null,
      ppl.length ? `👤 ${escapeHtml(ppl.join(", "))}` : null].filter(Boolean).join(" · ");
    const isDone = !!t.done_at;
    const row = document.createElement("div");
    row.className = "plan-item" + (isDone ? " is-done" : "");
    row.innerHTML = `<button class="done-toggle${isDone ? " done" : ""}" title="${isDone ? "Mark not done" : "Mark done"}">${isDone ? "✓" : ""}</button>
      <span class="dot" style="background:${a?.color || "#555"}"></span>
      <div class="body"><div class="title${isDone ? " struck" : ""}">${escapeHtml(t.title)}</div>
      <div class="sub">${sub}</div></div>
      ${due && !isDone ? `<span class="due-badge ${due.cls}">${due.text}</span>` : ""}
      <button class="iconaction edit" title="Edit">✎</button>
      ${isDone || planned
        ? (planned && !isDone ? `<span class="planned-badge" title="Already in today's plan">✓ Planned</span>` : "")
        : `<button class="iconaction toplan" title="Add to today's plan">＋</button>`}
      <button class="iconaction del" title="Remove">✕</button>`;
    row.querySelector(".done-toggle").onclick = () => toggleDone(t);
    row.querySelector(".edit").onclick = () => openTodoEditor(t);
    if (!isDone && !planned) row.querySelector(".toplan").onclick = () => addTodoToPlan(t);
    row.querySelector(".del").onclick = () => deleteTodo(t.id);
    box.appendChild(row);
  }
  if (!list.length) box.innerHTML = `<div class="empty">${q ? `No tasks match “${escapeHtml(state.todoSearch.trim())}”.` : state.personFilter ? "No tasks for this person." : "No tasks yet. Add them above or paste your list."}</div>`;
}
async function addTodo() {
  const title = $("#todo-new").value.trim();
  if (!title) return toast("Enter a task");
  if (todoByTitle(title)) { $("#todo-new").value = ""; return toast("Already on your list"); }
  const persons = parsePersons($("#todo-person").value);
  const due = $("#todo-due").value || null;
  const t = await ensureTodo(title, $("#todo-area").value, Number($("#todo-min").value) || 0, persons, due);
  if (!t) return;
  $("#todo-new").value = ""; $("#todo-min").value = ""; $("#todo-person").value = ""; $("#todo-due").value = "";
  renderTodos(); renderPlan();
  toast(`“${t.title}” added to your to-do list`);
}
// ---------- to-do editor ----------
function openTodoEditor(t) {
  state.todoEditId = t.id;
  $("#te-title").value = t.title;
  fillAreaSelect($("#te-area"), t.area_id);
  $("#te-person").value = personsOf(t).join(", ");
  $("#te-due").value = t.due_date || "";
  $("#te-min").value = t.default_min || "";
  $("#te-carry").checked = !t.carry_silenced;
  $("#todoedit").classList.remove("hidden");
}
function closeTodoEditor() { $("#todoedit").classList.add("hidden"); state.todoEditId = null; }
async function saveTodoEditor() {
  const t = state.todos.find((x) => x.id === state.todoEditId);
  if (!t) return closeTodoEditor();
  const title = $("#te-title").value.trim();
  if (!title) return toast("Task name required");
  const clash = state.todos.find((x) => x.id !== t.id && x.title.trim().toLowerCase() === title.toLowerCase());
  if (clash) return toast("Another task already has that name");
  const payload = {
    title, area_id: $("#te-area").value || null,
    persons: parsePersons($("#te-person").value), default_min: Number($("#te-min").value) || 0,
    due_date: $("#te-due").value || null, carry_silenced: !$("#te-carry").checked,
  };
  const oldTitle = t.title;
  const { data, error } = await sb.from("todos").update(payload).eq("id", t.id).select().single();
  if (error) return toast(error.message);
  Object.assign(t, data);
  if (oldTitle.trim().toLowerCase() !== title.trim().toLowerCase()) {
    await renameTaskEverywhere(oldTitle, title, t.id);   // propagate to plan items + logged entries
  }
  state.todos.sort((a, b) => a.title.localeCompare(b.title));
  closeTodoEditor(); render(); renderTodos(); refreshOpenReportDay(); toast("Saved");
}
// Propagate a to-do rename to its planned items and logged entries (and timeline/reports).
async function renameTaskEverywhere(oldTitle, newTitle, todoId) {
  const ol = oldTitle.trim().toLowerCase();
  for (const p of state.planHistory || []) {
    if (p.todo_id === todoId || (p.task || "").trim().toLowerCase() === ol) {
      if (p.task !== newTitle) {
        await sb.from("plan_items").update({ task: newTitle, todo_id: todoId }).eq("id", p.id);
        p.task = newTitle; p.todo_id = todoId;
      }
    }
  }
  for (const e of state.entries) {
    if ((e.note || "").trim().toLowerCase() === ol) {
      await sb.from("entries").update({ note: newTitle }).eq("id", e.id);
      e.note = newTitle;
    }
  }
}
async function deleteFromTodoEditor() {
  const id = state.todoEditId;
  closeTodoEditor();
  if (id) await deleteTodo(id);
}
async function addTodoToPlan(t) {
  if (state.plan.some((p) => p.task.trim().toLowerCase() === t.title.trim().toLowerCase())) {
    return toast("Already in today's plan");
  }
  const { data, error } = await sb.from("plan_items").insert({
    user_id: state.user.id, date: localDateStr(new Date()), area_id: t.area_id,
    task: t.title, planned_min: t.default_min || 0, sort_order: state.plan.length + 1,
    todo_id: t.id, persons: personsOf(t),
  }).select().single();
  if (error) return toast(error.message);
  state.plan.push(data);
  renderPlan(); renderPVA(); renderTodos(); toast("Added to today's plan");
}
async function toggleDone(t) {
  if (!t.done_at) {   // confirm only when marking done, to avoid accidental taps
    if (!(await askConfirm(`Mark “${t.title}” as done?`, "Mark done"))) return;
  }
  const newVal = t.done_at ? null : new Date().toISOString();
  const { error } = await sb.from("todos").update({ done_at: newVal }).eq("id", t.id);
  if (error) return toast(error.message);
  t.done_at = newVal;
  renderTodos(); renderPlan(); renderCarryForward();
  toast(newVal ? "Marked done" : "Marked not done");
}
async function deleteTodo(id) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return;
  if (!(await askConfirm(`Delete "${t.title}" from your to-do list?`))) return;
  const { error } = await sb.from("todos").update({ archived: true }).eq("id", id);
  if (error) return toast(error.message);
  state.todos = state.todos.filter((x) => x.id !== id);
  renderTodos(); renderPlan();
  toastUndo("Task deleted", async () => {
    const { error: e2 } = await sb.from("todos").update({ archived: false }).eq("id", id);
    if (e2) return toast(e2.message);
    state.todos.push(t);
    state.todos.sort((a, b) => a.title.localeCompare(b.title));
    renderTodos(); renderPlan();
  });
}
async function deletePlan(id) {
  const pi = state.plan.find((p) => p.id === id);
  if (!pi) return;
  if (!(await askConfirm(`Remove "${pi.task}" from today's plan?`, "Remove"))) return;
  const { error } = await sb.from("plan_items").delete().eq("id", id);
  if (error) return toast(error.message);
  state.plan = state.plan.filter((p) => p.id !== id);
  renderPlan(); renderPVA(); renderTodos();
  toastUndo("Removed from plan", async () => {
    const { data, error: e2 } = await sb.from("plan_items").insert({
      user_id: state.user.id, date: pi.date, area_id: pi.area_id, task: pi.task,
      planned_min: pi.planned_min, sort_order: pi.sort_order, todo_id: pi.todo_id,
    }).select().single();
    if (e2) return toast(e2.message);
    state.plan.push(data); renderPlan(); renderPVA(); renderTodos();
  });
}

// ===================================================== picker (start / past block)
function openPicker(mode) {
  state.pick = { areaId: null, mode };
  $("#picker-title").textContent = mode === "timer" ? "Start timer" : "Add a past block";
  $("#picker-confirm").textContent = mode === "timer" ? "Start" : "Add block";
  $("#picker-times").classList.toggle("hidden", mode === "timer");
  $("#picker-note").value = ""; $("#picker-person").value = "";
  renderPersonControls();
  // existing tasks to pick from (avoids duplicates) — active, not done
  $("#picker-todo-options").innerHTML = state.todos
    .filter((t) => !t.done_at).map((t) => `<option value="${escapeAttr(t.title)}">`).join("");
  if (mode === "quick") {
    const now = new Date(); const h = new Date(now - 30 * 60000);
    $("#pk-date").value = localDateStr(now);
    $("#pk-start").value = hhmm(h); $("#pk-end").value = hhmm(now);
  }
  const box = $("#picker-areas"); box.innerHTML = "";
  for (const a of state.areas) {
    const b = document.createElement("button");
    b.className = "pk-area"; b.dataset.aid = a.id;
    b.innerHTML = `<span class="dot" style="background:${a.color}"></span>${a.name}`;
    b.onclick = () => {
      $$(".pk-area", box).forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel"); state.pick.areaId = a.id; $("#picker-note").focus();
    };
    box.appendChild(b);
  }
  $("#picker").classList.remove("hidden");
}
// Picking an existing task in the picker auto-selects its category pill + fills people.
function onPickerNoteInput() {
  const t = todoByTitle($("#picker-note").value);
  if (!t) return;
  if (t.area_id) {
    const box = $("#picker-areas");
    $$(".pk-area", box).forEach((x) => x.classList.toggle("sel", x.dataset.aid === t.area_id));
    state.pick.areaId = t.area_id;
  }
  if (personsOf(t).length && !$("#picker-person").value.trim()) $("#picker-person").value = personsOf(t).join(", ");
}
function closePicker() { $("#picker").classList.add("hidden"); }
// Find an existing entry whose time interval overlaps [startISO, endISO).
function overlappingEntry(startISO, endISO, excludeId) {
  const s = +new Date(startISO), e = +new Date(endISO);
  return state.entries.find((en) => {
    if (en.id === excludeId) return false;
    const es = +new Date(en.started_at), ee = en.ended_at ? +new Date(en.ended_at) : Date.now();
    return s < ee && es < e;
  });
}
function fmtRange(en) {
  const f = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${f(new Date(en.started_at))}–${en.ended_at ? f(new Date(en.ended_at)) : "now"}`;
}
async function confirmPicker() {
  if (!state.pick.areaId) return toast("Pick a category");
  const note = $("#picker-note").value.trim();
  if (!note) return toast("Task is required");
  const persons = parsePersons($("#picker-person").value);
  if (state.pick.mode === "timer") {
    startTimer(state.pick.areaId, note, persons);
  } else {
    const date = $("#pk-date").value || localDateStr(new Date());
    const s = new Date(`${date}T${$("#pk-start").value || "00:00"}`);
    const e = new Date(`${date}T${$("#pk-end").value || "00:00"}`);
    if (e <= s) return toast("End must be after start");
    const ov = overlappingEntry(s.toISOString(), e.toISOString(), null);
    if (ov) {
      const a = areaById(ov.area_id);
      if (!(await askConfirm(`Overlaps “${ov.note || a?.name || "another task"}” (${fmtRange(ov)}). Add anyway?`, "Add anyway"))) return;
    }
    quickAdd(state.pick.areaId, note, persons, s.toISOString(), e.toISOString());
  }
  closePicker();
}

// ===================================================== editor (fix a logged/running entry)
function openEditor(e) {
  state.editId = e.id;
  $("#ed-task").value = e.note || "";
  fillAreaSelect($("#ed-area"), e.area_id);
  const s = new Date(e.started_at);
  $("#ed-date").value = localDateStr(s);
  $("#ed-start").value = hhmm(s);
  $("#ed-end").value = e.ended_at ? hhmm(new Date(e.ended_at)) : "";
  $("#editor").classList.remove("hidden");
}
function closeEditor() { $("#editor").classList.add("hidden"); state.editId = null; }
async function saveEditor() {
  const e = state.entries.find((x) => x.id === state.editId);
  if (!e) return closeEditor();
  const task = $("#ed-task").value.trim();
  if (!task) return toast("Task is required");
  const date = $("#ed-date").value;
  const startISO = new Date(`${date}T${$("#ed-start").value || "00:00"}`).toISOString();
  let endISO = null;
  if ($("#ed-end").value) {
    const end = new Date(`${date}T${$("#ed-end").value}`);
    if (end <= new Date(startISO)) return toast("End must be after start");
    endISO = end.toISOString();
  }
  if (endISO) {
    const ov = overlappingEntry(startISO, endISO, e.id);
    if (ov) {
      const a = areaById(ov.area_id);
      if (!(await askConfirm(`Overlaps “${ov.note || a?.name || "another task"}” (${fmtRange(ov)}). Save anyway?`, "Save anyway"))) return;
    }
  }
  const payload = { note: task, area_id: $("#ed-area").value, started_at: startISO, ended_at: endISO };
  const { data, error } = await sb.from("entries").update(payload).eq("id", e.id).select().single();
  if (error) return toast(error.message);
  Object.assign(e, data);
  state.running = state.entries.find((x) => !x.ended_at) || null;
  closeEditor(); render(); refreshOpenReportDay(); toast("Updated");
}
function refreshOpenReportDay() {
  if (!$("#view-reports").classList.contains("hidden") && state.reportDay) renderDayDetail(state.reportDay);
}
async function deleteFromEditor() {
  const id = state.editId;
  closeEditor();
  if (id) await deleteEntry(id);
}

// ===================================================== REPORTS
function renderReports() {
  renderHeatmap();
  renderDayDetail(localDateStr(new Date()));   // today's report by default
  $("#week-report").innerHTML = periodSummaryHTML(weekEntries().list, { withAlignment: true });
  $("#month-report").innerHTML = periodSummaryHTML(monthEntries(), { withAlignment: true });
  renderAnalysis();
  renderTrendLine();
}

function monthEntries() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return entriesInRange(from, to);
}

// Reusable summary block: total, alignment (optional), category bars, top tasks.
function periodSummaryHTML(rangeEntries, opts = {}) {
  const done = rangeEntries.filter((e) => e.ended_at);
  let total = 0; const byArea = new Map(); const byTask = new Map();
  for (const e of done) {
    const m = minutesOf(e); if (m <= 0) continue;
    total += m;
    const ak = areaById(e.area_id) ? e.area_id : "__none__";   // merge archived/unknown
    byArea.set(ak, (byArea.get(ak) || 0) + m);
    const k = (e.note || "").trim() || "(untitled)";
    byTask.set(k, (byTask.get(k) || 0) + m);
  }
  if (total <= 0) return `<div class="empty">No time logged.</div>`;
  let html = `<div class="rep-total">${fmtDur(total)} tracked</div>`;
  if (opts.withAlignment && state.areas.some(hasTarget)) {
    const { score } = alignmentScore(done);
    if (score != null) html += `<div class="muted small" style="margin:-4px 0 10px">Alignment ${Math.round(score)}/100 vs your targets</div>`;
  }
  const cats = [...byArea.entries()].map(([id, m]) => ({ a: areaById(id), m }))
    .filter((c) => Math.round(c.m) >= 1).sort((x, y) => y.m - x.m);
  const maxCat = cats[0].m;
  html += `<div class="rep-bars">`;
  for (const { a, m } of cats) {
    html += `<div class="repbar"><div class="repbar-top">
      <span><span class="dot" style="background:${a?.color || "#777"}"></span>${a ? escapeHtml(a.name) : "No category"}</span>
      <span class="muted">${fmtDur(m)} · ${Math.round(m / total * 100)}%</span></div>
      <div class="track"><div class="fill" style="width:${m / maxCat * 100}%;background:${a?.color || "#888"}"></div></div></div>`;
  }
  html += `</div>`;
  const tasks = [...byTask.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  html += `<div class="rep-sub">Most time on</div><ol class="rep-tasks">`;
  for (const [note, m] of tasks) html += `<li><span>${escapeHtml(note)}</span><span class="muted">${fmtDur(m)}</span></li>`;
  html += `</ol>`;
  return html;
}

function renderDayDetail(dateStr) {
  state.reportDay = dateStr;
  const d = new Date(dateStr + "T00:00"); const next = new Date(d); next.setDate(next.getDate() + 1);
  const head = `<div class="rep-dayhead">${d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</div>`;
  const entries = entriesInRange(d, next);
  const box = $("#day-detail");
  box.innerHTML = head + dayTimelineHTML(entries) + dayEntriesHTML(entries) + periodSummaryHTML(entries);
  box.querySelectorAll(".day-entries .edit").forEach((b) => {
    b.onclick = () => { const e = state.entries.find((x) => x.id === b.dataset.id); if (e) openEditor(e); };
  });
}
// Editable list of a day's entries (tap ✎ to fix time/category, or delete in the editor).
function dayEntriesHTML(entries) {
  const list = entries.filter((e) => e.ended_at).sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  if (!list.length) return "";
  let html = `<div class="rep-sub">Entries — tap ✎ to edit</div><div class="day-entries entry-list">`;
  for (const e of list) {
    const a = areaById(e.area_id);
    html += `<div class="entry"><div class="bar" style="background:${a?.color || "#555"}"></div>
      <div class="body"><div class="title">${escapeHtml(e.note || a?.name || "—")}</div>
      <div class="sub">${fmtRange(e)} · ${fmtDur(minutesOf(e))}</div></div>
      <button class="iconaction edit" data-id="${e.id}" title="Edit">✎</button></div>`;
  }
  return html + `</div>`;
}

// Horizontal timeline of the day's logged blocks (morning → evening).
function dayTimelineHTML(entries) {
  const done = entries.filter((e) => e.ended_at).sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  if (!done.length) return "";
  const hourOf = (iso) => { const t = new Date(iso); return t.getHours() + t.getMinutes() / 60; };
  let lo = 24, hi = 0;
  for (const e of done) { lo = Math.min(lo, hourOf(e.started_at)); hi = Math.max(hi, hourOf(e.ended_at)); }
  const start = Math.floor(Math.min(lo, 9));   // show at least 9am..6pm
  const end = Math.ceil(Math.max(hi, 18));
  const span = end - start || 1;
  let blocks = "";
  for (const e of done) {
    const a = areaById(e.area_id);
    const s = hourOf(e.started_at), en = hourOf(e.ended_at);
    const left = (s - start) / span * 100, width = Math.max(0.8, (en - s) / span * 100);
    const s1 = new Date(e.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const e1 = new Date(e.ended_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    blocks += `<div class="tl-block" style="left:${left}%;width:${width}%;background:${a?.color || "#888"}" title="${escapeAttr((e.note || "(untitled)") + " · " + s1 + "–" + e1)}"></div>`;
  }
  let ticks = "";
  const step = span > 10 ? 3 : 2;
  for (let h = start; h <= end; h += step) {
    const hr = ((h + 11) % 12) + 1, ap = h < 12 || h === 24 ? "a" : "p";
    ticks += `<span class="tl-tick" style="left:${(h - start) / span * 100}%">${hr}${ap}</span>`;
  }
  return `<div class="rep-sub">Timeline</div><div class="tl"><div class="tl-track">${blocks}</div><div class="tl-axis">${ticks}</div></div>`;
}

function renderAnalysis() {
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - 29);
  const to = new Date(); to.setDate(to.getDate() + 1);
  const done = entriesInRange(from, to).filter((e) => e.ended_at);
  const box = $("#analysis");
  let total = 0; const byArea = new Map(); const byTask = new Map();
  for (const e of done) {
    const m = minutesOf(e); if (m <= 0) continue;
    total += m;
    const ak = areaById(e.area_id) ? e.area_id : "__none__";
    byArea.set(ak, (byArea.get(ak) || 0) + m);
    const k = (e.note || "").trim() || "(untitled)";
    byTask.set(k, (byTask.get(k) || 0) + m);
  }
  let html = "";
  if (total > 0) {
    const [topId, topMin] = [...byArea.entries()].sort((a, b) => b[1] - a[1])[0];
    const topA = areaById(topId);
    html += `<div class="ana-item"><div class="ana-k">Most time on</div>
      <div class="ana-v"><span class="dot" style="background:${topA?.color || "#777"}"></span>${topA ? escapeHtml(topA.name) : "No category"} · ${fmtDur(topMin)} (${Math.round(topMin / total * 100)}%)</div></div>`;
    const topTasks = [...byTask.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    html += `<div class="ana-item"><div class="ana-k">Top tasks by time</div><ol class="rep-tasks">` +
      topTasks.map(([n, m]) => `<li><span>${escapeHtml(n)}</span><span class="muted">${fmtDur(m)}</span></li>`).join("") + `</ol></div>`;
  } else {
    html += `<div class="ana-item muted small">No time logged in the last 30 days yet.</div>`;
  }
  // important-category tasks with no logged time at all (across loaded history)
  const targetIds = new Set(state.areas.filter(hasTarget).map((a) => a.id));
  if (targetIds.size) {
    const loggedNotes = new Set(state.entries.filter((e) => e.ended_at).map((e) => (e.note || "").trim().toLowerCase()));
    const notDone = state.todos.filter((t) => targetIds.has(t.area_id) && !t.done_at && !loggedNotes.has(t.title.trim().toLowerCase()));
    html += `<div class="ana-item"><div class="ana-k">Not started — important categories</div>`;
    if (notDone.length) {
      html += `<ul class="rep-tasks">` + notDone.slice(0, 12).map((t) => {
        const a = areaById(t.area_id);
        return `<li><span><span class="dot" style="background:${a?.color || "#777"}"></span>${escapeHtml(t.title)}</span><span class="muted">${a ? escapeHtml(a.name) : ""}</span></li>`;
      }).join("") + `</ul>`;
      if (notDone.length > 12) html += `<div class="muted small">+${notDone.length - 12} more</div>`;
    } else html += `<div class="muted small">Every important-category task has some logged time. 🎉</div>`;
    html += `</div>`;
  } else {
    html += `<div class="ana-item muted small">Tip: set weekly targets on your important categories (Setup) to track which of their tasks are still untouched.</div>`;
  }
  box.innerHTML = html;
}
function renderTrendLine() {
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const ref = new Date(); ref.setDate(ref.getDate() - i * 7);
    weeks.push(alignmentScore(weekEntries(ref).list).score);
  }
  const W = 320, H = 120, p = 10;
  const pts = weeks.map((s, i) => ({
    x: p + (i * (W - 2 * p)) / (weeks.length - 1),
    y: s == null ? null : H - p - (s / 100) * (H - 2 * p),
  }));
  const line = pts.filter((q) => q.y != null).map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
  const dots = pts.map((q) => q.y == null ? "" : `<circle cx="${q.x}" cy="${q.y}" r="3.5" fill="var(--primary2)"/>`).join("");
  const grid = [0, 50, 100].map((v) => {
    const y = H - p - (v / 100) * (H - 2 * p);
    return `<line x1="${p}" y1="${y}" x2="${W - p}" y2="${y}" stroke="var(--line)"/><text x="0" y="${y - 2}" font-size="8" fill="var(--muted)">${v}</text>`;
  }).join("");
  $("#trend-line").innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%">
    ${grid}<path d="${line}" fill="none" stroke="var(--primary2)" stroke-width="2"/>${dots}
    <text x="${p}" y="${H - 1}" font-size="8" fill="var(--muted)">8 wks ago</text>
    <text x="${W - p}" y="${H - 1}" font-size="8" fill="var(--muted)" text-anchor="end">this wk</text></svg>`;
}
function renderHeatmap() {
  const box = $("#heatmap");
  const today = localDateStr(new Date());
  let html = `<div class="heat">`;
  for (let i = 69; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const next = new Date(d); next.setDate(next.getDate() + 1);
    const ds = localDateStr(d);
    const { score } = alignmentScore(entriesInRange(d, next));
    let bg = "var(--surface2)";
    if (score != null) {
      const col = score >= 80 ? "16,185,129" : score >= 60 ? "129,140,248" : score >= 40 ? "245,158,11" : "239,68,68";
      bg = `rgba(${col},${0.35 + (score / 100) * 0.6})`;
    }
    html += `<div class="cell${ds === today ? " sel" : ""}" data-date="${ds}" title="${d.toLocaleDateString()}: ${score == null ? "no data" : Math.round(score)}" style="background:${bg}"></div>`;
  }
  box.innerHTML = html + `</div>`;
  box.querySelectorAll(".cell").forEach((c) => {
    c.onclick = () => {
      box.querySelectorAll(".cell").forEach((x) => x.classList.remove("sel"));
      c.classList.add("sel");
      renderDayDetail(c.dataset.date);
    };
  });
}

// ===================================================== SETUP
function renderSetup() {
  const box = $("#areas-editor"); box.innerHTML = "";
  for (const a of state.areas) addAreaRow(a);
  renderPeople();
}

// ---------- People manager ----------
let _promptResolve = null;
function askPrompt(msg, val = "", okLabel = "Save") {
  $("#prompt-msg").textContent = msg;
  $("#prompt-input").value = val;
  $("#prompt-ok").textContent = okLabel;
  $("#prompt").classList.remove("hidden");
  setTimeout(() => $("#prompt-input").focus(), 40);
  return new Promise((r) => { _promptResolve = r; });
}
function settlePrompt(v) {
  $("#prompt").classList.add("hidden");
  if (_promptResolve) { _promptResolve(v); _promptResolve = null; }
}
function renderPeople() {
  const box = $("#people-list"); box.innerHTML = "";
  const counts = new Map();
  for (const t of state.todos) for (const p of personsOf(t)) counts.set(p, (counts.get(p) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  if (!names.length) { box.innerHTML = `<div class="empty">No people tagged yet. Tag someone on a task to see them here.</div>`; return; }
  for (const name of names) {
    const n = counts.get(name);
    const row = document.createElement("div");
    row.className = "people-row";
    row.innerHTML = `<span class="pname">${escapeHtml(name)}</span>
      <span class="muted small">${n} task${n > 1 ? "s" : ""}</span>
      <button class="iconaction pren" title="Rename / merge">✎</button>
      <button class="iconaction pdel" title="Remove from all tasks">✕</button>`;
    row.querySelector(".pren").onclick = () => renamePerson(name);
    row.querySelector(".pdel").onclick = () => deletePerson(name);
    box.appendChild(row);
  }
}
// Replace (or with newName=null, drop) a person across every task/plan/entry.
async function applyPersonChange(oldName, newName) {
  const fix = (arr) => {
    const out = [];
    for (const p of arr) {
      const v = p === oldName ? newName : p;
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  };
  const sweep = async (table, rows) => {
    for (const r of rows) {
      if (personsOf(r).includes(oldName)) {
        const np = fix(r.persons);
        const { error } = await sb.from(table).update({ persons: np }).eq("id", r.id);
        if (!error) r.persons = np;
      }
    }
  };
  await sweep("todos", state.todos);
  await sweep("plan_items", state.plan);
  await sweep("entries", state.entries);
  if (state.personFilter === oldName) state.personFilter = newName || "";
  renderPeople(); renderTodos(); renderPlan();
}
async function renamePerson(oldName) {
  const neu = await askPrompt(`Rename “${oldName}” to…`, oldName);
  if (neu == null) return;
  const trimmed = neu.trim();
  if (!trimmed || trimmed === oldName) return;
  const merging = distinctPersons().some((p) => p.toLowerCase() === trimmed.toLowerCase());
  if (merging && !(await askConfirm(`“${trimmed}” already exists. Merge “${oldName}” into it?`, "Merge"))) return;
  await applyPersonChange(oldName, trimmed);
  toast(merging ? "Merged" : `Renamed to ${trimmed}`);
}
async function deletePerson(name) {
  if (!(await askConfirm(`Remove “${name}” from all their tasks?`, "Remove"))) return;
  await applyPersonChange(name, null);
  toast("Removed");
}
function addAreaRow(a = null) {
  const row = document.createElement("div");
  row.className = "area-edit";
  row.dataset.id = a?.id || "";
  row.innerHTML = `<input type="color" value="${a?.color || "#6366f1"}" />
    <input class="nm" placeholder="Category name" value="${escapeAttr(a?.name || "")}" />
    <input class="pct" type="number" min="0" max="100" placeholder="—" value="${a && a.target_pct != null ? a.target_pct : ""}" title="Weekly target % (leave blank if not important)" />
    <button class="rm">✕</button>`;
  row.querySelector(".rm").onclick = () => {
    if (a && a.id) deleteCategory(a.id);   // existing category → confirm + reassign flow
    else row.remove();                      // unsaved new row → just drop it
  };
  $("#areas-editor").appendChild(row);
}

// Delete a saved category: ask, let the user move its tasks, then archive. Undoable.
let _catdelResolve = null;
function settleCatdel(v) {
  $("#catdel").classList.add("hidden");
  if (_catdelResolve) { _catdelResolve(v); _catdelResolve = null; }
}
async function deleteCategory(id) {
  const a = areaById(id);
  if (!a) return;
  const tasks = state.todos.filter((t) => t.area_id === id);
  $("#catdel-msg").textContent = tasks.length
    ? `Delete “${a.name}”? It has ${tasks.length} task${tasks.length > 1 ? "s" : ""}.`
    : `Delete category “${a.name}”?`;
  const reassign = $("#catdel-reassign"), sel = $("#catdel-target");
  if (tasks.length) {
    reassign.classList.remove("hidden");
    sel.innerHTML = `<option value="">— Leave uncategorised —</option>` +
      state.areas.filter((x) => x.id !== id)
        .map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join("");
  } else reassign.classList.add("hidden");

  const ok = await new Promise((res) => { _catdelResolve = res; $("#catdel").classList.remove("hidden"); });
  if (!ok) return;

  const target = tasks.length ? (sel.value || null) : null;
  const movedTodoIds = tasks.map((t) => t.id);
  await sb.from("todos").update({ area_id: target }).eq("area_id", id).eq("archived", false);
  await sb.from("plan_items").update({ area_id: target }).eq("area_id", id);
  await sb.from("areas").update({ archived: true }).eq("id", id);
  for (const t of state.todos) if (t.area_id === id) t.area_id = target;
  for (const p of state.plan) if (p.area_id === id) p.area_id = target;
  state.areas = state.areas.filter((x) => x.id !== id);
  renderSetup(); renderTodos(); renderPlan(); render();
  toastUndo("Category deleted", async () => {
    await sb.from("areas").update({ archived: false }).eq("id", id);
    if (movedTodoIds.length) await sb.from("todos").update({ area_id: id }).in("id", movedTodoIds);
    await loadAll(); render(); renderSetup(); renderTodos();
  });
}
async function saveAreas() {
  const rows = $$("#areas-editor .area-edit");
  let order = 1;
  const keepIds = [];
  for (const r of rows) {
    const id = r.dataset.id;
    const pctRaw = r.querySelector(".pct").value.trim();
    const payload = {
      user_id: state.user.id,
      name: r.querySelector(".nm").value.trim() || "Untitled",
      color: r.querySelector('input[type=color]').value,
      target_pct: pctRaw === "" ? null : Math.max(0, Math.min(100, Number(pctRaw))),
      sort_order: order++,
    };
    if (id) { await sb.from("areas").update(payload).eq("id", id); keepIds.push(id); }
    else { const { data } = await sb.from("areas").insert(payload).select().single(); if (data) keepIds.push(data.id); }
  }
  for (const a of state.areas) if (!keepIds.includes(a.id)) await sb.from("areas").update({ archived: true }).eq("id", a.id);
  await loadAll(); render(); renderSetup(); toast("Saved");
}

// ===================================================== navigation
function showView(v) {
  $$(".view").forEach((el) => el.classList.add("hidden"));
  $(`#view-${v}`).classList.remove("hidden");
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  if (v === "reports") renderReports();
  if (v === "todos") renderTodos();
  if (v === "setup") renderSetup();
}

// ===================================================== auth
async function enterApp() {
  await loadAll();
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  render();
  showDueAsk();   // start-of-day prompt for tasks due today/tomorrow
}
function showAuth(msg = "") {
  $("#app").classList.add("hidden");
  $("#auth").classList.remove("hidden");
  $("#auth-msg").textContent = msg;
}
async function signIn() {
  const { error } = await sb.auth.signInWithPassword({ email: $("#auth-email").value.trim(), password: $("#auth-pass").value });
  if (error) $("#auth-msg").textContent = error.message;
}
async function signUp() {
  if ($("#auth-pass").value.length < 6) return ($("#auth-msg").textContent = "Password must be 6+ characters");
  const { error } = await sb.auth.signUp({ email: $("#auth-email").value.trim(), password: $("#auth-pass").value });
  $("#auth-msg").textContent = error ? error.message : "Account created — signing you in…";
}

// ===================================================== wire up
function bind() {
  $("#auth-signin").onclick = signIn;
  $("#auth-signup").onclick = signUp;
  $("#signout").onclick = () => sb.auth.signOut();
  $("#start-timer").onclick = () => openPicker("timer");
  $("#quick-add").onclick = () => openPicker("quick");
  $("#pause-timer").onclick = () => (state.running?.paused_at ? resumeTimer() : pauseTimer());
  $("#stop-timer").onclick = stopTimer;
  $("#edit-timer").onclick = () => { if (state.running) openEditor(state.running); };
  $("#picker-close").onclick = closePicker;
  $("#picker-confirm").onclick = confirmPicker;
  $("#picker-note").addEventListener("input", onPickerNoteInput);
  $("#plan-add").onclick = addPlanItem;
  $("#carry-all").onclick = carryAllToToday;
  $("#plan-area").addEventListener("change", fillPlanTodoOptions);
  $("#plan-task").addEventListener("input", onPlanTaskInput);
  $("#plan-task").addEventListener("keydown", (e) => { if (e.key === "Enter") addPlanItem(); });
  $("#todo-add").onclick = addTodo;
  $("#todo-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  $("#todo-person").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  $("#todo-filter-person").addEventListener("change", (e) => { state.personFilter = e.target.value; renderTodos(); });
  $("#todo-search").addEventListener("input", (e) => { state.todoSearch = e.target.value; renderTodos(); });
  $("#todo-sort").addEventListener("change", (e) => { state.todoSort = e.target.value; renderTodos(); });
  $("#todo-showdone").addEventListener("change", (e) => { state.showDone = e.target.checked; renderTodos(); });
  $("#todoedit-close").onclick = closeTodoEditor;
  $("#todoedit-save").onclick = saveTodoEditor;
  $("#todoedit-delete").onclick = deleteFromTodoEditor;
  $("#editor-close").onclick = closeEditor;
  $("#editor-save").onclick = saveEditor;
  $("#editor-delete").onclick = deleteFromEditor;
  $("#add-area").onclick = () => addAreaRow();
  $("#save-areas").onclick = saveAreas;
  $("#confirm-ok").onclick = () => settleConfirm(true);
  $("#confirm-cancel").onclick = () => settleConfirm(false);
  $("#catdel-ok").onclick = () => settleCatdel(true);
  $("#catdel-cancel").onclick = () => settleCatdel(false);
  $("#dueask-add").onclick = dueAskAdd;
  $("#dueask-skip").onclick = dismissDueAsk;
  $("#dueask-close").onclick = dismissDueAsk;
  $("#prompt-ok").onclick = () => settlePrompt($("#prompt-input").value);
  $("#prompt-cancel").onclick = () => settlePrompt(null);
  $("#prompt-input").addEventListener("keydown", (e) => { if (e.key === "Enter") settlePrompt($("#prompt-input").value); });
  $$(".tab").forEach((t) => (t.onclick = () => showView(t.dataset.view)));
}

bind();
sb.auth.onAuthStateChange((_e, session) => {
  if (session?.user) { state.user = session.user; enterApp(); }
  else { state.user = null; showAuth(); }
});
sb.auth.getSession().then(({ data }) => { if (!data.session) showAuth(); });
