-- ɔƆ
local http = require("hs.httpserver")
local json = require("hs.json")
-- local task = require("hs.task") -- No longer using hs.task
local speech = require("hs.speech") -- Use the built-in speech module

-- Configuration
local serverPort = 8080 -- Port the server listens on (must match JS script)
local server = nil      -- Holds the server object once started
-- local speakingTask = nil -- Replaced by speechObject
local speechObject = nil -- Keep track of the current hs.speech object

local speakQueue = {}
local isSpeaking = false

--------------------------------------------------------------------------------
-- Function to Start Next Speech in the Queue (MODIFIED TO USE hs.speech)
--------------------------------------------------------------------------------
local function startNextSpeech()
    print("[TTS] startNextSpeech called. isSpeaking: " .. tostring(isSpeaking) .. ", queueLength: " .. tostring(#speakQueue))
    if isSpeaking or #speakQueue == 0 then
        -- Optional: Add debug prints if needed
        -- if isSpeaking then print("TTS Server (hs.speech): Already speaking.") end
        -- if #speakQueue == 0 then print("TTS Server (hs.speech): Queue empty.") end
        return
    end

    isSpeaking = true
    local nextText = table.remove(speakQueue, 1) -- pop front item
    print("TTS Server (hs.speech): Attempting to speak: '" .. nextText .. "'")

    -- Inside startNextSpeech, before creating the new object:
if speechObject then
    print("[TTS] Cleaning up previous speech object.")
    speechObject:setCallback(nil) -- Remove callback first
    speechObject:stop()           -- Explicitly stop synthesizer
    speechObject = nil            -- Release Lua reference
end

    -- Create a new speech object
    speechObject = speech.new() -- Use default voice

    if not speechObject then
        print("TTS Server Error: Failed to create hs.speech object for: '" .. nextText .. "'")
        isSpeaking = false
        -- Try next item in queue immediately if creation failed
        -- Use pcall to prevent potential stack overflow if creation *always* fails
        pcall(startNextSpeech)
        return
    end

    -- Set callback for when speech finishes or errors
    speechObject:setCallback(function(object, event)
        print("[TTS] Speech callback triggered. Event: " .. tostring(event))
        -- Check if the callback is for the *current* speech object
        if speechObject ~= object then
            print("[TTS] Received callback for a stale speech object. Ignoring callback for event: " .. tostring(event))
            return
        end

        if event == "didFinish" then
            print("[TTS] Speech finished for current text.")
            -- print("TTS Server (hs.speech): Speech finished.") -- Debug if needed
            speechObject:setCallback(nil) -- Clean up callback
            speechObject = nil
            isSpeaking = false
            -- attempt next in queue *after* finishing
            startNextSpeech()
        elseif event == "error" then
            print("[TTS] Speech encountered an error. Event: error")
            print("TTS Server Error: hs.speech encountered an error.")
            speechObject:setCallback(nil) -- Clean up callback
            speechObject = nil
            isSpeaking = false
            -- attempt next in queue even after error
            startNextSpeech()
        -- You could add handling for other events like 'word' if desired
        end
    end)

    -- Start speaking asynchronously
    local started = speechObject:speak(nextText)

    if not started then
        print("TTS Server Error: Failed to start hs.speech:speak() for: '" .. nextText .. "'")
        speechObject:setCallback(nil) -- Clean up failed object
        speechObject = nil
        isSpeaking = false
        -- try next if starting failed
        startNextSpeech()
    -- else
        -- print("TTS Server (hs.speech): Started speaking.") -- Debug if needed
    end
end

--------------------------------------------------------------------------------
-- Function to Handle Incoming HTTP Requests (Unchanged logic, only comments updated)
--------------------------------------------------------------------------------
local function handleSpeakRequest(requestMethod, requestPath, requestHeaders, requestBody, requestAddress, requestPort, serverObject)
    -- We only care about POST requests coming to the /speak path
    if requestPath == "/speak" and requestMethod == "POST" then
        -- Check if there's a body in the request
        if not requestBody then
            print("TTS Server: Received request with no body.")
            return "Error: No request body.", 400, { ["Content-Type"] = "text/plain" }
        end

        -- Try to decode the JSON payload from the request body
        local success, data = pcall(json.decode, requestBody)

        -- Check if JSON decoding failed or if the 'text' field is missing
        if not success or type(data) ~= "table" or not data.text then
            print("TTS Server: Invalid JSON or missing 'text' field: " .. requestBody)
            return "Error: Invalid JSON or missing 'text' field.", 400, { ["Content-Type"] = "text/plain" }
        end

        -- Check for flush signal: if true, clear the speakQueue and stop current speech.
        if data.flushQueue then
            print("TTS Server: Flush signal received. Clearing queued text and stopping current speech.")
            speakQueue = {}  -- Clear any pending text fragments
            if speechObject then
                speechObject:stop()       -- Stop the ongoing speech
                speechObject:setCallback(nil)
                speechObject = nil
                isSpeaking = false
            end
        end

        -- Extract the text to be spoken
        local textToSpeak = data.text
        -- Basic sanitation: remove leading/trailing whitespace
        textToSpeak = textToSpeak:match("^%s*(.-)%s*$")
        -- Keep this gsub for now, as even hs.speech might stumble on some things. Test removing it if desired.
        textToSpeak = textToSpeak:gsub("[\128-\255]", "")

        if textToSpeak and #textToSpeak > 0 then
            print("TTS Server: Received text: '" .. textToSpeak .. "'")

            -- push to queue
            table.insert(speakQueue, textToSpeak) -- Using table.insert is slightly clearer
            -- Trigger the speech function (it will only start if not already speaking)
            startNextSpeech()

            -- Return bodyString, code, headers
            return "OK", 200, { ["Content-Type"] = "text/plain" }
        else
            print("TTS Server: Received empty text after trimming.")
            return "OK (empty text)", 200, { ["Content-Type"] = "text/plain" }
        end
    else
        -- Not POST /speak
        print("TTS Server: Received unexpected request: " .. requestMethod .. " " .. requestPath)
        return "Not Found", 404, { ["Content-Type"] = "text/plain" }
    end
end -- End of handleSpeakRequest function

--------------------------------------------------------------------------------
-- Function to Start the HTTP Server (Unchanged)
--------------------------------------------------------------------------------
function startTTSServer()
    -- Prevent starting if already running
    if server then
        print("TTS Server: Already running on port " .. serverPort)
        return
    end

    print("TTS Server: Attempting to start on port " .. serverPort)
    -- Create the server object (disable SSL, disable Bonjour)
    server = http.new(false, false)
    if not server then
        hs.alert.show("Hammerspoon Error:\nCould not create HTTP server object.")
        return
    end

    -- Configure and start the server
    server:setPort(serverPort)
    server:setCallback(handleSpeakRequest) -- Set the callback function
    local started = server:start()

    -- Provide feedback
    if started then
        print("TTS Server: Successfully started on port " .. serverPort)
        hs.alert.show("🎙️ ChatGPT TTS Server Started (using hs.speech)") -- Updated alert
    else
        print("TTS Server: Failed to start server on port " .. serverPort .. ". Check if port is in use.")
        hs.alert.show("Hammerspoon Error:\nFailed to start TTS server on port " .. serverPort)
        server = nil -- Clear the server object if start failed
    end
end

--------------------------------------------------------------------------------
-- Function to Stop the HTTP Server (MODIFIED TO USE hs.speech)
--------------------------------------------------------------------------------
function stopTTSServer()
    if server then
        print("TTS Server: Stopping.")
        server:stop()
        server = nil
        -- Also stop any speech that might be in progress using hs.speech
        if speechObject then
            print("TTS Server: Stopping any active hs.speech.")
            speechObject:stop() -- Stop the hs.speech object
            speechObject:setCallback(nil) -- Prevent callback firing after manual stop
            speechObject = nil
        end
        -- Reset state variables
        isSpeaking = false
        speakQueue = {} -- Clear the queue when stopping
        hs.alert.show("🎙️ ChatGPT TTS Server Stopped")
    else
        print("TTS Server: Not currently running.")
    end
end

--------------------------------------------------------------------------------
-- Initial Setup & Optional Hotkeys (Unchanged)
--------------------------------------------------------------------------------

-- Automatically start the server when Hammerspoon loads or reloads the config
startTTSServer()

-- Example Hotkeys (Uncomment lines below to enable)
-- hs.hotkey.bind({"cmd", "alt", "ctrl"}, "S", function() startTTSServer() end) -- Start server with Cmd+Alt+Ctrl+S
-- hs.hotkey.bind({"cmd", "alt", "ctrl"}, "X", function() stopTTSServer() end)  -- Stop server with Cmd+Alt+Ctrl+X

print("Hammerspoon: ChatGPT TTS script (using hs.speech) loaded.")
