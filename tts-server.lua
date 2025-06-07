-- ɔƆ(tts Server)
local http = require("hs.httpserver")
local json = require("hs.json")
local DEBUG = true

local inspect = nil
if vim and vim.inspect then
    inspect = vim.inspect
elseif hs and hs.inspect then
    inspect = hs.inspect
end
-- local task = require("hs.task") -- No longer using hs.task
-- local speech = require("hs.speech") -- Use the built-in speech module

-- For detailed stack traces in debug prints
local debug = debug

local serverPort = 8080 -- Port the server listens on (must match JS script)
local server = nil -- Holds the server object once started
-- local speakingTask = nil -- Replaced by speechObject
-- local speechObject = nil -- Keep track of the current hs.speech object

local speakQueue = {}
local isSpeaking = false
-- --- Say CLI settings ---
local TTS_RATE = 195 -- macOS 'say' rate
local sayTask = nil -- hs.task handle

----------------------------------------------------------------
-- EU Classical Stream Quick Player
-----------
local eu_instance = nil -- holds the singleton player object

-----------
-- eu Helper funcs
-----------
local function stopFeeder()
    -- terminate hs.task feeder if still running
    if _G.__eu_feeder and _G.__eu_feeder:isRunning() then
        _G.__eu_feeder:terminate()
    end
    _G.__eu_feeder = nil
    -- extra safety: kill stray curl processes that were started manually
    local STREAM_URL = "https://stream.srg-ssr.ch/m/rsc_de/mp3_128"
    local FIFO = "/tmp/eu_fifo"
    hs.execute("pkill -f '" .. STREAM_URL .. ".*" .. FIFO .. "' >/dev/null 2>&1")
end

function eu_warm()
    -- ensure no leftover feeder is running
    stopFeeder()
    local FIFO = "/tmp/eu_fifo"
    hs.execute("rm -f " .. FIFO)
    hs.execute("/usr/bin/mkfifo " .. FIFO, true)
    local CURL = "/usr/bin/curl"
    local STREAM_URL = "https://stream.srg-ssr.ch/m/rsc_de/mp3_128"
    -- start feeder, write into FIFO continuously
    local feeder = hs.task.new(CURL, nil, {"-sL", STREAM_URL, "-o", FIFO})
    feeder:start()
    if DEBUG then
        print("🚿 [eu_warm] Feeder started. Streaming from: " .. STREAM_URL ..
                  " → " .. FIFO)
    end
    _G.__eu_feeder = feeder
end
local function eu()
    -- keep a singleton player task across invocations
    if eu_instance then return eu_instance end

    -- ad‑free European classical streams (unused in FIFO feeder mode)
    local streams = {
        "https://stream.srg-ssr.ch/m/rsc_de/mp3_128", -- Radio Swiss Classic
        "http://icecast.vrtcdn.be/klaracontinuo-high.mp3", -- Klara Continuo (BE)
        -- "http://icecast.vrtcdn.be/klara-high.mp3",         -- Klara BE
        "https://stream.srg-ssr.ch/m/rsc_de/aacp_96" -- Swiss Classic AAC
    }

    -- resolve a CLI audio player path (ffplay → mpv); fall back to afplay hack
    local function findPlayer()
        local paths = {
            "/opt/homebrew/bin/ffplay", "/usr/local/bin/ffplay",
            "/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"
        }
        for _, p in ipairs(paths) do
            if hs.fs.displayName(p) then return p end
        end
        return nil -- will use afplay fallback
    end

    local playerPath = findPlayer()
    local taskObj = nil

    -- Add a dedicated eu_stop() for full teardown (safe termination preferred)
    local function eu_stop()
        if DEBUG then print("✋ [eu_stop] called") end

        local ffplayPath = "/opt/homebrew/bin/ffplay"
        if not hs.fs.displayName(ffplayPath) then
            ffplayPath = "/usr/local/bin/ffplay"
        end
        if taskObj and taskObj:isRunning() then
            if DEBUG then
                print("🛑 [eu_stop] Gracefully terminating ffplay via taskObj")
            end
            taskObj:terminate()
            taskObj = nil
        else
            if DEBUG then
                print(
                    "⚠️ [eu_stop] No active taskObj — falling back to pkill")
            end
            hs.execute("pkill -f '" .. ffplayPath .. "' >/dev/null 2>&1")
        end
    end

    -- Preload-based FIFO streaming start
    local function start()
        if DEBUG then
            print("▶ [eu.start] called; existing taskObj:", tostring(taskObj))
        end
        if taskObj and taskObj:isRunning() then
            -- if DEBUG then hs.alert.show("🎼 EU stream already playing") end
            return
        end

        local fifoPath = "/tmp/eu_fifo"
        local ffplayPath = "/opt/homebrew/bin/ffplay"
        if not hs.fs.displayName(ffplayPath) then
            ffplayPath = "/usr/local/bin/ffplay"
        end

        if DEBUG then
            print("🔍 Checking stale taskObj; isRunning?",
                  taskObj and taskObj:isRunning())
        end
        -- Clean stale taskObj if it's no longer alive
        if taskObj and not taskObj:isRunning() then
            print("🛑 ffplay taskObj exists but not running. Cleaning up.")
            taskObj = nil
        end

        if taskObj and taskObj:isRunning() then
            if DEBUG then
                print(
                    "🛑 [eu.start] Gracefully terminating previous ffplay via taskObj")
            end
            taskObj:terminate()
            taskObj = nil
        end

        -- Launch ffplay on the warmed FIFO directly
        taskObj = hs.task.new(ffplayPath, function(exitCode, stdOut, stdErr)
            if DEBUG then
                print(string.format(
                          "🛑 [EU ffplay exited] exitCode=%s, stdout=%s, stderr=%s",
                          tostring(exitCode), tostring(stdOut), tostring(stdErr)))
            end
            taskObj = nil
        end, {
            "-nodisp", "-autoexit", "-loglevel", "error", "-fflags", "nobuffer",
            "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0",
            "-volume", "30", fifoPath
        })
        taskObj:start()
        if DEBUG then
            print("🎧 [eu.start] ffplay is now running from FIFO: " ..
                      fifoPath)
        end
        if DEBUG then
            print("✅ [eu.start] ffplay started; PID:", taskObj:pid())
        end
        -- hs.alert.show("🎶 EU stream ▶ instant (FIFO pre-warmed)")
    end

    -- Mute by reducing system output volume to 0 using AppleScript
    local function mute()
        eu_stop()
        eu_warm()
        -- hs.alert.show("🔇 EU stream restarted with ffplay volume=0")
    end

    eu_instance = {o = start, x = mute, stop = eu_stop, mute = mute}
    return eu_instance
end

function e_ds()
    _G.__ds_t = hs.timer.doEvery(1, function()
        local now = os.time()
        if (_G.__eds or 0) + 1 < now then
            print("🛑 [eds] No ping in >1s; muting EU stream")
            eu().mute()
            _G.__ds_t:stop()
        end
    end)
end

--------------------------------------------------------------------------------
-- tts
--------------------
-- Helper: enqueue text; merge with last entry if queue already has items
local function enqueueSpeech(text)
    if #speakQueue == 0 then
        table.insert(speakQueue, text)
    else
        -- add a space if the last entry does not end with whitespace
        local last = speakQueue[#speakQueue]
        if not last:match("%s$") then last = last .. " " end
        speakQueue[#speakQueue] = last .. text
    end
end

-- Helper: stop and clean up the current speech object
local function stopSayProc()
    if sayTask and sayTask:isRunning() then
        sayTask:terminate() -- SIGTERM is enough
    end
    sayTask = nil
    isSpeaking = false
end

-- Helper: clear the queue and stop any ongoing speech
local function flushq()
    speakQueue = {}
    stopSayProc()
end

-- Replace the current speech with a new one immediately
local function replaceSpeechImmediately(newText)
    flushq() -- Clear current queue and stop speaking
    table.insert(speakQueue, 1, newText)
    startNextSpeech()
end

---------------------------
-- Function to Start Next Speech in the Queue (MODIFIED TO USE hs.task with /usr/bin/say)
------------------
local function startNextSpeech()
    if isSpeaking or #speakQueue == 0 then return end

    isSpeaking = true
    local nextText = table.remove(speakQueue, 1)

    -- Ensure old sayTask is gone
    stopSayProc()

    sayTask = hs.task.new("/usr/bin/say", function(exitCode, stdout, stderr)
        sayTask = nil
        isSpeaking = false
        startNextSpeech() -- cascade to next item
    end, {"-r", tostring(TTS_RATE), nextText})

    local ok = sayTask:start()
    if not ok then
        print("🛑 could not spawn /usr/bin/say")
        sayTask = nil
        isSpeaking = false
        startNextSpeech()
    end
end

-------------
-- Function to Handle Incoming HTTP Requests (Unchanged logic, only comments updated)
-------------
local function handleSpeakRequest(requestMethod, requestPath, requestHeaders,
                                  requestBody, requestAddress, requestPort,
                                  serverObject)
    -- We only care about POST requests coming to the /speak path
    if requestPath == "/speak" and requestMethod == "POST" then

        -- Try to decode the JSON payload from the request body
        local success, data = pcall(json.decode, requestBody)

        if not success then
            print(
                "⚠️ JSON parse failed on raw body, trying sanitized fallback")
            -- remove any invalid Unicode escape sequences (\uXXXX where XXXX is hex)
            local sanitized = requestBody:gsub(
                                  "\\u[%da-fA-F][%da-fA-F][%da-fA-F][%da-fA-F]",
                                  "")
            print("🔧 Sanitized JSON body:", sanitized)
            local ok2, data2 = pcall(json.decode, sanitized)
            if ok2 then
                data = data2
                success = true
            else
                print("❌ Sanitized JSON parse also failed")
            end
        end

        -- Graceful fallback:
        --   • If JSON decoding failed, or it didn't return a table,
        --     interpret the whole body as plain text.
        if (not success) or type(data) ~= "table" then
            data = {text = (requestBody or "")}
            success = true
        end

        -- After the fallback, bail only if we still have *no* actionable field.
        if (not data.text or #data.text == 0) and not data.playEU and
            not data.stopEU and not data.lpEU and not data.dsEU and
            not data.flushQueue then

            return "Error: Invalid JSON or no actionable field.", 400,
                   {["Content-Type"] = "text/plain"}
        end

        -- Check for flush signal: if true, clear the speakQueue and stop current speech.
        if data.flushQueue then
            -- print("TTS Server: Flush signal received.")
            -- inline flush logic
            flushq()
        end

        -- EU classical stream controls via JSON booleans
        if data.playEU then
            if DEBUG then print("▶ [HTTP] playEU command") end
            local ok, err = pcall(function() eu().o() end)
            if not ok then
                print("⚠️ EU play error: " .. tostring(err))
                return "EU play error: " .. tostring(err), 500,
                       {["Content-Type"] = "text/plain"}
            end
            return "EU play", 200, {["Content-Type"] = "text/plain"}
        elseif data.stopEU then
            if DEBUG then print("⏹️ [HTTP] stopEU command") end
            local ok, err = pcall(function() eu().mute() end)
            if not ok then
                print("⚠️ EU stop error: " .. tostring(err))
                return "EU stop error: " .. tostring(err), 500,
                       {["Content-Type"] = "text/plain"}
            end
            return "EU stop", 200, {["Content-Type"] = "text/plain"}
        elseif data.lpEU then
            e_ds()
            if DEBUG then print("▶ [HTTP] lpEU command") end
            _G.__eds = os.time()
            pcall(function() eu().o() end)
            return "lpEU eds", 200, {["Content-Type"] = "text/plain"}
        elseif data.dsEU then
            _G.__eds = os.time()
            return "dsEU p", 200, {["Content-Type"] = "text/plain"}
        end

        -- Extract the text to be spoken (make sure it is a string)
        local textToSpeak = data.text
        if type(textToSpeak) ~= "string" then
            -- No valid text payload → respond OK and exit early
            return "OK (empty)", 200, {["Content-Type"] = "text/plain"}
        end

        -- Basic sanitation: remove leading/trailing whitespace
        textToSpeak = textToSpeak:match("^%s*(.-)%s*$")
        -- Strip extended ASCII (saves speech hiccups)
        textToSpeak = textToSpeak:gsub("[\128-\255]", "")

        if textToSpeak and #textToSpeak > 0 then
            enqueueSpeech(textToSpeak)
            -- if DEBUG then print("📥 [handleSpeakRequest] Enqueued: \"" .. textToSpeak .. "\" QueueLen=" .. #speakQueue) end
            startNextSpeech()
            return "OK", 200, {["Content-Type"] = "text/plain"}
        else
            return "OK (empty text)", 200, {["Content-Type"] = "text/plain"}
        end
    elseif requestPath == "/replace" and requestMethod == "POST" then
        local success, data = pcall(json.decode, requestBody)
        if not success or type(data) ~= "table" or not data.text then
            return "Error: Invalid JSON or missing 'text' field.", 400,
                   {["Content-Type"] = "text/plain"}
        end
        local textToSpeak = data.text:match("^%s*(.-)%s*$")
        textToSpeak = textToSpeak:gsub("[\128-\255]", "")
        if textToSpeak and #textToSpeak > 0 then
            replaceSpeechImmediately(textToSpeak)
            return "OK (replaced)", 200, {["Content-Type"] = "text/plain"}
        else
            return "OK (empty replace)", 200, {["Content-Type"] = "text/plain"}
        end
    else
        -- Not POST /speak
        -- print("TTS Server: Received unexpected request: " .. requestMethod .. " " .. requestPath)
        return "Not Found", 404, {["Content-Type"] = "text/plain"}
    end
end -- End of handleSpeakRequest function

--------------------------------------------------------------------------------
-- Function to Start the HTTP Server (Unchanged)
--------------------------------------------------------------------------------
function startTTSServer()
    -- Prevent starting if already running
    if server then
        -- print("TTS Server: Already running on port " .. serverPort)
        return
    end

    -- print("TTS Server: Attempting to start on port " .. serverPort)
    -- Create the server object (disable SSL, disable Bonjour)
    server = http.new(false, false)
    if not server then
        hs.alert
            .show("Hammerspoon Error:\nCould not create HTTP server object.")
        return
    end

    -- Configure and start the server
    server:setPort(serverPort)
    server:setCallback(handleSpeakRequest) -- Set the callback function
    local started = server:start()

    -- Provide feedback
    if started then
        -- print("TTS Server: Successfully started on port " .. serverPort)
        hs.alert.show("🎙️ ChatGPT TTS Server Started (using /usr/bin/say)") -- Updated alert
    else
        -- print("TTS Server: Failed to start server on port " .. serverPort .. ". Check if port is in use.")
        hs.alert.show(
            "Hammerspoon Error:\nFailed to start TTS server on port " ..
                serverPort)
        server = nil -- Clear the server object if start failed
    end
end

--------------------------------------------------------------------------------
-- Function to Stop the HTTP Server (MODIFIED TO USE /usr/bin/say)
--------------------------------------------------------------------------------
function stopTTSServer()
    if server then
        -- print("TTS Server: Stopping.")
        server:stop()
        flushq()
        stopFeeder()
        server = nil
        hs.alert.show("🎙️ ChatGPT TTS Server Stopped")
    else
        -- print("TTS Server: Not currently running.")
    end
end

--------------------------------------------------------------------------------
-- Initial Setup & Optional Hotkeys (Unchanged)
--------------------------------------------------------------------------------

-- Automatically start the server when Hammerspoon loads or reloads the config
startTTSServer()
eu_warm()

-- Example Hotkeys (Uncomment lines below to enable)
-- hs.hotkey.bind({"cmd", "alt", "ctrl"}, "S", function() startTTSServer() end) -- Start server with Cmd+Alt+Ctrl+S
-- hs.hotkey.bind({"cmd", "alt", "ctrl"}, "X", function() stopTTSServer() end)  -- Stop server with Cmd+Alt+Ctrl+X

-- print("Hammerspoon: ChatGPT TTS script (using /usr/bin/say) loaded.")

-- Shift tap flush watcher (improved reliability)
local t = 0
local h = hs.eventtap
local b = h.event.types
local w = h.new({b.flagsChanged, b.keyDown}, function(e)
    local ok, err = pcall(function()
        local f = e:getFlags()
        local c = e:getKeyCode()

        if f.shift and c == 56 then
            t = hs.timer.secondsSinceEpoch()
            if c ~= 56 then return false end
        else
            local l = hs.timer.secondsSinceEpoch() - t
            if l < 0.65 then
                if not pcall(flushq) then
                    stopTTSServer()
                    startTTSServer()
                    if not w:isEnabled() then w:start() end
                end
            end
        end
    end)
    if not ok then
        print("❌ [ShiftWatcher] Callback error: " .. tostring(err))
        -- Ensure watcher keeps running despite errors
        if not w:isEnabled() then w:start() end
    end
    return false
end)

pcall(w:start())
--[[
hs.timer.doEvery(10, function()
    if not fnWatcher:isEnabled() then
        print("🔄  fnWatcher was disabled – re‑enabling")
        local ok, err = fnWatcher:start()
        if not ok then print("⚠️ could not restart tap: "..tostring(err)) end
    end
end)]]

--------------------------------------------------------------------------------
-- Clean Shutdown on Reload
--------------------------------------------------------------------------------
hs.shutdownCallback = function() stopTTSServer() end

--[[
hs.timer.doEvery(3600, function()
    if DEBUG then
        print("⏱️ [HealthCheck] EU taskObj running?", eu_instance and eu_instance.o and (function()
            local obj = nil
            if eu_instance and type(eu_instance) == "table" then
                local ok, v = pcall(function() return eu_instance.taskObj end)
                if ok then obj = v end
            end
            return obj and obj:isRunning()
        end)() or false,
        "speechObject speaking?", isSpeaking)
    end
end)
]]
