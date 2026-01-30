-- Create a window filter to watch for focus events
local wf = hs.window.filter.new()

-- Define the function to center the mouse
wf:subscribe(hs.window.filter.windowFocused, function(window)
	-- 1. Get the frame of the window and the current mouse position
	local frame = window:frame()
	local mousePos = hs.mouse.absolutePosition()
	local mousePoint = hs.geometry.point(mousePos.x, mousePos.y)

	-- 2. Check if the mouse is already inside the window's area
	if not mousePoint:inside(frame) then
		-- 3. Only if the mouse is OUTSIDE, move it to the center
		hs.mouse.absolutePosition(frame.center)
	end
end)
