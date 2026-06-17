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
  return (end - new Date(e.started_at)) / 60000;
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
  const [areas, settings, entries, plan, todos] = await Promise.all([
    sb.from("areas").select("*").eq("archived", false).order("sort_order"),
    sb.from("settings").select("*").eq("user_id", uid).maybeSingle(),
    sb.from("entries").select("*").or(`started_at.gte.${since.toISOString()},ended_at.is.null`).order("started_at", { ascending: false }),
    sb.from("plan_items").select("*").eq("date", localDateStr(new Date())).order("sort_order"),
    sb.from("todos").select("*").eq("archived", false).order("title"),
  ]);
  state.areas = areas.data || [];
  state.settings = settings.data || { week_start: 1 };
  state.entries = entries.data || [];
  state.plan = plan.data || [];
  state.todos = todos.data || [];
  state.running = state.entries.find((e) => !e.ended_at) || null;
}

// ===================================================== render: TODAY
function render() {
  renderPlan();
  renderTimer();
  renderTodayList();
  renderPVA();
}

function renderTimer() {
  const idle = $("#timer-idle"), run = $("#timer-running");
  clearInterval(state.tick);
  if (state.running) {
    idle.classList.add("hidden"); run.classList.remove("hidden");
    const a = areaById(state.running.area_id);
    $("#running-label").textContent = [a?.name, state.running.note].filter(Boolean).join(" · ") || "Tracking";
    const upd = () => {
      const sec = Math.floor((Date.now() - new Date(state.running.started_at)) / 1000);
      $("#running-elapsed").textContent = fmtClock(sec);
    };
    upd(); state.tick = setInterval(upd, 1000);
  } else {
    idle.classList.remove("hidden"); run.classList.add("hidden");
  }
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
    const row = document.createElement("div");
    row.className = "plan-item";
    row.innerHTML = `<span class="dot" style="background:${a?.color || "#555"}"></span>
      <div class="body"><div class="title">${escapeHtml(pi.task)}</div>
      <div class="sub">${a?.name || "—"} · ${pi.planned_min}m planned${personsOf(pi).length ? ` · <span class="person">👤 ${escapeHtml(personsOf(pi).join(", "))}</span>` : ""}</div></div>
      <button class="iconaction play" title="Start timer">▶</button>
      <button class="iconaction del" title="Remove">✕</button>`;
    row.querySelector(".play").onclick = () => startTimer(pi.area_id, pi.task, personsOf(pi));
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
  let plannedTotal = 0, actualTotal = 0;
  for (const pi of state.plan) {
    const key = pi.task.trim().toLowerCase();
    matched.add(key);
    const planned = pi.planned_min;
    const actual = Math.round(actualByTask.get(key) || 0);
    plannedTotal += planned; actualTotal += actual;
    const pct = planned > 0 ? Math.min(100, (actual / planned) * 100) : (actual > 0 ? 100 : 0);
    const over = planned > 0 && actual > planned;
    const a = areaById(pi.area_id);
    box.insertAdjacentHTML("beforeend", `<div class="avt">
      <div class="avt-top"><span><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${a?.color || "#555"};margin-right:6px"></span>${escapeHtml(pi.task)}</span>
        <span class="muted">${fmtDur(actual)} / ${fmtDur(planned)}${over ? " ⚠" : ""}</span></div>
      <div class="track"><div class="fill" style="width:${pct}%;background:${over ? "var(--warn)" : (a?.color || "var(--primary)")}"></div></div></div>`);
  }
  // unplanned actual time
  let unplanned = 0;
  for (const [k, m] of actualByTask) if (k && !matched.has(k)) unplanned += m;
  let extra = "";
  if (Math.round(unplanned) >= 1) extra = `<div class="pva-foot"><span>Unplanned tasks</span><span class="warn">${fmtDur(unplanned)}</span></div>`;
  box.insertAdjacentHTML("beforeend",
    `<div class="pva-foot total"><span>Planned ${fmtDur(plannedTotal)}</span><span>Done ${fmtDur(actualTotal + unplanned)}</span></div>${extra}`);
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
  const { error } = await sb.from("entries").update({ ended_at: end }).eq("id", state.running.id);
  if (error) return toast(error.message);
  state.running.ended_at = end; state.running = null;
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
  render();
  toastUndo("Entry deleted", async () => {
    const { data, error: e2 } = await sb.from("entries").insert({
      user_id: state.user.id, area_id: e.area_id, note: e.note,
      started_at: e.started_at, ended_at: e.ended_at, source: e.source,
    }).select().single();
    if (e2) return toast(e2.message);
    state.entries.unshift(data);
    state.running = state.entries.find((x) => !x.ended_at) || null;
    render();
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
  const todo = await ensureTodo(task, areaId, min);   // create on the master list if new
  const { data, error } = await sb.from("plan_items").insert({
    user_id: state.user.id, date: localDateStr(new Date()), area_id: areaId,
    task, planned_min: min, sort_order: state.plan.length + 1,
    todo_id: todo?.id || null, persons: personsOf(todo),
  }).select().single();
  if (error) return toast(error.message);
  state.plan.push(data);
  $("#plan-task").value = ""; $("#plan-min").value = "";
  renderPlan(); renderPVA();
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
    sel.innerHTML = `<option value="">Everyone</option>` +
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
  if (!list.length) box.innerHTML = `<div class="empty">${state.personFilter ? "No tasks for this person." : "No tasks yet. Add them above or paste your list."}</div>`;
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
}
// ---------- to-do editor ----------
function openTodoEditor(t) {
  state.todoEditId = t.id;
  $("#te-title").value = t.title;
  fillAreaSelect($("#te-area"), t.area_id);
  $("#te-person").value = personsOf(t).join(", ");
  $("#te-due").value = t.due_date || "";
  $("#te-min").value = t.default_min || "";
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
    due_date: $("#te-due").value || null,
  };
  const { data, error } = await sb.from("todos").update(payload).eq("id", t.id).select().single();
  if (error) return toast(error.message);
  Object.assign(t, data);
  state.todos.sort((a, b) => a.title.localeCompare(b.title));
  closeTodoEditor(); renderTodos(); renderPlan(); toast("Saved");
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
  const newVal = t.done_at ? null : new Date().toISOString();
  const { error } = await sb.from("todos").update({ done_at: newVal }).eq("id", t.id);
  if (error) return toast(error.message);
  t.done_at = newVal;
  renderTodos();
  if (newVal) toastUndo("Marked done", async () => {
    await sb.from("todos").update({ done_at: null }).eq("id", t.id);
    t.done_at = null; renderTodos();
  });
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
function confirmPicker() {
  if (!state.pick.areaId) return toast("Pick a category");
  const note = $("#picker-note").value.trim();
  if (!note) return toast("Task is required");
  const persons = parsePersons($("#picker-person").value);
  if (state.pick.mode === "timer") {
    startTimer(state.pick.areaId, note, persons);
  } else {
    const today = localDateStr(new Date());
    const s = new Date(`${today}T${$("#pk-start").value || "00:00"}`);
    const e = new Date(`${today}T${$("#pk-end").value || "00:00"}`);
    if (e <= s) return toast("End must be after start");
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
  const payload = { note: task, area_id: $("#ed-area").value, started_at: startISO, ended_at: endISO };
  const { data, error } = await sb.from("entries").update(payload).eq("id", e.id).select().single();
  if (error) return toast(error.message);
  Object.assign(e, data);
  state.running = state.entries.find((x) => !x.ended_at) || null;
  closeEditor(); render(); toast("Updated");
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
  const d = new Date(dateStr + "T00:00"); const next = new Date(d); next.setDate(next.getDate() + 1);
  const head = `<div class="rep-dayhead">${d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</div>`;
  $("#day-detail").innerHTML = head + periodSummaryHTML(entriesInRange(d, next));
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
  $("#stop-timer").onclick = stopTimer;
  $("#picker-close").onclick = closePicker;
  $("#picker-confirm").onclick = confirmPicker;
  $("#picker-note").addEventListener("input", onPickerNoteInput);
  $("#plan-add").onclick = addPlanItem;
  $("#plan-area").addEventListener("change", fillPlanTodoOptions);
  $("#plan-task").addEventListener("input", onPlanTaskInput);
  $("#plan-task").addEventListener("keydown", (e) => { if (e.key === "Enter") addPlanItem(); });
  $("#todo-add").onclick = addTodo;
  $("#todo-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  $("#todo-person").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  $("#todo-filter-person").addEventListener("change", (e) => { state.personFilter = e.target.value; renderTodos(); });
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
  $$(".tab").forEach((t) => (t.onclick = () => showView(t.dataset.view)));
}

bind();
sb.auth.onAuthStateChange((_e, session) => {
  if (session?.user) { state.user = session.user; enterApp(); }
  else { state.user = null; showAuth(); }
});
sb.auth.getSession().then(({ data }) => { if (!data.session) showAuth(); });
