-- An independent, movable native card. It follows one client's selected session.
local toc = require("./toc")
local outline = {}
local PREFIX = "codex-tern.toc/v1:"
local panels = {}

function outline.remember(cx)
  for _, canvas in cx.canvas:list() do
    if canvas.owner == tern.plugin.id and string.sub(canvas.about or "", 1, #PREFIX) == PREFIX then
      local target = tonumber(string.sub(canvas.about, #PREFIX + 1))
      if target and not panels[canvas.pane] then panels[canvas.pane] = {target = target} end
    end
  end
end
function outline.any() return next(panels) ~= nil end
function outline.live()
  for _, entry in panels do if entry.raw ~= "closed" then return true end end
  return false
end
function outline.target(pane) return panels[pane] and panels[pane].target end
function outline.closed(pane) panels[pane] = nil end

local function paint(cx, pane, entry, snapshot)
  local view = toc.view(snapshot, entry)
  if not view then view = {k = "text", p = {role = "codex-tern.toc.note", text = "Open a session to see its TOC."}} end
  if tern.json.encode(view) ~= entry.view then
    cx.canvas:set(pane, {view = view}); entry.view = tern.json.encode(view)
  end
end
function outline.update(cx, bridge)
  for pane, entry in panels do
    if not cx.session:pane(pane) or not cx.canvas:get(pane) then panels[pane] = nil; continue end
    local state = bridge(cx, entry.target)
    if not state then
      if entry.raw ~= "closed" then
        cx.canvas:set(pane, {view = {k = "text", p = {role = "codex-tern.toc.note", text = "The Codex client is closed."}}})
        entry.raw = "closed"; entry.view = nil; entry.toc_thread = nil; entry.toc_versions = nil; entry.toc_reveals = nil
      end
    elseif state.raw ~= entry.raw then
      paint(cx, pane, entry, state.snapshot); entry.raw = state.raw
    end
  end
end
function outline.open(cx, target, neighbour, state)
  outline.remember(cx)
  if state.snapshot.tocProtocol ~= 1 then
    cx:toast("info", "Restart this Codex client to enable the session TOC."); return
  end
  for pane, entry in panels do
    if entry.target == target and cx.session:pane(pane) then
      paint(cx, pane, entry, state.snapshot); entry.raw = state.raw; return
    end
  end
  local entry = {target = target}
  local view = toc.view(state.snapshot, entry) or {k = "text", p = {role = "codex-tern.toc.note", text = "Open a session to see its TOC."}}
  local pane, err = cx.canvas:open({title = "Session TOC", view = view, about = PREFIX .. tostring(target), how = "below", focus = false})
  if not pane then cx:toast("error", "Could not open session TOC", err); return end
  cx.layout:move(pane, neighbour or target, "down", {focus = false})
  if neighbour then cx.layout:resize(pane, "up", -4) end
  entry.raw = state.raw; entry.view = tern.json.encode(view); panels[pane] = entry
end
function outline.action(ev, cx, bridge, send)
  local entry = panels[ev.pane]
  if not entry then return false end
  local state = bridge(cx, entry.target)
  if state then
    toc.action(ev, state.snapshot, entry, function(act, value)
      if act == "toc-jump" then cx.layout:focus(entry.target) end
      send(cx, entry.target, act, value)
    end, function() paint(cx, ev.pane, entry, state.snapshot) end)
  end
  return true -- Closed cards and stale actions never fall through to Carly.
end
return outline
