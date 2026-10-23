-- The client owns Codex RPC. This panel reads only its explicit list snapshot
-- and sends UI actions back through Tern; it never sends a prompt or starts Codex.
local PREFIX = "codex-tern.sessions/v1:"
local panels = {}
local timer = nil
local fast_until = 0
local selection_seq = 0

local function bridge(cx, target)
  local ok, tree = pcall(function()
    return cx.session:surface(target, {root = "dock.sessions", nodes = 2, max_chars = 64000})
  end)
  if not ok or not tree or not tree.surface or tree.surface.role ~= "codex-tern" then return nil end
  local function find(node)
    if not node then return nil end
    if node.id == "dock.sessions" then return node end
    for _, child in node.c or {} do
      local found = find(child)
      if found then return found end
    end
    return nil
  end
  local node = find(tree.dock) or find(tree.main) or find(tree.layer)
  if not node or not node.p or not node.p.title then return nil end
  local decoded, snapshot = pcall(tern.json.decode, node.p.title)
  if not decoded or snapshot.version ~= 1 or type(snapshot.rows) ~= "table" then return nil end
  return {sf = tree.surface.id, snapshot = snapshot, raw = node.p.title}
end

local function send(cx, target, act, value)
  local state = bridge(cx, target)
  if not state then return false end
  cx.session:event(target, {sf = state.sf, ev = "action", id = "dock.sessions", act = act, value = value})
  return true
end

local function view(snapshot, selection)
  local rows = {}
  local current = if selection then selection.id else snapshot.current
  local folder = string.match(snapshot.cwd or "", "([^/]+)/*$") or snapshot.cwd or "Sessions"
  table.insert(rows, {k = "text", p = {key = "folder", role = "codex-tern.sessions.folder", text = folder, title = snapshot.cwd}})
  table.insert(rows, {k = "row", p = {key = "new", role = "codex-tern.sessions.new", align = "center", gap = "sm",
    title = "New session · Ctrl+Shift+N", mark = if snapshot.canSwitch then nil else "disabled",
    actions = if snapshot.canSwitch then {click = "new"} else nil}, c = {
      {k = "icon", p = {key = "icon", name = "plus"}},
      {k = "text", p = {key = "label", text = "New session"}},
    }})
  for _, item in snapshot.rows do
    local locked = item.locked and item.id ~= snapshot.current
    local title = {k = "row", p = {key = "heading", align = "center", gap = "sm"}, c = {
      {k = "text", p = {key = "title", role = "codex-tern.sessions.title", text = item.title,
        title = item.title .. "\n" .. item.time, lines = 1, grow = 1}},
    }}
    if locked then
      table.insert(title.c, {k = "icon", p = {key = "status", name = "lock", role = "codex-tern.sessions.lock", title = "Open in another client"}})
    elseif item.waiting then
      table.insert(title.c, {k = "icon", p = {key = "status", name = "bell", role = "codex-tern.sessions.waiting", title = "Needs your input"}})
    elseif item.running and (not selection or item.id ~= current or selection.running) then
      table.insert(title.c, {k = "spinner", p = {key = "status", role = "codex-tern.sessions.running", title = "Working"}})
    end
    local can_delete = snapshot.archiveProtocol == 1 and item.canArchive and not locked
    table.insert(title.c, {k = "icon", p = {key = "delete", name = "trash", role = "codex-tern.sessions.delete",
      aria = "Delete session", mark = if can_delete then nil else "disabled",
      title = if snapshot.archiveProtocol ~= 1 then "Restart the Codex client to enable deleting sessions"
        elseif not can_delete then "Finish this session's task, answers, queue and draft before deleting"
        else "Delete session (move to archive)",
      actions = {click = (if can_delete then "archive=" else "archive-disabled=") .. item.id}}})
    table.insert(rows, {k = "col", p = {key = item.id, role = "codex-tern.sessions.item",
      mark = if item.id == current then "pick" elseif locked then "locked" else nil,
      title = item.title, actions = if locked then nil else {click = "resume=" .. item.id}}, c = {
        title,
      }})
  end
  local note = snapshot.error
  if note == nil or note == "" then
    if not snapshot.connected then note = "Codex disconnected."
    elseif snapshot.loading and #snapshot.rows == 0 then note = "Loading…"
    elseif #snapshot.rows == 0 then note = "No sessions in this folder."
    elseif not snapshot.canSwitch then note = snapshot.blockedReason end
  end
  -- Keep the keyed structure stable while a switch is in flight.
  table.insert(rows, {k = "text", p = {key = "note", role = "codex-tern.sessions.note",
    hidden = not note or note == "", tone = "muted", text = note or ""}})
  if snapshot.more then
    table.insert(rows, {k = "text", p = {key = "more", role = "codex-tern.sessions.note", text = "Load more", actions = {click = "more"}}})
  end
  return {k = "col", p = {key = "sessions", role = "codex-tern.sessions"}, c = rows}
end

local function paint(cx, pane, entry, snapshot)
  local next_view = view(snapshot, entry.selection)
  local previous = entry.view
  local same_order = previous ~= nil and #previous.c == #next_view.c
  if same_order then
    for i, node in next_view.c do
      if node.p.key ~= previous.c[i].p.key then same_order = false; break end
    end
  end
  if same_order then
    local patch = {}
    for i, node in next_view.c do
      if tern.json.encode(node) ~= tern.json.encode(previous.c[i]) then
        patch[node.p.key] = node
      end
    end
    if next(patch) then cx.canvas:set(pane, {set = patch}) end
  else
    cx.canvas:set(pane, {view = next_view})
  end
  entry.view = next_view
end

local function remember(cx)
  for _, canvas in cx.canvas:list() do
    if canvas.owner == tern.plugin.id and string.sub(canvas.about or "", 1, #PREFIX) == PREFIX then
      local target = tonumber(string.sub(canvas.about, #PREFIX + 1))
      if target and not panels[canvas.pane] then panels[canvas.pane] = {target = target, refreshed = 0} end
    end
  end
end

local function update(cx, pane, entry)
  if not cx.session:pane(pane) or not cx.canvas:get(pane) then panels[pane] = nil; return end
  local state = bridge(cx, entry.target)
  if not state then
    if entry.raw ~= "closed" then
      cx.canvas:set(pane, {view = {k = "text", p = {role = "codex-tern.sessions.note", text = "The Codex client is closed."}}})
      entry.raw = "closed"
      entry.selection = nil
    end
    return
  end
  local previous_selection = entry.selection
  if entry.selection then
    local selection = entry.selection
    local navigation = state.snapshot.navigation
    if not state.snapshot.connected
      or (navigation and navigation.request == selection.request and not navigation.pending) then
      entry.selection = nil
    elseif state.snapshot.navigationProtocol ~= 1 then
      -- Older running clients have no acknowledgement. Use their result instead.
      if state.snapshot.current == selection.id or (state.snapshot.error and state.snapshot.error ~= "")
        or tern.now() - selection.started > 90000 then entry.selection = nil end
      for _, item in state.snapshot.rows do
        if item.id == selection.id and item.locked then entry.selection = nil; break end
      end
    end
  end
  if state.raw ~= entry.raw or previous_selection ~= entry.selection then
    paint(cx, pane, entry, state.snapshot)
    entry.raw = state.raw
  end
  if tern.now() - entry.refreshed > 15000 then
    send(cx, entry.target, "refresh")
    entry.refreshed = tern.now()
  end
  if tern.now() - (entry.locks_refreshed or 0) > 2000 then
    send(cx, entry.target, "locks")
    entry.locks_refreshed = tern.now()
  end
end

local function poll(fast)
  if fast then
    fast_until = tern.now() + 2000
    if timer then timer:cancel(); timer = nil end
  end
  if timer or next(panels) == nil then return end
  local live = false
  for _, entry in panels do if entry.raw ~= "closed" then live = true; break end end
  if not live then return end
  -- Clicks need a prompt response; an idle panel can poll less often.
  timer = tern.timer(if tern.now() < fast_until then 50 else 700, function(cx)
    timer = nil
    if cx then for pane, entry in panels do update(cx, pane, entry) end end
    poll()
  end)
end

local function open(cx, automatic_target)
  remember(cx)
  local focused = cx.session:focused()
  local target = automatic_target or (if focused and panels[focused] then panels[focused].target else focused)
  local tab = if focused then cx.session:tab_of(focused) else nil
  if not target or not bridge(cx, target) then
    target = nil
    for _, pane in cx.session:panes() do
      if pane.tab == tab and bridge(cx, pane.pane) then target = pane.pane; break end
    end
  end
  if not target then cx:toast("info", "Open Codex × Tern in this tab first."); return end
  local state = bridge(cx, target)
  for pane, entry in panels do
    if entry.target == target and cx.session:pane(pane) then
      send(cx, target, "refresh"); update(cx, pane, entry)
      poll(true)
      return
    end
  end
  if not automatic_target then cx.layout:focus(target) end
  local pane, err = cx.canvas:open({title = "Sessions", view = view(state.snapshot),
    about = PREFIX .. tostring(target), how = "beside", focus = false})
  if not pane then cx:toast("error", "Could not open Codex sessions", err); return end
  cx.layout:move(pane, target, "left", {focus = false})
  -- The layout uses Tern's window font; TSP cols may use a different cell size.
  -- Measure one resize step against the actual split instead of mixing units.
  local function pane_split(node)
    if not node or node.pane then return nil end
    if node.split == "right" and node[1] and node[1].pane == pane then return node end
    return pane_split(node[1]) or pane_split(node[2])
  end
  local owner_tab = cx.session:tab_of(pane)
  local layout = if owner_tab then cx.session:layout(owner_tab) else nil
  local split = if layout then pane_split(layout.root) else nil
  if split and split.ratio then
    local before = split.ratio
    cx.layout:resize(pane, "right", 1)
    local after = pane_split(cx.session:layout(owner_tab).root)
    local step = if after and after.ratio then after.ratio - before else 0
    local width = (state.snapshot.cols or 120) * (state.snapshot.cellWidth or 8)
    local desired = math.min(0.30, 420 / width)
    if step > 0 then cx.layout:resize(pane, "right", math.round((desired - after.ratio) / step)) end
  end
  panels[pane] = {target = target, raw = state.raw, view = view(state.snapshot), refreshed = tern.now(), locks_refreshed = tern.now()}
  send(cx, target, "refresh")
  poll(true)
end

tern.command({id = "sessions", title = "Codex: Sessions", icon = "history", run = function(cx)
  -- Startup requests identify their client explicitly, even if focus changed
  -- while Codex connected. The regular command can still reopen a closed rail.
  local requested = false
  for _, pane in cx.session:panes() do
    local state = bridge(cx, pane.pane)
    if state and state.snapshot.sidebarRequest then
      open(cx, pane.pane)
      requested = true
    end
  end
  if not requested then open(cx) end
end})

tern.on("canvas_action", function(ev, cx)
  remember(cx)
  local entry = panels[ev.pane]
  if not entry then return true end
  if ev.act == "resume" and ev.value then
    local state = bridge(cx, entry.target)
    if state then
      local found = false
      local running = false
      for _, row in state.snapshot.rows do
        if row.id == ev.value and not row.locked then found = true; running = row.running; break end
      end
      if found then
        selection_seq += 1
        local request = tostring(tern.now()) .. ":" .. tostring(selection_seq)
        entry.selection = {id = ev.value, request = request, started = tern.now(), running = running}
        -- Paint before waiting for history, client rendering or the next poll.
        paint(cx, ev.pane, entry, state.snapshot)
        local value = if state.snapshot.navigationProtocol == 1
          then tern.json.encode({id = ev.value, request = request}) else ev.value
        send(cx, entry.target, "resume", value)
        cx.layout:focus(entry.target)
        poll(true)
      end
    end
  elseif ev.act == "new" then
    local state = bridge(cx, entry.target)
    if state and state.snapshot.canSwitch then
      -- New clients route through the stable bridge, independent of toolbar layout.
      -- Keep the old button route for clients already running before this update.
      if state.snapshot.newSessionProtocol == 1 then
        send(cx, entry.target, "new")
      else
        cx.session:event(entry.target, {sf = state.sf, ev = "action", id = "dock.nav.new", act = "click"})
      end
      cx.layout:focus(entry.target)
      poll(true)
    end
  elseif ev.act == "archive" and ev.value then
    local state = bridge(cx, entry.target)
    if state and state.snapshot.archiveProtocol == 1 then
      for _, row in state.snapshot.rows do
        if row.id == ev.value and row.canArchive and not row.locked then
          send(cx, entry.target, "archive", ev.value)
          cx.layout:focus(entry.target)
          poll(true)
          break
        end
      end
    end
  elseif ev.act == "archive-disabled" then
    local state = bridge(cx, entry.target)
    cx:toast("info", if state and state.snapshot.archiveProtocol == 1
      then "Finish this session's task, answers, queue and draft before deleting."
      else "Exit the Codex client with Ctrl+Q, then run codex-tern again to enable deleting sessions.")
  elseif ev.act == "more" then send(cx, entry.target, "more"); poll(true) end
  -- Always consume owned clicks, including stale ones. Never fall through to Carly.
  return true
end)

tern.on("pane_closed", function(ev, cx)
  local entry = panels[ev.pane]
  if entry then send(cx, entry.target, "hide"); panels[ev.pane] = nil end
end)

local function restore(cx)
  remember(cx)
  for pane, entry in panels do update(cx, pane, entry) end
  poll()
end

tern.on("window_start", restore)
-- window_start runs once per plugin per window, not after every plugin reload.
-- A fresh VM must recover the existing canvases and restart their refresh timer.
tern.timer(0, function(cx) if cx then restore(cx) end end)
