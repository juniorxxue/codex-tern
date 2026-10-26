-- One preference for the whole Tern profile, shared by projects and windows.
local KEY = "sessions.sidebar-ratio"
local widths = {}

local function preference()
  local ok, value = pcall(tern.kv.get, KEY)
  if not ok then return false, nil end
  return true, if type(value) == "number" and value > 0 and value < 1 then value else nil
end

local function contains(node, pane)
  return node and (node.pane == pane or contains(node[1], pane) or contains(node[2], pane))
end
local function pane_split(node, pane)
  if not node or node.pane then return nil end
  if node.split == "right" and contains(node[1], pane) then return node end
  return pane_split(node[1], pane) or pane_split(node[2], pane)
end

local function ratio(cx, pane)
  local tab = cx.session:tab_of(pane)
  local layout = if tab then cx.session:layout(tab) else nil
  local split = if layout then pane_split(layout.root, pane) else nil
  return if split then split.ratio else nil
end

local function apply(cx, pane, desired, before)
  if not before or math.abs(desired - before) < 0.000001 then return before end
  -- Tern resizes in cells, not fractions. Measure in the requested direction
  -- so a pane at its minimum or maximum can still move away from that limit.
  local direction = if desired > before then 1 else -1
  cx.layout:resize(pane, "right", direction)
  local after = ratio(cx, pane)
  local step = if after then (after - before) / direction else 0
  if step > 0 then
    cx.layout:resize(pane, "right", math.round((desired - after) / step))
  end
  return ratio(cx, pane)
end

function widths.initialize(cx, pane, entry, snapshot)
  local ok, saved = preference()
  -- Only brand-new panes use the default. Restored panes keep their existing
  -- width when no preference has been saved yet.
  local window_width = (snapshot.cols or 120) * (snapshot.cellWidth or 8)
  local desired = saved or math.min(0.30, 420 / window_width)
  entry.width_ratio = apply(cx, pane, desired, ratio(cx, pane))
  if ok then entry.width_preference = saved end
end

function widths.sync(cx, panels)
  local ok, saved = preference()
  if not ok then return end -- An unreadable store must never be overwritten.
  for pane, entry in panels do
    local current = ratio(cx, pane)
    if current then
      if entry.width_ratio == nil or entry.width_preference ~= saved then
        -- A preference from another window wins over this pane's old width.
        -- Keep the effective, rounded ratio separate from the saved fraction
        -- so applying it never becomes another user edit or causes drift.
        entry.width_ratio = if saved then apply(cx, pane, saved, current) else current
        entry.width_preference = saved
      elseif math.abs(current - entry.width_ratio) > 0.000001 then
        local written = pcall(tern.kv.set, KEY, current)
        if written then
          saved = current
          entry.width_ratio = current
          entry.width_preference = saved
        end
      end
    else
      entry.width_ratio = nil
    end
  end
end

return widths
