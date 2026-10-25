-- TSP does not support pixel scrolling. Use native line commands in bounded
-- batches, scoped to the requesting client and its current navigation token.
local reading = {}

function reading.restore(cx, target, request, current, done)
  local lines = request.lines
  if type(lines) ~= "number" or lines % 1 ~= 0 then done(cx); return end
  local command = if lines < 0 then "scroll_line_down" else "scroll_line_up"
  local remaining, started = math.abs(lines), false
  local function step(cx)
    -- A late restore must never move a different pane or a newer session.
    if not cx or cx.session:focused() ~= target or not current(cx) then
      if cx then done(cx) end
      return
    end
    if not started and not request.relative then cx:command("scroll_bottom") end
    started = true
    local count = math.min(remaining, 200)
    for _ = 1, count do cx:command(command) end
    remaining -= count
    if remaining > 0 then tern.timer(1, step) else done(cx) end
  end
  step(cx)
end

return reading
