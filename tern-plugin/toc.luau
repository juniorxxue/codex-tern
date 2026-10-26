-- Presentation only. The client owns the independent outline agent and every prompt link.
local toc = {}
local function nodes(value)
  local all = {}
  for _, topic in value.topics or {} do
    table.insert(all, topic)
    for _, child in topic.children or {} do table.insert(all, child) end
  end
  return all
end

function toc.view(snapshot, entry)
  local value = snapshot.toc
  if snapshot.tocProtocol ~= 1 or not value then return nil end
  entry = entry or {}
  local same = entry.toc_thread == value.threadId
  local versions, reveals = {}, {}
  for _, node in nodes(value) do
    local version = node.title .. ":" .. tostring(node.visits)
    versions[node.id] = version
    if same and entry.toc_versions then
      if entry.toc_versions[node.id] ~= version then reveals[node.id] = value.revision
      elseif entry.toc_reveals then reveals[node.id] = entry.toc_reveals[node.id] end
    end
  end
  entry.toc_thread = value.threadId; entry.toc_versions = versions; entry.toc_reveals = reveals
  entry.toc_closed = entry.toc_closed or {}
  local closed = entry.toc_closed[value.threadId] or {}; entry.toc_closed[value.threadId] = closed
  local content = {}
  local enabled = snapshot.connected and snapshot.canSwitch and (not entry.selection or entry.selection.id == value.threadId)
  local function heading(node, child)
    local selected = value.location and value.location.nodeId == node.id
    local row = {k = "row", p = {key = "heading-" .. node.id, role = if child then "codex-tern.toc.child" else "codex-tern.toc.topic",
      align = "start", gap = "xs", mark = if selected then "pick" else nil}, c = {}}
    if not child then
      table.insert(row.c, {k = "icon", p = {key = "fold", role = "codex-tern.toc.fold",
        name = if closed[node.id] then "chev-r" else "chev", hidden = #(node.children or {}) == 0,
        title = (if closed[node.id] then "Expand " else "Collapse ") .. node.title,
        actions = {click = "toc-fold=" .. node.id}}})
    end
    table.insert(row.c, {k = "col", p = {key = "link", grow = 1, role = "codex-tern.toc.link", title = node.title,
      actions = if enabled then {click = "toc-jump=" .. node.id} else nil}, c = {
        {k = "text", p = {key = if reveals[node.id] then "label-" .. reveals[node.id] else "label",
          role = "codex-tern.toc.label", mark = if reveals[node.id] then "reveal" else nil, text = node.title, lines = 2}},
      }})
    if node.visits > 1 then
      table.insert(row.c, {k = "text", p = {key = "visits", role = "codex-tern.toc.visits", text = "↩ " .. tostring(node.visits),
        title = "Discussed in " .. tostring(node.visits) .. " places · Jump to the next visit",
        actions = if enabled then {click = "toc-visit=" .. node.id} else nil}})
    end
    return row
  end
  for _, topic in value.topics or {} do
    table.insert(content, heading(topic, false))
    if not closed[topic.id] then
      for _, child in topic.children or {} do table.insert(content, heading(child, true)) end
    end
  end
  local footer = {}
  if value.error and value.error ~= "" then
    table.insert(footer, {k = "text", p = {key = "error", role = "codex-tern.toc.note", text = value.error, lines = 3}})
  elseif #content == 0 and value.enabled and not value.updating then
    table.insert(footer, {k = "text", p = {key = "empty", role = "codex-tern.toc.note", text = "Topics appear as you chat."}})
  end
  if not value.updating and (not value.enabled or (value.error and value.error ~= "")) then
    table.insert(footer, {k = "text", p = {key = "get", role = "codex-tern.toc.get",
      text = if value.enabled then "Retry" else "Get TOC", mark = if enabled then nil else "disabled",
      actions = if enabled then {click = "toc-get"} else nil}})
  end
  return {k = "col", p = {key = "toc", role = "codex-tern.toc"}, c = {
    {k = "row", p = {key = "head", role = "codex-tern.toc.head", align = "center", gap = "sm"}, c = {
      {k = "text", p = {key = "title", grow = 1, text = "This session"}},
      {k = "text", p = {key = "status", role = "codex-tern.toc.status", text = if value.updating then "Updating…" else ""}},
      {k = "icon", p = {key = "menu", name = "more", title = "TOC options", hidden = not value.enabled,
        actions = if enabled and not value.updating then {menu = {"Rebuild TOC"}} else nil}},
    }},
    {k = "col", p = {key = "body", role = "codex-tern.toc.body", hidden = #content == 0}, c = content},
    {k = "col", p = {key = "footer", role = "codex-tern.toc.footer", hidden = #footer == 0}, c = footer},
  }}
end

function toc.action(ev, snapshot, entry, send, repaint)
  if ev.act ~= "toc-get" and ev.act ~= "toc-jump" and ev.act ~= "toc-visit" and ev.act ~= "toc-fold"
    and ev.act ~= "Rebuild TOC" then return false end
  local value = snapshot.toc
  if not value or value.threadId ~= snapshot.current or (entry.selection and entry.selection.id ~= value.threadId) then return true end
  if ev.act == "toc-get" or ev.act == "Rebuild TOC" then
    if snapshot.connected and snapshot.canSwitch and not value.updating then
      send(if ev.act == "toc-get" then "toc-get" else "toc-rebuild", value.threadId)
    end
    return true
  end
  for _, node in nodes(value) do
    if node.id == ev.value then
      if ev.act == "toc-fold" then
        entry.toc_closed = entry.toc_closed or {}
        local closed = entry.toc_closed[value.threadId] or {}; entry.toc_closed[value.threadId] = closed
        closed[node.id] = not closed[node.id]; entry.toc_reveals = nil; repaint(); return true
      end
      if not snapshot.connected or not snapshot.canSwitch then return true end
      local visit = 0
      if ev.act == "toc-visit" then
        local current = if value.location and value.location.nodeId == node.id then value.location.visit else 0
        visit = (current + 1) % node.visits
      end
      send("toc-jump", tern.json.encode({threadId = value.threadId, revision = value.revision, nodeId = node.id, visit = visit}))
      return true
    end
  end
  return true
end
return toc
