// agents: a readable agent-activity sidebar. A summary block up top (running /
// waiting / clock), an aggregate activity graph, then one row per workspace
// with a state glyph, title, a 6-minute activity sparkline, and a progress or
// run-time readout. A working agent shows a braille spinner that steps once a
// second; everything else is larger-type and logo-free.
//
// The status word follows the agent's lifecycle (run / input / idle / done).
// An unread notification only colours the glyph and bar orange until the
// workspace is viewed. A workspace progress bar (the subagent plugin publishes
// `done/total agents` while delegates run) counts as running, since the
// orchestrator's own lifecycle goes idle while its background subagents work.
//
// A pi `ask` prompt shows `input` only when cmux's lifecycle is needs_input,
// which needs ~/.pi/agent/extensions/cmux-needs-input.ts to send the
// `needs_input` notification marker.
//
//
//   cmux sidebar select agents        (left sidebar preview)
//   cmux right-sidebar set custom agents   (right sidebar panel)
//
// History lives in this sidebar, sampled once per clock tick, so graphs start
// when the sidebar loads. Sessions already working backfill from their start.
// One graph column is BUCKET seconds.

const BUCKET = 15; // seconds per graph column (two columns per braille cell)
const ROW_CELLS = 20; // per-workspace sparkline width in braille cells (2 columns each); tune to the sidebar so it fits without overflowing
const TOP_CELLS = 28; // header graph: 56 columns = 14 minutes
const KEEP = Math.max(TOP_CELLS, ROW_CELLS) * 2; // buckets of history kept per workspace
const METER = 6; // progress meter cells
const MAX_ROWS = 40;

// Theme tokens only (system colors adapt to light and dark).
const STATE = {
  needs_input: { glyph: "◆", color: "orange", word: "input" },
  working: { glyph: "", color: "cyan", word: "run" },
  idle: { glyph: "●", color: "green", word: "idle" },
  ended: { glyph: "○", color: "tertiary", word: "done" },
  none: { glyph: "·", color: "quaternary", word: "" },
};
const RANK = { needs_input: 4, working: 3, idle: 2, ended: 1, none: 0 };
// Working spinner frames, advanced once per clock second. The sandbox clock is
// 1 Hz, so a frame-cycled glyph can go no faster; the slow braille cycle reads
// as a calm pulse rather than a stutter.
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
// Graph gradient, bottom dot row to top, in system colors.
// No yellow: system yellow braille dots wash out on a light sidebar.
const ROW_HEAT = ["green", "green", "orange", "orange"];
const TOP_HEAT = ["teal", "teal", "green", "green", "green", "orange", "orange", "red"];
const FLOOR = "quaternary"; // the dotted baseline under an idle graph
const PR_COLOR = { open: "green", merged: "purple", closed: "red" };

// ---------------------------------------------------------------------------
// Braille graphs. A cell is 2 columns x 4 dot rows; bit for each dot row,
// bottom to top, in the left and right column.
const LEFT_DOTS = [0x40, 0x04, 0x02, 0x01];
const RIGHT_DOTS = [0x80, 0x20, 0x10, 0x08];

// levels: one integer per column (0..lines*4). Returns lines top first; each
// line is 5 same-width layer strings: [floor, dot row 1 (bottom) .. dot row 4].
// Layers stack in a ZStack so every dot row gets its own gradient color.
function brailleLayers(levels, lines) {
  const out = [];
  for (let line = lines - 1; line >= 0; line -= 1) {
    const layers = ["", "", "", "", ""];
    for (let c = 0; c + 1 < levels.length; c += 2) {
      const l = Math.max(0, Math.min(4, levels[c] - line * 4));
      const r = Math.max(0, Math.min(4, levels[c + 1] - line * 4));
      let floor = 0;
      if (line === 0) {
        if (l === 0) floor |= LEFT_DOTS[0];
        if (r === 0) floor |= RIGHT_DOTS[0];
      }
      layers[0] += String.fromCharCode(0x2800 + floor);
      for (let k = 0; k < 4; k += 1) {
        const bits = (l > k ? LEFT_DOTS[k] : 0) | (r > k ? RIGHT_DOTS[k] : 0);
        layers[k + 1] += String.fromCharCode(0x2800 + bits);
      }
    }
    out.push(layers);
  }
  return out;
}

function graphLine(layers, heat, font = 11, fill = false) {
  const cell = (text, col) => {
    const t = text.font(font).monospaced().color(col).lineLimit(1).truncation("head");
    return fill ? t.frame({ maxWidth: "infinity", alignment: "leading" }) : t;
  };
  // Floor paints last: it never shares a dot with the data layers, and on
  // overflow the truncation glyph on top of the stack is then dim, not orange.
  return ZStack({ alignment: "leading" }, [
    ...[1, 2, 3, 4].map((k) => cell(Text(() => layers()[k]), heat[k - 1])),
    cell(Text(() => layers()[0]), FLOOR),
  ]);
}

// ---------------------------------------------------------------------------
// History: wsId -> Map(bucket -> { n: samples, busy: samples with a working agent }).
const history = new Map();
let lastSampled = -1;

const list = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// A workspace progress bar means delegated work is in flight even when the
// hosting agent's own lifecycle is idle.
function hasProgress(w) {
  return !!(w && w.progress && num(w.progress.value) !== null);
}

function workspaceWorking(w) {
  return hasProgress(w) || list(w.agents).some((a) => a.status === "working");
}

function backfill(h, agents, now) {
  const first = Math.floor(now / BUCKET) - KEEP + 1;
  for (const a of agents) {
    const since = num(a.sinceEpoch);
    if (a.status !== "working" || since === null || since >= now) continue;
    for (let b = Math.max(first, Math.floor(since / BUCKET)); b < Math.floor(now / BUCKET); b += 1) {
      h.set(b, { n: 1, busy: 1 });
    }
  }
}

function oldestEvictableHistory(protectedIds) {
  for (const id of history.keys()) if (!protectedIds.has(id)) return id;
  return null;
}

function sample(workspaces, now, liveIds = new Set(workspaces.map((w) => w.id))) {
  const bucket = Math.floor(now / BUCKET);
  const sampled = new Set(workspaces.map((w) => w.id));
  for (const id of Array.from(history.keys())) if (!liveIds.has(id)) history.delete(id);
  for (const w of workspaces) {
    const agents = list(w.agents);
    let h = history.get(w.id);
    if (!h) {
      if (history.size >= MAX_ROWS) {
        const evicted = oldestEvictableHistory(sampled);
        if (evicted !== null) history.delete(evicted);
      }
      h = new Map();
      backfill(h, agents, now);
    }
    const slot = h.get(bucket) ?? { n: 0, busy: 0 };
    slot.n += 1;
    if (workspaceWorking(w)) slot.busy += 1;
    h.set(bucket, slot);
    // Wall-clock corrections can move `bucket` backward. Drop future buckets
    // too, otherwise every clock era leaves another KEEP entries behind.
    for (const b of h.keys()) if (b <= bucket - KEEP || b > bucket) h.delete(b);
    // Map insertion order is the eviction order. Sampling makes this entry
    // most-recently used without retaining more than MAX_ROWS histories.
    history.delete(w.id);
    history.set(w.id, h);
  }
}

// Share of each bucket an agent was working, newest last.
function duty(h, count, bucket) {
  const out = [];
  for (let b = bucket - count + 1; b <= bucket; b += 1) {
    const s = h && h.get(b);
    out.push(s && s.n ? s.busy / s.n : 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row model.
function fmtAge(secs) {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h < 48 ? h + "h" : Math.floor(h / 24) + "d";
}

// The agent that represents the workspace: the most recently active one, so a
// live working session isn't masked by a stale sibling that stopped at a
// needs-input prompt hours ago. RANK breaks ties among equally-recent agents.
function lead(agents) {
  let best = null;
  let bestT = -Infinity;
  for (const a of agents) {
    const t = num(a.lastActivityAt) ?? num(a.sinceEpoch) ?? 0;
    const better = t > bestT || (t === bestT && (RANK[a.status] ?? 0) > (RANK[best?.status] ?? 0));
    if (!best || better) { best = a; bestT = t; }
  }
  return best;
}

// Tie-break weight when one surface has several conflicting records: an active
// turn is ground truth and outranks a stale needs_input left beside it.
const LIVE = { working: 4, needs_input: 2, idle: 1, ended: 0 };

// The hook store can emit more than one record for a single surface with
// conflicting lifecycles (a stale needs_input next to the live state). Collapse
// to one record per surface: freshest wins, and a live turn wins a timestamp
// tie, so a running agent is never shadowed by a stale needs_input.
function dedupeSurfaces(agents) {
  const best = new Map();
  for (const a of agents) {
    const key = a.surfaceId ?? a.pid ?? a.id ?? a;
    const t = num(a.lastActivityAt) ?? num(a.sinceEpoch) ?? 0;
    const cur = best.get(key);
    if (!cur) { best.set(key, a); continue; }
    const ct = num(cur.lastActivityAt) ?? num(cur.sinceEpoch) ?? 0;
    if (t > ct || (t === ct && (LIVE[a.status] ?? -1) > (LIVE[cur.status] ?? -1))) {
      best.set(key, a);
    }
  }
  return Array.from(best.values());
}

function rowModel(w, now) {
  const agents = dedupeSurfaces(list(w.agents));
  const top = lead(agents);
  const unread = num(w.unread) || 0;
  // Unread is the "look at me" signal: it colours the row until you view the
  // workspace. The word stays truthful to the agent's lifecycle, so a finished
  // turn reads `idle`, not `input`.
  const attention = unread > 0 && !w.selected;
  const progress = hasProgress(w) ? Math.max(0, Math.min(1, w.progress.value)) : null;
  const progressLabel = progress !== null && typeof w.progress.label === "string" ? w.progress.label.trim() : "";
  // Delegated work in flight keeps the row running even while the hosting
  // agent's own lifecycle sits idle between turns.
  const state = progress !== null ? "working"
    : top && STATE[top.status] ? top.status
    : "none";
  const bucket = Math.floor(now / BUCKET);
  const levels = duty(history.get(w.id), ROW_CELLS * 2, bucket)
    .map((d) => (d > 0 ? Math.max(1, Math.round(d * 4)) : 0));
  const since = top ? num(top.sinceEpoch) ?? num(top.lastActivityAt) : null;
  const age = since !== null && now > 0 ? fmtAge(now - since) : "";
  const pr = w.pr && num(w.pr.number) !== null ? w.pr : null;
  const running = Math.max(
    agents.filter((a) => a.status === "working").length,
    progress !== null ? 1 : 0,
  );
  return {
    id: w.id,
    title: w.title || "untitled",
    selected: !!w.selected,
    tint: w.color || null,
    state,
    glyph: attention && state !== "working" ? STATE.needs_input.glyph
      : state === "working" ? SPINNER[now % SPINNER.length] : STATE[state].glyph,
    working: state === "working",
    count: running > 1 ? "×" + running : "",
    unread,
    attention,
    prLabel: pr ? "#" + pr.number : "",
    prColor: pr ? PR_COLOR[pr.status] ?? "secondary" : "secondary",
    prURL: pr ? pr.url || "" : "",
    layers: brailleLayers(levels, 1)[0],
    meterOn: progress === null ? "" : "■".repeat(Math.round(progress * METER)),
    meterOff: progress === null ? "" : "■".repeat(METER - Math.round(progress * METER)),
    meterText: progress === null ? "" : progressLabel || Math.round(progress * 100) + "%",
    status: progress === null && state !== "none" ? STATE[state].word + " " + age : "",
    busy: running > 0 || attention,
    running,
    group: w.group ?? null,
    pinned: !!w.pinned,
  };
}

function workspaceIsBusy(w) {
  return ((num(w.unread) || 0) > 0 && !w.selected) || workspaceWorking(w);
}

function cappedWorkspaces(workspaces, onlyBusy) {
  const capped = [];
  let selected = null;
  for (const w of workspaces) {
    if (!selected && w.selected) selected = w;
    if (capped.length < MAX_ROWS && (!onlyBusy || workspaceIsBusy(w) || w.selected)) {
      capped.push(w);
    }
  }
  if (selected && !capped.some((w) => w.id === selected.id)) {
    if (capped.length === MAX_ROWS) capped[MAX_ROWS - 1] = selected;
    else capped.push(selected);
  }
  return capped;
}

const [busyOnly, setBusyOnly] = signal(false);

// Multi-select: Cmd-click toggles, Shift-click extends from the last click
// over the visible row order, plain click clears and focuses. The selection
// drives the context menu's bulk actions and moves as a block when dragged.
const multiSelected = new Set();
const [multiTick, setMultiTick] = signal(0);
let lastClickedId = null;

function isMultiSelected(id) {
  multiTick();
  return multiSelected.has(id);
}

function clearMultiSelect() {
  if (multiSelected.size === 0) return;
  multiSelected.clear();
  setMultiTick(multiTick() + 1);
}

function handleRowClick(id, payload) {
  if (payload && payload.cmd) {
    if (multiSelected.has(id)) multiSelected.delete(id);
    else multiSelected.add(id);
    setMultiTick(multiTick() + 1);
  } else if (payload && payload.shift && lastClickedId) {
    const order = shown().map((r) => r.id);
    const a = order.indexOf(lastClickedId);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      for (const rid of order.slice(Math.min(a, b), Math.max(a, b) + 1)) multiSelected.add(rid);
      setMultiTick(multiTick() + 1);
    }
  } else {
    clearMultiSelect();
    setLitGroup(null);
    cmux("workspace.select", { workspace_id: id });
  }
  lastClickedId = id;
}

// Workspaces a bulk menu action applies to: the multi-selection when the
// clicked row is part of it, else just the clicked row.
function bulkIds(id) {
  multiTick();
  return multiSelected.has(id) ? Array.from(multiSelected) : [id];
}

// Workspace selection changes only when workspace data or the ALL/BUSY mode
// changes. Keep the one-second clock out of this full-list pass; the clocked
// snapshot below should touch only the admitted rows and bounded history.
const workspaceSelection = computed(() => {
  const allWorkspaces = list(data.workspaces());
  return {
    workspaces: cappedWorkspaces(allWorkspaces, busyOnly()),
    liveIds: new Set(allWorkspaces.map((w) => w.id)),
  };
});

const snapshot = computed(() => {
  const now = Math.floor(num(data.clock()?.epoch) ?? 0);
  const selection = workspaceSelection();
  const workspaces = selection.workspaces;
  if (now > 0 && now !== lastSampled) {
    sample(workspaces, now, selection.liveIds);
    lastSampled = now;
  }
  const rows = workspaces.map((w) => rowModel(w, now));

  // Header graph: how many workspaces were busy, per bucket.
  const bucket = Math.floor(now / BUCKET);
  const sums = new Array(TOP_CELLS * 2).fill(0);
  for (const h of history.values()) {
    duty(h, TOP_CELLS * 2, bucket).forEach((d, i) => { sums[i] += d; });
  }
  const peak = Math.max(...sums);
  const scale = Math.max(4, Math.ceil(peak));
  const levels = sums.map((s) => (s > 0 ? Math.max(1, Math.round((s / scale) * 8)) : 0));

  let working = 0, waiting = 0;
  for (const w of workspaces) {
    if ((num(w.unread) || 0) > 0 && !w.selected) waiting += 1;
    let agentsWorking = 0;
    for (const a of dedupeSurfaces(list(w.agents))) {
      if (a.status === "working") agentsWorking += 1;
    }
    working += Math.max(agentsWorking, hasProgress(w) ? 1 : 0);
  }
  return {
    now,
    rows,
    top: brailleLayers(levels, 2),
    working,
    waiting,
    busyCount: rows.filter((r) => r.busy).length,
  };
});

// ---------------------------------------------------------------------------
// Groups. Collapse is applied optimistically so the chevron answers at once.
const collapseOverride = new Map();
const [collapseTick, setCollapseTick] = signal(0);

function isCollapsed(g) {
  collapseTick();
  if (collapseOverride.has(g.id)) {
    const v = collapseOverride.get(g.id);
    if (v === g.collapsed) collapseOverride.delete(g.id); // host caught up
    else return v;
  }
  return !!g.collapsed;
}

function toggleCollapse(g) {
  const next = !isCollapsed(g);
  collapseOverride.set(g.id, next);
  setCollapseTick(collapseTick() + 1);
  cmux(next ? "workspace.group.collapse" : "workspace.group.expand", { group_id: g.id });
}

const groupById = (id) => list(data.groups()).find((g) => g.id === id);

// Group being renamed inline (header swaps for a text field), or null.
const [editingGroup, setEditingGroup] = signal(null);
// cmux() returns nothing, so a freshly created group is found by diffing the
// group ids known before the create; it then opens straight into rename.
let pendingRename = null; // Set of group ids before the create, or null
let autoEditGroup = null;
const [editTick, setEditTick] = signal(0);

function beginRename(id) { autoEditGroup = null; setEditingGroup(id); }
function endRename() { autoEditGroup = null; setEditingGroup(null); setEditTick(editTick() + 1); }

function createGroup(ids) {
  pendingRename = new Set(list(data.groups()).map((g) => g.id));
  cmux("workspace.group.create", { name: "New Group", child_workspace_ids: JSON.stringify(ids) });
}

// One flat list of entries for the Reorderable: group headers (fixed) and
// workspace rows. A group sits at its anchor's position (falling back to its
// first visible member) and, unlike the built-in sidebar, the anchor keeps
// its own activity row under the header. Pinned rows and groups cluster at
// the top. In BUSY mode a group appears when any member survived the filter.
const flatEntries = computed(() => {
  const rows = snapshot().rows;
  const groups = new Map(list(data.groups()).map((g) => [g.id, g]));
  const byGroup = new Map();
  for (const r of rows) {
    if (r.group && groups.has(r.group)) {
      if (!byGroup.has(r.group)) byGroup.set(r.group, []);
      byGroup.get(r.group).push(r);
    }
  }
  editTick();
  if (pendingRename) {
    const fresh = list(data.groups()).find((g) => !pendingRename.has(g.id));
    if (fresh) { autoEditGroup = fresh.id; pendingRename = null; }
  }
  const editing = editingGroup() ?? autoEditGroup;
  const section = (g) => {
    const members = byGroup.get(g.id) ?? [];
    // The key changes while editing so the Reorderable rebuilds the header.
    const out = [{
      kind: "header",
      id: "h:" + g.id + (editing === g.id ? ":edit" : ""),
      groupId: g.id,
      editing: editing === g.id,
    }];
    if (!isCollapsed(g)) for (const m of members) out.push({ kind: "ws", id: m.id, groupId: g.id });
    return out;
  };
  const pinned = [];
  const rest = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.group && groups.has(r.group)) {
      const g = groups.get(r.group);
      const members = byGroup.get(g.id);
      const isAnchor = r.id === g.anchorId || !members.some((m) => m.id === g.anchorId);
      if (seen.has(g.id) || !isAnchor) continue;
      seen.add(g.id);
      (g.pinned ? pinned : rest).push(...section(g));
    } else {
      (r.pinned ? pinned : rest).push({ kind: "ws", id: r.id, groupId: null });
    }
  }
  const all = [...pinned, ...rest];
  // Breathing room at group boundaries: above each header and above the
  // first ungrouped row that follows a group.
  for (let i = 1; i < all.length; i += 1) {
    const e = all[i];
    const prev = all[i - 1];
    e.gapAbove = e.kind === "header" || (prev.groupId !== null && e.groupId === null);
  }
  return all;
});

// Group whose header was clicked last: its member rows get a faint wash
// until a workspace row is plainly clicked.
const [litGroup, setLitGroup] = signal(null);
const GROUP_GAP = 8;

const shown = computed(() => snapshot().rows);
const rowsById = computed(() => new Map(snapshot().rows.map((r) => [r.id, r])));
const visibleRowIds = () => flatEntries().filter((e) => e.kind === "ws").map((e) => e.id);

// Drop resolution over the flat list (headers included). The container is
// taken from the staying neighbor above, or below when `extra.side` says the
// pointer leaned that way at a group boundary. Group headers are fixed, so
// only workspace rows move; a multi-selection moves as one contiguous block.
function move(id, index, extra) {
  multiTick();
  const bulk = multiSelected.has(id) && multiSelected.size > 1;
  const movingIds = bulk
    ? visibleRowIds().filter((rid) => multiSelected.has(rid) || rid === id)
    : [id];
  const moving = new Set(movingIds);
  const stays = (e) => !(e.kind === "ws" && moving.has(e.id));
  const entries = flatEntries().filter((e) => e.id !== id);

  let prev = null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (stays(entries[i])) { prev = entries[i]; break; }
  }
  const nextAny = entries.slice(index).find(stays) ?? null;
  const nextRow = entries.slice(index).find((e) => {
    if (e.kind === "header") return !moving.has(groupById(e.groupId)?.anchorId);
    return stays(e);
  });
  const nextRefId = nextRow
    ? (nextRow.kind === "header" ? groupById(nextRow.groupId)?.anchorId : nextRow.id)
    : null;

  let container;
  if (extra && extra.side === "below") {
    container = nextAny && nextAny.kind === "ws" ? nextAny.groupId : null;
  } else {
    container = prev ? prev.groupId : null;
    if (prev && prev.kind === "header") {
      const g = groupById(prev.groupId);
      const dragged = rowsById().get(id);
      if (g && isCollapsed(g) && dragged?.group !== g.id) container = null;
    }
  }

  const all = list(data.workspaces());
  for (const rid of movingIds) {
    const w = all.find((x) => x.id === rid);
    if (!w || (w.group ?? null) === container) continue;
    if (container) cmux("workspace.group.add", { group_id: container, workspace_id: rid });
    else cmux("workspace.group.remove", { workspace_id: rid });
  }

  const allIds = all.map((w) => w.id);
  const rest = allIds.filter((x) => !moving.has(x));
  let insertAt = nextRefId ? rest.indexOf(nextRefId) : rest.length;
  if (insertAt < 0) insertAt = rest.length;
  if (bulk) {
    const full = [...rest.slice(0, insertAt), ...movingIds, ...rest.slice(insertAt)];
    cmux("workspace.reorder_many", { workspace_ids: JSON.stringify(full) });
  } else {
    cmux("workspace.reorder", { workspace_id: id, index: Math.max(0, insertAt) });
  }
  clearMultiSelect();
}

// ---------------------------------------------------------------------------
// Views.
function header() {
  const spin = () => SPINNER[snapshot().now % SPINNER.length];
  const running = () => snapshot().working;
  return VStack({ spacing: 8 }, [
    VStack({ spacing: 3 }, [
      HStack({ spacing: 6 }, [
        Text(() => (running() ? spin() : "●")).font(13).monospaced()
          .color(() => (running() ? STATE.working.color : "quaternary")),
        Text(() => running() + " running").font(13).weight("semibold")
          .color(() => (running() ? "primary" : "secondary")).lineLimit(1),
        Spacer({ minLength: 0 }),
        Text(() => data.clock()?.time ?? "").font(12).monospaced().color("tertiary").lineLimit(1),
      ]),
      HStack({ spacing: 6 }, [
        Text("◆").font(13).monospaced()
          .color(() => (snapshot().waiting ? STATE.needs_input.color : "quaternary")),
        Text(() => snapshot().waiting + " waiting").font(13).weight("semibold")
          .color(() => (snapshot().waiting ? "primary" : "secondary")).lineLimit(1),
        Spacer({ minLength: 0 }),
      ]),
    ]),
    VStack({ spacing: 0 }, [0, 1].map((line) =>
      graphLine(() => snapshot().top[line], line === 0 ? TOP_HEAT.slice(4) : TOP_HEAT.slice(0, 4)))),
    HStack({ spacing: 4 }, [
      Text("agents working").font(11).color("tertiary").lineLimit(1),
      Spacer({ minLength: 0 }),
      Text("last " + Math.round((TOP_CELLS * 2 * BUCKET) / 60) + " min")
        .font(11).monospaced().color("tertiary").lineLimit(1),
    ]),
  ]).frame({ maxWidth: "infinity" });
}

function chip(label, active, onTap) {
  return Text(label).font(11).monospaced().weight("semibold")
    .color(() => (active() ? "primary" : "tertiary"))
    .paddingHorizontal(6).paddingVertical(2)
    .cornerRadius(4)
    .background(() => (active() ? "#7f7f7f33" : "clear"))
    .hoverBackground("#7f7f7f26")
    .onTap(onTap);
}

function groupHeader(groupId, e) {
  const g = () => groupById(groupId) ?? { id: groupId, name: "", collapsed: false, pinned: false };
  const members = () => shown().filter((r) => r.group === groupId);
  const running = () => members().reduce((n, r) => n + r.running, 0);
  const waiting = () => members().filter((r) => r.attention).length;
  const anchorSelected = () => members().some((r) => r.selected && r.id === g().anchorId);
  return HStack({ spacing: 5 }, [
    Image("chevron.right")
      .font(10).weight("semibold").color("tertiary")
      .rotation(() => (isCollapsed(g()) ? 0 : 90))
      .frame({ width: 14, height: 16 })
      .onTap(() => toggleCollapse(g())),
    Text(() => g().name || "group").font(12).weight("semibold")
      .color(() => (g().customColor ? g().customColor : anchorSelected() ? "primary" : "secondary"))
      .lineLimit(1).truncation("tail"),
    Text(() => members().length + "").font(11).monospaced().color("quaternary"),
    Spacer({ minLength: 0 }),
    Text(() => (running() ? SPINNER[snapshot().now % SPINNER.length] + " " + running() : ""))
      .font(11).monospaced().color(STATE.working.color),
    Text(() => (waiting() ? STATE.needs_input.glyph + " " + waiting() : ""))
      .font(11).monospaced().color(STATE.needs_input.color),
  ])
    .paddingLeading(6).paddingTrailing(8).paddingVertical(4)
    .cornerRadius(6)
    .background(() => (anchorSelected() || litGroup() === groupId ? "#7f7f7f1f" : "clear"))
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity" })
    .paddingTop(() => (e().gapAbove ? GROUP_GAP : 0))
    .fixed()
    .block("h:" + groupId)
    .onTap(() => {
      setLitGroup(groupId);
      if (g().anchorId) cmux("workspace.select", { workspace_id: g().anchorId });
    })
    .onDoubleTap(() => beginRename(groupId))
    .contextMenu([
      Button("Rename Group", () => beginRename(groupId)),
      Button(() => (isCollapsed(g()) ? "Expand" : "Collapse"), () => toggleCollapse(g())),
      Button(() => (g().pinned ? "Unpin Group" : "Pin Group"), () =>
        cmux(g().pinned ? "workspace.group.unpin" : "workspace.group.pin", { group_id: groupId })),
      Button("Mark All Read", () => {
        for (const r of members()) cmux("workspace.action", { workspace_id: r.id, action: "mark_read" });
      }),
      Divider(),
      // Dissolves the group and keeps every chat. There is deliberately no
      // "Delete Group": that would close every workspace in the group.
      Button("Ungroup", () => cmux("workspace.group.ungroup", { group_id: groupId })),
    ]);
}

// Same geometry as groupHeader so entering rename only makes the text editable.
function groupEditRow(groupId, e) {
  const g = () => groupById(groupId) ?? { id: groupId, name: "", collapsed: false };
  return HStack({ spacing: 5 }, [
    Image("chevron.right")
      .font(10).weight("semibold").color("tertiary")
      .rotation(() => (isCollapsed(g()) ? 0 : 90))
      .frame({ width: 14, height: 16 }),
    TextField(() => g().name ?? "", {
      placeholder: "Group name",
      onSubmit: (t) => {
        const name = (t ?? "").trim();
        if (name) cmux("workspace.group.rename", { group_id: groupId, name });
        endRename();
      },
      onCancel: endRename,
    }).font(12).weight("semibold"),
  ])
    .paddingLeading(6).paddingTrailing(8).paddingVertical(4)
    .cornerRadius(6)
    .background("#7f7f7f1f")
    .frame({ maxWidth: "infinity" })
    .paddingTop(() => (e().gapAbove ? GROUP_GAP : 0))
    .fixed();
}

function row(r, entry, e) {
  const color = () => (r().attention ? STATE.needs_input.color : STATE[r().state].color);
  const groupItems = list(data.groups())
    .map((g) => Button(g.name || "group", () => {
      for (const id of bulkIds(r().id)) cmux("workspace.group.add", { group_id: g.id, workspace_id: id });
      clearMultiSelect();
    }));
  return HStack({ spacing: 5 }, [
    RoundedRectangle({ width: 3, height: 34, cornerRadius: 1.5 })
      .fill(() => (r().attention ? STATE.needs_input.color
        : r().selected ? r().tint ?? "accent"
        : r().tint ? r().tint + "55" : "clear")),
    VStack({ spacing: 3 }, [
      HStack({ spacing: 4 }, [
        Text(() => r().glyph).font(14).monospaced().color(color)
          .frame({ width: 14, alignment: "center" }),
        Text(() => r().title).font(14)
          .weight(() => (r().selected ? "semibold" : "regular"))
          .color(() => (r().state === "none" && !r().selected ? "secondary" : "primary"))
          .lineLimit(1).truncation("tail"),
        Text(() => r().count).font(11).monospaced().color(color),
        Spacer({ minLength: 0 }),
        Text(() => r().prLabel).font(11).monospaced().color(() => r().prColor)
          .paddingHorizontal(3).cornerRadius(3).hoverBackground("#7f7f7f33")
          .onTap(() => { if (r().prURL) openURL(r().prURL); }),
      ]),
      HStack({ spacing: 6 }, [
        Text(() => r().meterText || r().status).font(11).monospaced()
          .color(() => (r().meterText ? "secondary" : r().attention ? STATE.needs_input.color : "tertiary"))
          .lineLimit(1).frame({ width: 64, alignment: "leading" }),
        graphLine(() => r().layers, ROW_HEAT, 10, true),
        HStack({ spacing: 0 }, [
          Text(() => r().meterOn).font(10).monospaced().color("accent"),
          Text(() => r().meterOff).font(10).monospaced().color("quaternary"),
        ]),
      ]).paddingLeading(4),
    ]).frame({ maxWidth: "infinity" }),
  ])
    .paddingHorizontal(2).paddingVertical(5)
    .cornerRadius(6)
    .background(() => (isMultiSelected(r().id) ? "#4C9EEB33"
      : r().selected ? "#7f7f7f1f"
      : r().group && litGroup() === r().group ? "#7f7f7f10"
      : "clear"))
    .hoverBackground(() => (isMultiSelected(r().id) ? "#4C9EEB33" : "#7f7f7f26"))
    .frame({ maxWidth: "infinity" })
    .paddingTop(() => (e().gapAbove ? GROUP_GAP : 0))
    .marginLeading(() => (entry.groupId ? 4 : 0))
    .block(() => (entry.groupId ? "h:" + entry.groupId : null))
    .dragSet(() => (isMultiSelected(r().id) ? "multi" : null))
    .onTap((payload) => handleRowClick(r().id, payload))
    .contextMenu([
      // Only when cmux has attached a pull request to this workspace.
      ...(r().prURL ? [Button("Open PR " + r().prLabel, () => openURL(r().prURL)), Divider()] : []),
      Button(() => {
        const n = bulkIds(r().id).length;
        return n > 1 ? "Mark " + n + " Read" : "Mark Read";
      }, () => {
        for (const id of bulkIds(r().id)) cmux("workspace.action", { workspace_id: id, action: "mark_read" });
        clearMultiSelect();
      }),
      Divider(),
      Button(() => {
        const n = bulkIds(r().id).length;
        return n > 1 ? "New Group from " + n + " Workspaces" : "New Group with This";
      }, () => {
        createGroup(bulkIds(r().id));
        clearMultiSelect();
      }),
      Menu("Move to Group", groupItems),
      Button("Remove from Group", () => {
        for (const id of bulkIds(r().id)) cmux("workspace.group.remove", { workspace_id: id });
        clearMultiSelect();
      }),
      Divider(),
      Button(() => {
        const n = bulkIds(r().id).length;
        return n > 1 ? "Close " + n + " Workspaces" : "Close";
      }, () => {
        for (const id of bulkIds(r().id)) cmux("workspace.close", { workspace_id: id });
        clearMultiSelect();
      }).destructive(),
    ]);
}

sidebar(() =>
  VStack({ spacing: 8 }, [
    header().paddingHorizontal(8).paddingTop(16),
    HStack({ spacing: 4 }, [
      chip("ALL", () => !busyOnly(), () => setBusyOnly(false)),
      chip("BUSY", busyOnly, () => setBusyOnly(true)),
      Spacer({ minLength: 0 }),
      Text(() => snapshot().busyCount + "/" + snapshot().rows.length + " busy")
        .font(11).monospaced().color("tertiary"),
    ]).paddingHorizontal(8),
    Divider(),
    Reorderable({ items: flatEntries, key: (e) => e.id, onMove: move, spacing: 1 }, (e) => {
      const entry = e(); // kind and ids are stable per key
      if (entry.kind === "header") {
        return entry.editing ? groupEditRow(entry.groupId, e) : groupHeader(entry.groupId, e);
      }
      let last = rowsById().get(entry.id);
      const r = () => (last = rowsById().get(entry.id) ?? last);
      return row(r, entry, e);
    }),
    Text(() => (shown().length ? "" : busyOnly() ? "all quiet" : "no workspaces"))
      .font(11).monospaced().color("tertiary").paddingHorizontal(8),
    Spacer(),
  ]).paddingHorizontal(0),
  { surface: "glass" }
)
