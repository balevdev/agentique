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
  if (p === "/api/version") return { seq: "snapshot" };
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

// Task 3 replaces this stub with the real project views.
async function renderProjectView(r: { view: string; pid: string | null }, p: Json): Promise<HTMLElement> {
  return h("div", "card", h("p", "quiet", p.project.name));
}

async function poll() {
  // Don't yank the DOM out from under someone typing in a filter.
  if (!(document.activeElement instanceof HTMLInputElement)) {
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
  const done = o.projects.reduce((a: number, p: Json) => a + p.items_done, 0);
  const total = o.projects.reduce((a: number, p: Json) => a + p.items_total, 0);
  v.append(h("div", "stat-grid",
    stat("ticks · 7 days", t.ticks_7d),
    stat("items done", `${done}/${total}`),
    stat("open questions", t.open_questions),
    stat("active tasks", active)));

  const sc = h("div", "card");
  sc.append(h("div", "card-title", "ticks · last 30 days"), sparkline(t.ticks_30d_by_day));
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

// ---------- boot ----------

initTheme();
addEventListener("hashchange", render);
render();
if (!SNAP) poll();
