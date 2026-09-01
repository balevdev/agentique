// anakin dashboard frontend — zero deps, no framework.
// Every DB-sourced string enters the DOM as a text node via h()/append(),
// never as HTML.

type Json = any;
const SNAP: Json | null = (window as any).__SNAPSHOT__ ?? null;

// ---------- data ----------

function snapLookup(path: string): Json {
  const [p, qs] = path.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (p === "/api/overview") return SNAP.overview;
  let m = p.match(/^\/api\/project\/(\w+)$/);
  if (m) return SNAP.projects[m[1]] ?? null;
  m = p.match(/^\/api\/journal\/(\w+)$/);
  if (m) {
    let e: Json[] = SNAP.journal[m[1]] ?? [];
    const kind = params.get("kind"), q = params.get("q")?.toLowerCase();
    if (kind) e = e.filter((x) => x.entry_kind === kind);
    if (q) e = e.filter((x) => `${x.decisions} ${x.questions} ${x.item_title ?? ""}`.toLowerCase().includes(q));
    return { entries: e, next_before: null };
  }
  m = p.match(/^\/api\/patch\/(\d+)$/);
  if (m) return SNAP.patches[m[1]] ?? "";
  return null;
}

async function api(path: string): Promise<Json> {
  if (SNAP) return snapLookup(path);
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} on ${path}`);
  return r.json();
}

async function apiText(path: string): Promise<string> {
  if (SNAP) return snapLookup(path) ?? "";
  const r = await fetch(path);
  return r.ok ? r.text() : "";
}

// ---------- dom ----------

function h(tag: string, cls = "", ...kids: (Node | string | number | null | undefined)[]): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k !== null && k !== undefined) el.append(k as any);
  return el;
}

function link(hash: string, cls: string, ...kids: (Node | string)[]): HTMLElement {
  const a = h("a", cls, ...kids) as HTMLAnchorElement;
  a.href = hash;
  return a;
}

function timeAgo(ts: string | null): string {
  if (!ts) return "—";
  const t = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z").getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "—");

// Pass/fail carries via glyphs and filled-vs-outlined badges — never extra hues.
function kindBadge(kind: string, verdict?: string | null): HTMLElement {
  const ok = verdict == null || /green|pass/i.test(verdict);
  const label = kind === "tick" ? (ok ? "✓ tick" : "✕ tick") : kind;
  return h("span", `badge ${kind}${ok ? "" : " fail"}`, label);
}

// ---------- theme ----------

function initTheme() {
  const saved = localStorage.getItem("anakin-theme");
  document.documentElement.dataset.theme =
    saved ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

function themeToggle(): HTMLElement {
  const b = h("button", "theme-toggle", "◐");
  b.title = "toggle theme";
  b.onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("anakin-theme", next);
  };
  return b;
}

// ---------- router ----------

const root = document.getElementById("app")!;
let seq = "";

function route(): { view: string; pid: string | null } {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1]) return { view: parts[2] ?? "task", pid: parts[1] };
  return { view: "overview", pid: null };
}

async function render() {
  const r = route();
  const o = await api("/api/overview");
  const main = h("main", "main");
  try {
    if (o.empty) main.append(emptyState());
    else if (!r.pid) main.append(renderOverview(o));
    else {
      const p = await api(`/api/project/${r.pid}`);
      if (!p) main.append(h("p", "quiet", "unknown project"));
      else main.append(await renderProjectView(r, p));
    }
  } catch (e) {
    main.append(h("div", "banner", `something went wrong: ${e}`));
  }
  root.replaceChildren(renderRail(o, r), main);
}

async function renderProjectView(r: { view: string; pid: string | null }, p: Json): Promise<HTMLElement> {
  if (r.view === "missions") return renderMissions(p);
  if (r.view === "journal") return renderJournal(r.pid!, p);
  if (r.view === "knowledge") return renderKnowledge(p);
  if (r.view === "gate") return renderGate(p);
  return renderProject(p);
}

async function poll() {
  // Don't yank the DOM out from under someone typing in a filter or
  // holding the kind dropdown open.
  if (!(document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLSelectElement)) {
    try {
      const v = await api("/api/version");
      if (v.seq !== seq) { seq = v.seq; await render(); }
    } catch { /* server briefly away — keep polling */ }
  }
  setTimeout(poll, 2000);
}

// ---------- views ----------

function renderRail(o: Json, r: { view: string; pid: string | null }): HTMLElement {
  const rail = h("nav", "rail");
  rail.append(link("#/", "brand", "anakin"));
  if (SNAP) rail.append(h("span", "snap-badge", "snapshot"));
  rail.append(link("#/", `rail-item${!r.pid ? " active" : ""}`, "Overview"));
  rail.append(h("div", "rail-head", "Projects"));
  for (const p of o.projects ?? []) {
    const item = link(`#/p/${p.id}`, `rail-item${r.pid === p.id ? " active" : ""}`, p.name);
    if (p.active_task) item.append(h("span", "pulse"));
    rail.append(item);
  }
  const foot = h("div", "rail-foot");
  foot.append(themeToggle());
  rail.append(foot);
  return rail;
}

function emptyState(): HTMLElement {
  return h("div", "view empty",
    h("div", "empty-mark", "◍"),
    h("h1", "", "the factory has no memory yet"),
    h("p", "quiet", "run /anakin init in a repo to begin"));
}

function stat(label: string, value: string | number): HTMLElement {
  return h("div", "stat card", h("div", "stat-value", String(value)), h("div", "stat-label", label));
}

function sparkline(days: { d: string; c: number }[]): SVGElement {
  const W = 560, H = 56;
  const map = new Map(days.map((x) => [x.d, x.c]));
  const pts: number[] = [];
  for (let i = 29; i >= 0; i--)
    pts.push(map.get(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)) ?? 0);
  const max = Math.max(...pts, 1);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("spark");
  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("points",
    pts.map((v, i) => `${(i / 29) * W},${H - 6 - (v / max) * (H - 12)}`).join(" "));
  svg.append(poly);
  return svg;
}

function renderOverview(o: Json): HTMLElement {
  const v = h("div", "view");
  v.append(h("h1", "", "Overview"));
  const t = o.totals;
  const active = (t.tasks_by_status.approved ?? 0) + (t.tasks_by_status.in_progress ?? 0) + (t.tasks_by_status.review ?? 0);
  v.append(h("div", "stat-grid",
    stat("checkpoints · 7 days", t.ticks_7d),
    stat("tasks committed", t.tasks_by_status.committed ?? 0),
    stat("open questions", t.open_questions),
    stat("active tasks", active)));

  const sc = h("div", "card");
  sc.append(h("div", "card-title", "checkpoints · last 30 days"), sparkline(t.ticks_30d_by_day));
  v.append(sc);

  if (o.questions.length) {
    const qc = h("div", "card");
    qc.append(h("div", "card-title", "waiting on you"));
    for (const q of o.questions)
      qc.append(link(`#/p/${q.project_id}/journal`, "q-row",
        h("div", "", q.questions),
        h("div", "quiet", `${q.project_name}${q.task_title ? " · " + q.task_title : ""} · ${timeAgo(q.created_at)}`)));
    v.append(qc);
  }

  const rc = h("div", "card");
  rc.append(h("div", "card-title", "recent activity"));
  for (const e of o.recent)
    rc.append(link(`#/p/${e.project_id}/journal`, "j-row",
      kindBadge(e.entry_kind, e.gate_verdict),
      h("div", "j-main",
        h("div", "", e.item_title ?? e.decisions ?? e.entry_kind),
        h("div", "quiet", `${e.project_name} · ${timeAgo(e.created_at)}`))));
  if (!o.recent.length) rc.append(h("p", "quiet", "no activity yet"));
  v.append(rc);
  return v;
}

// ---------- project views ----------

function projectHeader(p: Json, active: string): HTMLElement {
  const id = p.project.id;
  const tabs = h("div", "tabs");
  const spec: [string, string, string][] = [
    ["task", `#/p/${id}`, "Task"],
    ["missions", `#/p/${id}/missions`, "Missions"],
    ["journal", `#/p/${id}/journal`, "Journal"],
    ["knowledge", `#/p/${id}/knowledge`, "Knowledge"],
    ["gate", `#/p/${id}/gate`, "Gate & Prefs"],
  ];
  for (const [key, href, label] of spec)
    tabs.append(link(href, `tab${active === key ? " active" : ""}`, label));
  return h("header", "project-head",
    h("h1", "", p.project.name),
    h("div", "quiet mono", p.project.abs_path),
    tabs);
}

function statusPill(status: string): HTMLElement {
  return h("span", `pill ${status}`, status.replace("_", " "));
}

function renderProject(p: Json): HTMLElement {
  const v = h("div", "view");
  v.append(projectHeader(p, "task"));
  if (!p.task) {
    v.append(h("div", "card", h("p", "quiet", "no task yet — /anakin task <ticket> starts intake")));
    return v;
  }
  const t = p.task;
  // v2 tasks carry no items — progress falls back to the latest mission's stages.
  const mission = (p.missions ?? []).find((m: Json) => m.task_id === t.id) ?? null;
  const total = p.items.length || (mission ? mission.stage_plan.length : 0);
  const done = p.items.length
    ? p.items.filter((i: Json) => i.status === "done").length
    : mission ? Math.min(mission.stage_cursor, mission.stage_plan.length) : 0;

  const hero = h("div", "card hero");
  hero.append(h("div", "hero-top", statusPill(t.status), h("span", "quiet", `updated ${timeAgo(t.updated_at)}`)));
  hero.append(h("h2", "", t.title));
  if (t.description) hero.append(h("p", "quiet", t.description));
  const bar = h("div", "progress");
  const fill = h("div", "progress-fill");
  fill.style.width = total ? `${(done / total) * 100}%` : "0";
  bar.append(fill);
  hero.append(h("div", "hero-progress", bar,
    h("span", "mono quiet", `${done}/${total}${!p.items.length && mission ? " stages" : ""}`)));
  hero.append(h("div", "quiet mono", p.expected_tree_hash
    ? `tree ${short(p.expected_tree_hash)} · head ${short(p.expected_head_sha)}`
    : "tree clean"));
  v.append(hero);

  const il = h("div", "card");
  il.append(h("div", "card-title", "items"));
  for (const i of p.items)
    il.append(h("div", `item-row${i.status === "done" ? " done" : ""}`,
      h("span", "item-mark", i.status === "done" ? "✓" : "○"),
      h("div", "j-main", h("div", "", i.title), i.files ? h("div", "quiet mono", i.files) : null),
      i.sensitive ? h("span", "badge outline", "sensitive") : null));
  if (!p.items.length) il.append(h("p", "quiet", "no items yet"));
  v.append(il);

  const gc = h("div", "card");
  gc.append(h("div", "card-title", "gate"));
  for (const g of p.gate)
    gc.append(h("div", "gate-row", h("code", "", g.command), g.reason ? h("span", "quiet", g.reason) : null));
  if (!p.gate.length) gc.append(h("p", "quiet", "no gate commands recorded"));
  const lastTick = p.journal.find((e: Json) => e.entry_kind === "tick");
  if (lastTick?.gate_verdict)
    gc.append(h("div", "gate-verdict quiet", "last verdict ", kindBadge("tick", lastTick.gate_verdict)));
  v.append(gc);

  const jc = h("div", "card");
  jc.append(h("div", "card-title", "latest activity"));
  for (const e of p.journal.slice(0, 5)) jc.append(journalRow(e));
  if (!p.journal.length) jc.append(h("p", "quiet", "quiet so far"));
  v.append(jc);
  return v;
}

function renderDiff(patch: string): HTMLElement {
  const box = h("div", "diff");
  for (const line of patch.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del"
      : line.startsWith("@@") ? "hunk" : "";
    box.append(h("div", `dline ${cls}`, line || " "));
  }
  return box;
}

function journalRow(e: Json): HTMLElement {
  const row = h("div", "j-entry");
  const head = h("div", "j-head",
    kindBadge(e.entry_kind, e.gate_verdict),
    h("div", "j-main",
      h("div", "", e.item_title ?? (e.decisions ? e.decisions.split("\n")[0] : e.entry_kind)),
      h("div", "quiet", timeAgo(e.created_at))));
  const body = h("div", "j-body");
  if (e.decisions) body.append(h("pre", "", e.decisions));
  if (e.questions) body.append(h("div", "q-block", h("div", "card-title", "questions"), h("pre", "", e.questions)));
  if (e.tree_hash) body.append(h("div", "quiet mono", `tree ${short(e.tree_hash)} · head ${short(e.head_sha)}`));
  if (e.has_patch) {
    const btn = h("button", "btn", "view patch");
    (btn as HTMLButtonElement).onclick = async () => {
      btn.replaceWith(renderDiff(await apiText(`/api/patch/${e.id}`)));
    };
    body.append(btn);
  }
  body.hidden = true;
  head.onclick = () => { body.hidden = !body.hidden; };
  row.append(head, body);
  return row;
}

async function renderJournal(pid: string, p: Json): Promise<HTMLElement> {
  const v = h("div", "view");
  v.append(projectHeader(p, "journal"));
  const search = h("input", "search") as HTMLInputElement;
  search.placeholder = "search memory…";
  const select = h("select", "kind-select") as HTMLSelectElement;
  for (const k of ["all", "tick", "approval", "stop", "note"]) {
    const opt = document.createElement("option");
    opt.value = k === "all" ? "" : k;
    opt.textContent = k;
    select.append(opt);
  }
  v.append(h("div", "toolbar", search, select));
  const list = h("div", "j-list");
  const more = h("button", "btn more", "older entries");
  v.append(list, more);

  let before: number | null = null;
  async function load(reset: boolean) {
    if (reset) { list.replaceChildren(); before = null; }
    const qs = new URLSearchParams();
    if (search.value.trim()) qs.set("q", search.value.trim());
    if (select.value) qs.set("kind", select.value);
    if (before) qs.set("before", String(before));
    const page = await api(`/api/journal/${pid}?${qs}`);
    for (const e of page.entries) list.append(journalRow(e));
    if (!list.children.length) list.append(h("p", "quiet", "nothing here"));
    before = page.next_before;
    more.hidden = !before;
  }
  let deb: ReturnType<typeof setTimeout>;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => load(true), 250); };
  select.onchange = () => load(true);
  (more as HTMLButtonElement).onclick = () => load(false);
  await load(true);
  return v;
}

function stagePlanRow(m: Json): HTMLElement {
  const row = h("div", "stage-plan mono");
  (m.stage_plan as string[]).forEach((stage, i) => {
    if (i) row.append(h("span", "quiet", " → "));
    const mark = i < m.stage_cursor ? "✓ " : m.status === "running" && i === m.stage_cursor ? "▸ " : "○ ";
    row.append(h("span", `stage${i < m.stage_cursor ? " done" : ""}`, mark + stage));
  });
  return row;
}

function handoffRow(hf: Json): HTMLElement {
  const row = h("div", "j-entry");
  const head = h("div", "j-head",
    h("span", `badge${/^\s*(fail|block|red)\b/i.test(hf.verdict ?? "") ? " fail" : ""}`, // same leading-token rule as the CLI's cursor hold
      `${hf.stage}${hf.attempt > 1 ? " #" + hf.attempt : ""}`),
    h("div", "j-main",
      h("div", "", hf.verdict ?? hf.content.split("\n")[0]),
      h("div", "quiet", timeAgo(hf.created_at))));
  const body = h("div", "j-body", h("pre", "", hf.content));
  body.hidden = true;
  head.onclick = () => { body.hidden = !body.hidden; };
  row.append(head, body);
  return row;
}

function renderMissions(p: Json): HTMLElement {
  const v = h("div", "view");
  v.append(projectHeader(p, "missions"));
  if (!(p.missions ?? []).length)
    v.append(h("div", "card", h("p", "quiet", "no missions yet — an approved task starts one")));
  for (const m of p.missions ?? []) {
    const c = h("div", "card");
    c.append(h("div", "hero-top", statusPill(m.status),
      h("span", "quiet", `${m.task_title} · updated ${timeAgo(m.updated_at)}`)));
    c.append(h("h2", "", m.slug), h("div", "quiet mono", m.dir));
    c.append(stagePlanRow(m));
    if (m.handoffs.length) {
      c.append(h("div", "card-title", "handoffs"));
      for (const hf of m.handoffs) c.append(handoffRow(hf));
    }
    if (m.artifacts.length) {
      c.append(h("div", "card-title", "ingested artifacts"));
      for (const a of m.artifacts)
        c.append(h("div", "gate-row", h("code", "", a.filename), h("span", "quiet", `${a.bytes} bytes`)));
    }
    v.append(c);
  }
  return v;
}

const KINDS = ["layout", "boundary", "convention", "sensitive_zone", "gotcha"];

function renderKnowledge(p: Json): HTMLElement {
  const v = h("div", "view");
  v.append(projectHeader(p, "knowledge"));
  if (!p.knowledge.length) v.append(h("div", "card", h("p", "quiet", "no knowledge recorded yet")));
  for (const kind of KINDS) {
    const secs = p.knowledge.filter((k: Json) => k.kind === kind);
    if (!secs.length) continue;
    const c = h("div", "card");
    c.append(h("div", "card-title", kind.replace("_", " ")));
    for (const s of secs)
      c.append(h("div", "k-row",
        h("div", "k-head", h("strong", "", s.title),
          h("span", "quiet mono", `${s.paths_glob || "*"} · ${short(s.verified_sha)} · ${timeAgo(s.updated_at)}`)),
        h("pre", "k-body", s.body)));
    v.append(c);
  }
  return v;
}

function renderGate(p: Json): HTMLElement {
  const v = h("div", "view");
  v.append(projectHeader(p, "gate"));
  const gc = h("div", "card");
  gc.append(h("div", "card-title", "gate — runs in order, after implement, before verify"));
  p.gate.forEach((g: Json, i: number) =>
    gc.append(h("div", "gate-row",
      h("span", "quiet mono", String(i + 1)),
      h("code", "", g.command),
      g.reason ? h("span", "quiet", g.reason) : null)));
  if (!p.gate.length) gc.append(h("p", "quiet", "no gate commands recorded"));
  v.append(gc);
  const pc = h("div", "card");
  pc.append(h("div", "card-title", "prefs — global"));
  for (const pref of p.prefs)
    pc.append(h("div", "k-row", h("div", "k-head", h("strong", "", pref.key)), h("pre", "k-body", pref.body)));
  if (!p.prefs.length) pc.append(h("p", "quiet", "no prefs set"));
  v.append(pc);
  return v;
}

// ---------- boot ----------

initTheme();
addEventListener("hashchange", render);
render();
if (!SNAP) poll();
