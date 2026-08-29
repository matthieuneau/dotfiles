-- Enable the `hs` command-line IPC interface
require("hs.ipc")

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

--------------------------------------------------------------------------------
-- Minimal Pomodoro / one-shot timer
--
--   ⌘⌥P       -> start/restart the default 20-minute timer
--   ⌘⌥T       -> prompt for a custom duration (5, 25m, 90s, 1h, ...)
--   ⌘⌥⇧P      -> cancel the active timer
--
-- When the timer elapses, a red border flashes around every screen for ~1s.
-- No sound, no notification, no focus-stealing window. While a timer is
-- active, the Hammerspoon menu-bar icon shows the remaining time.
--------------------------------------------------------------------------------

local DEFAULT_DURATION = 20 * 60   -- seconds
local FLASH_DURATION   = 1.0      -- seconds
local BORDER_WIDTH     = 8         -- px

local activeTimer  = nil           -- hs.timer object
local endTime      = nil           -- epoch seconds at which the timer fires
local menuBarItem  = nil           -- hs.menubar object (created lazily)
local flashCanvases = {}

local function clearFlash()
    for _, canvas in ipairs(flashCanvases) do
        canvas:delete(0.2)
    end
    flashCanvases = {}
end

local function flashBorder()
    clearFlash()

    for _, screen in ipairs(hs.screen.allScreens()) do
        local frame  = screen:fullFrame()
        local canvas = hs.canvas.new(frame)

        canvas[1] = {
            type = "rectangle",
            action = "stroke",
            frame = {
                x = BORDER_WIDTH / 2,
                y = BORDER_WIDTH / 2,
                w = frame.w - BORDER_WIDTH,
                h = frame.h - BORDER_WIDTH,
            },
            strokeWidth = BORDER_WIDTH,
            strokeColor = {
                red = 1, green = 0, blue = 0, alpha = 0.75,
            },
        }

        canvas:bringToFront(true):show()
        table.insert(flashCanvases, canvas)
    end

    hs.timer.doAfter(FLASH_DURATION, clearFlash)
end

local function formatRemaining(seconds)
    seconds = math.max(0, math.floor(seconds))
    local m = math.floor(seconds / 60)
    local s = seconds % 60
    return string.format("%d:%02d", m, s)
end

local function hideMenuBar()
    if menuBarItem then
        menuBarItem:delete()
        menuBarItem = nil
    end
end

local function tickMenuBar()
    if not menuBarItem or not endTime then
        return
    end
    local remaining = endTime - os.time()
    if remaining <= 0 then
        hideMenuBar()
        return
    end
    menuBarItem:setTitle(formatRemaining(remaining))
end

local function showMenuBar()
    if not menuBarItem then
        menuBarItem = hs.menubar.new()
        menuBarItem:setTooltip("Pomodoro timer running — ⌘⌥⇧P to cancel")
    end
    tickMenuBar()
end

local function startTimer(seconds)
    -- Replace any timer currently running.
    if activeTimer then
        activeTimer:stop()
        activeTimer = nil
    end

    endTime = os.time() + seconds
    showMenuBar()

    activeTimer = hs.timer.doAfter(seconds, function()
        activeTimer = nil
        endTime = nil
        hideMenuBar()
        flashBorder()
    end)
end

local function parseDuration(input)
    input = input:lower():gsub("%s+", "")

    -- Plain number means minutes: "25" -> 25 min
    local number = tonumber(input)
    if number then
        return number * 60
    end

    -- Explicit units: "30s", "25m", "1.5h"
    local value, unit = input:match("^([%d%.]+)([smh])$")
    value = tonumber(value)
    if not value then return nil end

    if unit == "s" then
        return value
    elseif unit == "m" then
        return value * 60
    elseif unit == "h" then
        return value * 3600
    end
    return nil
end

local function promptForTimer()
    local button, input = hs.dialog.textPrompt(
        "Start timer",
        "Examples: 5, 25m, 90s, 1h",
        "20",
        "Start",
        "Cancel"
    )

    if button ~= "Start" then return end

    local seconds = parseDuration(input)
    if not seconds or seconds <= 0 then
        hs.alert.show("Invalid duration")
        return
    end

    startTimer(seconds)
end

-- Default 20-minute timer
hs.hotkey.bind({ "cmd", "alt" }, "P", function()
    startTimer(DEFAULT_DURATION)
end)

-- Custom timer
hs.hotkey.bind({ "cmd", "alt" }, "T", promptForTimer)

-- Cancel current timer
hs.hotkey.bind({ "cmd", "alt", "shift" }, "P", function()
    if activeTimer then
        activeTimer:stop()
        activeTimer = nil
        endTime = nil
        hideMenuBar()
        hs.alert.show("Timer cancelled")
    end
end)

-- Refresh the menu-bar countdown every second while a timer is active.
hs.timer.doEvery(1, tickMenuBar)

--------------------------------------------------------------------------------
-- Expose startTimer to the hs CLI so we can validate end-to-end:
--   hs -c 'hs.reload(); require("init").startTimer(30)'
-- We stash it on a global module table for that purpose.
--------------------------------------------------------------------------------
pomodoro = { startTimer = startTimer, flashBorder = flashBorder }
