import { serve, type Server, spawn, spawnSync, type Subprocess } from "bun";
import fs from "node:fs";
import path from "node:path";

// --- Configuration ---
const SERVER_PORT = 65535;
const TTS_RATE = 190; // Speech rate for the 'say' command

const logInfo = (...args: any[]) => {};
const logWarn = (...args: any[]) => {};
const logError = console.error.bind(console, "[ERROR]"); // Always log errors

// A pool of reliable ad‑free European classical streams
const EU_STREAM_URLS = [
  // "https://www.concertzender.nl/streams/klassiek",
  // "https://icecast.omroep.nl/radio4-bb-mp3",
  // "http://icecast.vrtcdn.be/klaracontinuo-high.mp3",
  "http://116.202.241.212:8010/stream",
  "http://148.251.43.231:8742/160",
];
// Pick one at random from the array (avoid out‑of‑bounds undefined)
const EU_STREAM_URL = EU_STREAM_URLS[Math.floor(Math.random() * EU_STREAM_URLS.length)];
const EU_FIFO_PATH = "/tmp/eu_fifo";
const EU_PLAYER_PATHS = [
  "/opt/homebrew/bin/ffplay",
  "/usr/local/bin/ffplay",
  "/opt/homebrew/bin/mpv",
  "/usr/local/bin/mpv",
];
const CURL_PATH = "/usr/bin/curl";
const MKFIFO_PATH = "/usr/bin/mkfifo";
const PKILL_PATH = "/usr/bin/pkill";

// --- State ---
let server: Server | null = null;
let speakQueue: string[] = [];
let isSpeaking = false;
let currentSpeechProcess: Subprocess | null = null;
let euPlayerPath: string | null = null;
let euFeederProcess: Subprocess | null = null;
let euPlayerProcess: Subprocess | null = null;
let lastEUPing = 0;
let euPingTimer: Timer | null = null;

// --- Interfaces ---
interface SpeakPayload {
  text?: string;
  flushQueue?: boolean;
  playEU?: boolean;
  stopEU?: boolean;
}

interface ReplacePayload {
  text: string;
}

// --- Utility Functions ---
const killProcess = (proc: Subprocess | null, name: string, signal: NodeJS.Signals | number = "SIGTERM") => {
  if (proc && proc.pid) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `Attempting to kill ${name} process (PID: ${proc.pid}) with signal ${signal}...`);
    }
    const killed = proc.kill(signal as number); // Bun's types might mismatch NodeJS.Signals sometimes
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `${name} process kill signal sent (success: ${killed}).`);
    }
    return killed;
  }
  return false;
};

const pkillProcess = (pattern: string) => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[DEBUG]", `Attempting to pkill processes matching: ${pattern}`);
  }
  try {
    const result = spawnSync([PKILL_PATH, "-f", pattern]);
    if (result.exitCode === 0) {
      if (process.env.NODE_ENV !== "production") {
        console.debug("[DEBUG]", `pkill successful for pattern: ${pattern}`);
      }
    } else if (result.exitCode === 1) {
      if (process.env.NODE_ENV !== "production") {
        console.debug("[DEBUG]", `No processes found matching pattern: ${pattern}`);
      }
    } else {
      logWarn(
        `pkill for pattern "${pattern}" exited with code ${result.exitCode}. Stderr: ${result.stderr.toString()}`
      );
    }
  } catch (error) {
    logError(`Error executing pkill for pattern "${pattern}":`, error);
  }
};

// --- TTS Functions ---

const stopSayProcess = () => {
  if (currentSpeechProcess) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", "Stopping current 'say' process.");
    }
    killProcess(currentSpeechProcess, "say", "SIGKILL"); // 'say' might need SIGKILL
    currentSpeechProcess = null;
    isSpeaking = false; // Ensure state is reset
  }
};

const flushQueue = () => {
  logInfo("Flushing speech queue and stopping current speech.");
  speakQueue = [];
  stopSayProcess();
};

const enqueueSpeech = (text: string) => {
  logInfo(`[${new Date().toISOString()}] Received incoming letter: "${text}"`);
  const trimmedText = text.trim();
  if (!trimmedText) return;

  // (remove chars that `say` n europe dislike)
  const sanitizedText = trimmedText.replace(/[^\u{0}-\u{1E79}]/gu, " "); // keep all europe safe item to tts

  if (!sanitizedText) {
    logWarn("Text became empty after sanitization, skipping enqueue.");
    return;
  }

  if (speakQueue.length === 0) {
    speakQueue.push(sanitizedText);
  } else {
    const last = speakQueue[speakQueue.length - 1];
    if (!last.match(/\s$/)) {
      speakQueue[speakQueue.length - 1] += " " + sanitizedText;
    } else {
      speakQueue[speakQueue.length - 1] += sanitizedText;
    }
  }
  if (process.env.NODE_ENV !== "production") {
    console.debug("[DEBUG]", `Enqueued: "${sanitizedText}". Queue length: ${speakQueue.length}`);
  }
};

const coretts = (textToSpeak) => ["say", "-r", String(TTS_RATE), textToSpeak];
const startNextSpeech = () => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[DEBUG]", `startNextSpeech called. isSpeaking: ${isSpeaking}, queueLength: ${speakQueue.length}`);
  }
  if (isSpeaking || speakQueue.length === 0) {
    return;
  }

  isSpeaking = true;
  const textToSpeak = speakQueue.shift(); // Get the first item

  if (!textToSpeak) {
    // Should not happen if length > 0, but safety check
    isSpeaking = false;
    return;
  }

  logInfo(`Speaking: "${textToSpeak.substring(0, 50)}..."`);

  try {
    currentSpeechProcess = spawn(coretts(textToSpeak), {
      stdin: "ignore", // No input needed
      stderr: "inherit",
      onExit: (proc, exitCode, signalCode, error) => {
        if (process.env.NODE_ENV !== "production") {
          console.debug("[DEBUG]", `'say' process exited. Code: ${exitCode}, Signal: ${signalCode}`);
        }
        if (error) {
          logError("'say' process exited with error:", error);
        }
        // Check if this callback is for the process we *thought* was current
        if (currentSpeechProcess && currentSpeechProcess.pid === proc.pid) {
          currentSpeechProcess = null;
          isSpeaking = false;
          if (process.env.NODE_ENV !== "production") {
            console.debug("[DEBUG]", "Current speech finished, checking queue for next.");
          }

          startNextSpeech();
        } else {
          logWarn(`Received onExit callback for a stale 'say' process (PID: ${proc.pid}). Ignoring.`);
        }
      },
    });

    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `Started 'say' process (PID: ${currentSpeechProcess.pid})`);
    }

    // Handle potential immediate errors during spawn (though less common with spawn)
    if (!currentSpeechProcess || !currentSpeechProcess.pid) {
      throw new Error("Failed to get valid process handle from spawn.");
    }
  } catch (error) {
    logError("Failed to spawn 'say' process:", error);
    currentSpeechProcess = null; // Ensure cleanup
    isSpeaking = false;
    // Try next item after a failure
    setTimeout(startNextSpeech, 50); // Small delay before retrying
  }
};

const replaceSpeechImmediately = (newText: string) => {
  logInfo(`Replacing current speech with: "${newText.substring(0, 50)}..."`);
  flushQueue(); // Clear queue and stop current speech
  enqueueSpeech(newText); // Add the new text
  startNextSpeech(); // Start speaking the new text
};

// --- EU Classical Stream Functions ---

const findEuPlayer = (): string | null => {
  for (const p of EU_PLAYER_PATHS) {
    if (fs.existsSync(p)) {
      logInfo(`Found EU player: ${p}`);
      return p;
    }
  }
  logWarn(
    `Could not find ffplay or mpv in specified paths: ${EU_PLAYER_PATHS.join(", ")}. EU stream playback will fail.`
  );
  return null;
};

const stopFeeder = () => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[DEBUG]", "Stopping EU stream feeder (curl)...");
  }
  if (euFeederProcess) {
    killProcess(euFeederProcess, "curl feeder");
    euFeederProcess = null;
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", "No active feeder process handle found, using pkill as fallback.");
    }
    // Use pkill as a fallback to catch manually started or orphaned processes
    pkillProcess(`${CURL_PATH}.*${EU_FIFO_PATH}`);
  }
};

const eu_warm = () => {
  logInfo("Warming EU stream feeder...");
  stopFeeder(); // Ensure any previous feeder is stopped

  // Use the selected stream URL, guard against undefined
  const STREAM_URL = EU_STREAM_URL;
  if (!STREAM_URL) {
    logError("EU_STREAM_URL is undefined – check stream list. Aborting warm‑up.");
    return;
  }

  // Ensure FIFO exists
  try {
    // Attempt to remove existing FIFO first (ignore error if it doesn't exist)
    try {
      fs.unlinkSync(EU_FIFO_PATH);
      if (process.env.NODE_ENV !== "production") {
        console.debug("[DEBUG]", `Removed existing FIFO: ${EU_FIFO_PATH}`);
      }
    } catch {
      /* Ignore */
    }

    // Create new FIFO
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `Creating FIFO: ${EU_FIFO_PATH}`);
    }
    const mkfifoResult = spawnSync([MKFIFO_PATH, EU_FIFO_PATH]);
    if (mkfifoResult.exitCode !== 0) {
      throw new Error(`mkfifo failed with code ${mkfifoResult.exitCode}: ${mkfifoResult.stderr.toString()}`);
    }
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `FIFO created successfully.`);
    }

    // Start curl feeder process
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `Starting curl feeder: ${CURL_PATH} -sL ${STREAM_URL} -o ${EU_FIFO_PATH}`);
    }
    euFeederProcess = spawn([CURL_PATH, "-sL", STREAM_URL, "-o", EU_FIFO_PATH], {
      stdin: "ignore",
      stdout: "ignore", // Ignore stdout/stderr unless debugging curl itself
      stderr: "ignore",
      onExit: (proc, exitCode, signalCode, error) => {
        logWarn(
          `EU feeder (curl) process (PID: ${proc?.pid ?? "unknown"}) exited. Code: ${exitCode}, Signal: ${signalCode}`
        );
        if (error) logError("Feeder exit error:", error);
        // If the feeder dies unexpectedly, we might want to clear the handle
        if (euFeederProcess && euFeederProcess.pid === proc?.pid) {
          euFeederProcess = null;
        }
      },
    });

    if (!euFeederProcess || !euFeederProcess.pid) {
      throw new Error("Failed to get valid process handle for curl feeder.");
    }
    logInfo(`EU feeder (curl) started (PID: ${euFeederProcess.pid}). Streaming to ${EU_FIFO_PATH}`);
  } catch (error) {
    logError("Error during eu_warm:", error);
    // Clean up if feeder process might have started before error
    if (euFeederProcess) killProcess(euFeederProcess, "curl feeder on error");
    euFeederProcess = null;
  }
};

const eu_start = () => {
  if (!euPlayerPath) {
    logError("Cannot start EU stream: Player path not found.");
    return;
  }
  if (euPlayerProcess && euPlayerProcess.pid) {
    logInfo("EU stream player is already running.");
    return;
  }

  logInfo("Starting EU stream player...");

  // Ensure previous player process is definitely gone
  eu_stop(false); // Stop without warming, just kill player

  try {
    const playerArgs = euPlayerPath.includes("mpv")
      ? ["--no-video", "--quiet", "--cache=no", "--demuxer-max-bytes=32", "--demuxer-readahead-secs=0", EU_FIFO_PATH]
      : [
          "-nodisp",
          "-autoexit",
          "-loglevel",
          "error",
          "-fflags",
          "nobuffer",
          "-flags",
          "low_delay",
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-volume",
          "10",
          EU_FIFO_PATH,
        ];

    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `Spawning EU player: ${euPlayerPath} ${playerArgs.join(" ")}`);
    }

    euPlayerProcess = spawn([euPlayerPath, ...playerArgs], {
      stdin: "ignore",
      stdout: "inherit", // Show player output/errors
      stderr: "inherit",
      onExit: (proc, exitCode, signalCode, error) => {
        logInfo(`EU Player process (PID: ${proc?.pid ?? "unknown"}) exited. Code: ${exitCode}, Signal: ${signalCode}`);
        if (error) logError("EU Player exit error:", error);
        // Clear the handle only if it matches the exited process
        if (euPlayerProcess && euPlayerProcess.pid === proc?.pid) {
          euPlayerProcess = null;
        }
      },
    });

    if (!euPlayerProcess || !euPlayerProcess.pid) {
      throw new Error("Failed to get valid process handle for EU player.");
    }
    logInfo(`EU stream player started (PID: ${euPlayerProcess.pid}). Playing from ${EU_FIFO_PATH}`);
  } catch (error) {
    logError("Error starting EU stream player:", error);
    euPlayerProcess = null; // Ensure handle is cleared on error
  }
};

const eu_stop = (warmAfterStop = false) => {
  logInfo("Stopping EU stream player...");
  if (euPlayerProcess) {
    killProcess(euPlayerProcess, "EU player");
    euPlayerProcess = null;
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", "No active player process handle, using pkill fallback.");
    }
    // Fallback pkill based on likely player paths
    pkillProcess("ffplay.*" + EU_FIFO_PATH);
    pkillProcess("mpv.*" + EU_FIFO_PATH);
  }

  if (warmAfterStop) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", "Warming feeder after stopping player (mute behavior).");
    }
    eu_warm(); // Restart the feeder
  }
};

const startEUPingWatchdog = () => {
  // Always reset the interval so lpEU can relaunch after a mute
  if (euPingTimer) {
    clearInterval(euPingTimer);
    euPingTimer = null;
  }
  euPingTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastEUPing > 1000) {
      logInfo("⏱️ No lpEU ping in >1 s. Muting EU stream.");
      eu_stop(true);
      clearInterval(euPingTimer!);
      euPingTimer = null;
    }
  }, 1000);
};

// --- HTTP Server ---

const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (process.env.NODE_ENV !== "production") {
    console.debug("[DEBUG]", `Received request: ${method} ${path}`);
  }

  if (path === "/speak" && method === "POST") {
    let payload: SpeakPayload = {};
    let bodyText: string | null = null;
    try {
      bodyText = await request.text();
      // Attempt JSON parsing
      try {
        payload = JSON.parse(bodyText) as SpeakPayload;
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Parsed JSON is not an object");
        }
      } catch (jsonError) {
        logWarn(
          `JSON parse failed: ${
            jsonError instanceof Error ? jsonError.message : jsonError
          }. Falling back to using raw body as text.`
        );
        // Fallback: Use the raw body text if JSON parsing fails *or* doesn't yield an object
        // Ensure payload is at least an empty object before assigning text
        payload = {};
        payload.text = bodyText || ""; // Use the raw text
      }

      // --- EU Ping Handling ---
      if ((payload as any).lpEU) {
        lastEUPing = Date.now();
        if (process.env.NODE_ENV !== "production") {
          console.debug("[DEBUG]", "🔄 lpEU ping received.");
        }
        startEUPingWatchdog();
        eu_start(); // Start (or resume) playback on each lpEU ping, mirroring Lua design
        return new Response("lpEU pong", { status: 200 });
      }

      if ((payload as any).dsEU) {
        lastEUPing = Date.now();
        if (process.env.NODE_ENV !== "production") {
          console.debug("[DEBUG]", "📍 dsEU ping received.");
        }
        return new Response("dsEU updated", { status: 200 });
      }

      // --- Action Handling ---
      // Flush first if requested
      if (payload.flushQueue) {
        logInfo("Flush request received via /speak endpoint.");
        flushQueue();
      }

      // EU Controls
      if (payload.playEU) {
        logInfo("playEU request received.");
        eu_start();
        // Return immediately after handling EU command if no text is present
        if (!payload.text?.trim()) return new Response("OK (EU Play)", { status: 200 });
      } else if (payload.stopEU) {
        logInfo("stopEU request received.");
        eu_stop(true); // stopEU implies mute/rewarm
        // Return immediately after handling EU command if no text is present
        if (!payload.text?.trim()) return new Response("OK (EU Stop)", { status: 200 });
      }

      // TTS Handling
      if (payload.text && payload.text.trim()) {
        enqueueSpeech(payload.text);
        startNextSpeech(); // Trigger speaking if not already active
        return new Response("OK (enqueued)", { status: 200 });
      } else {
        // If we only got EU commands or flush, or empty text
        if (process.env.NODE_ENV !== "production") {
          console.debug("[DEBUG]", "Request handled (non-TTS action or empty text).");
        }
        return new Response("OK (action)", { status: 200 });
      }
    } catch (error) {
      logError("Error processing /speak request:", error);
      logError("Request body text was:", bodyText); // Log the body that caused the error
      return new Response("Internal Server Error", { status: 500 });
    }
  } else if (path === "/replace" && method === "POST") {
    try {
      const payload = (await request.json()) as ReplacePayload;
      if (typeof payload !== "object" || payload === null || typeof payload.text !== "string") {
        return new Response("Error: Invalid JSON or missing 'text' field.", {
          status: 400,
        });
      }

      const textToSpeak = payload.text.trim();
      if (textToSpeak) {
        replaceSpeechImmediately(textToSpeak);
        return new Response("OK (replaced)", { status: 200 });
      } else {
        // If replace is called with empty text, maybe just flush? Or do nothing?
        // Current behavior: Flush and speak nothing.
        flushQueue();
        return new Response("OK (empty replace, queue flushed)", {
          status: 200,
        });
      }
    } catch (error) {
      logError("Error processing /replace request:", error);
      if (error instanceof SyntaxError) {
        return new Response("Error: Invalid JSON.", { status: 400 });
      }
      return new Response("Internal Server Error", { status: 500 });
    }
  } else {
    return new Response("Not Found", { status: 404 });
  }
};

// --- Server Control ---

const startServer = () => {
  if (server) {
    logInfo(`Server already running on port ${SERVER_PORT}`);
    return;
  }

  euPlayerPath = findEuPlayer(); // Find player on startup

  try {
    server = serve({
      port: SERVER_PORT,
      fetch: handleRequest,
      error: (error) => {
        logError("Server error:", error);
        return new Response("Internal Server Error", { status: 500 });
      },
    });
    logInfo(`🎙️ TTS Server (using 'say') started on http://localhost:${server.port}`);
    eu_warm(); // Warm up the EU stream on server start
  } catch (error) {
    logError(`Failed to start server on port ${SERVER_PORT}:`, error);
    server = null;
  }
};

const stopServer = () => {
  if (server) {
    logInfo("Stopping TTS Server...");
    server.stop(true); // true for graceful shutdown
    server = null;
    logInfo("Server stopped.");
  } else {
    logInfo("Server not running.");
  }
  // Stop related processes
  flushQueue(); // Stops current speech and clears queue
  stopFeeder();
  eu_stop(false); // Stop player without re-warming

  // Clean up FIFO
  try {
    if (fs.existsSync(EU_FIFO_PATH)) {
      if (process.env.NODE_ENV !== "production") {
        console.debug("[DEBUG]", `Removing FIFO on shutdown: ${EU_FIFO_PATH}`);
      }
      fs.unlinkSync(EU_FIFO_PATH);
    }
  } catch (error) {
    logError(`Error removing FIFO ${EU_FIFO_PATH} on shutdown:`, error);
  }
};


// Optional Electron integration (guarded so Bun tests won’t fail)
let app, globalShortcut;
try {
  ({ app, globalShortcut } = require("electron"));
  app.whenReady().then(() => {
    globalShortcut.register("Shift+Right", () => {
      console.log("Right Shift pressed");
    });
  });
} catch {
  // Electron not available (e.g., running under Bun), skip integration
}

// --- Shutdown Hook ---
const cleanupAndExit = (signal: string) => {
  logInfo(`Received ${signal}. Starting graceful shutdown...`);
  stopServer();
  logInfo("Cleanup complete. Exiting.");
  process.exit(0);
};

process.on("SIGINT", () => cleanupAndExit("SIGINT")); // Ctrl+C
process.on("SIGTERM", () => cleanupAndExit("SIGTERM")); // kill

// --- Main Execution ---
logInfo("Starting script...");
startServer();

// Keep the script running until interrupted
// Bun automatically keeps running while the server is active.
// We add an extra interval just to be explicit if needed, but server.stop() and process.exit() handle termination.
// setInterval(() => {}, 1 << 30); // Keep alive indefinitely (optional)
logInfo("Script initialization complete. Server is running.");

// --- ai cleanup client --------
import { GoogleGenAI, createUserContent } from "@google/genai";

// Configuration
const CONFIG = {
  API_KEY: process.env.GEMINI_API_KEY,

  MODEL_NAME: "gemini-2.5-flash-lite-preview-06-17",

  GENERATION_CONFIG: {
    temperature: 1,
    topK: 32,
    topP: 0.95,
    maxOutputTokens: 32000,
  },
  SYSTEM_INSTRUCTION: `i.main goal: base on full ax tree, ur goal is from there rever to show off exactly last-ai-response(LAR) ; no conversation with user or any other else just pure show off LAR. also the ax tree are noicy avoid any noises eg but not limited like response hist/thoughts/ui etc. also if were none match, the show off shall be empty (null output).
  ii.sub goal: Ingros - facemaks, special simples, non european chars. Replace - simples like '+' '-' if is in math context into 'plus' 'minus' specialy '-' can be mutible means, this just an example the goal is as smartly adatively replace make how to prenowce more direct in europe word.
  iii.main goal - no ur own imgine adds: to make sure the LAR shall as 100% rever as base on the ax tree, no ur own imgine adds, cuz the goal is show or mirr the LAR as it is`,
};

// Initialize the GenAI client
if (!CONFIG.API_KEY) {
  console.error("[ERROR] GEMINI_API_KEY environment variable is not set!");
  console.error("Please set it by running: export GEMINI_API_KEY='your-api-key-here'");
}
const genAI = new GoogleGenAI({ apiKey: CONFIG.API_KEY || "" });

/**
 * Main handler function for serverless execution
 * @param {Object} event - The event object containing the request data
 * @returns {Promise<Object>} The response object
 */
async function handleGeminiRequest(event) {
  try {
    // Parse the incoming request
    const { prompt, conversation = [] } = parseRequest(event);

    if (!prompt) {
      return createResponse(400, { error: "No prompt provided" });
    }

    // Create a chat session (new Gen AI SDK syntax)
    const chat = genAI.chats.create({
      model: CONFIG.MODEL_NAME,
      config: {
        systemInstruction: CONFIG.SYSTEM_INSTRUCTION,
        generationConfig: CONFIG.GENERATION_CONFIG,
      },
      history: [],
    });

    // Send the user's prompt
    const result = await chat.sendMessage({ message: prompt });

    // Robustly extract the model’s text regardless of SDK version
    let text;
    try {
      if (typeof result === "string") {
        text = result; // Some SDK calls return string directly
      } else if (typeof result.text === "function") {
        text = result.text(); // New GenAI SDK
      } else if (result.response && typeof result.response.text === "function") {
        text = result.response.text(); // Old pattern
      } else {
        text = JSON.stringify(result); // Fallback: dump raw JSON
      }
    } catch (e) {
      console.warn("⚠️ Unable to extract text from Gemini response:", e);
      text = "⚠️ Failed to extract text from Gemini response.";
    }

    return createResponse(200, { response: text });
  } catch (error) {
    console.error("Error processing request:", error);
    return createResponse(500, {
      error: "Failed to process request",
      details: error.message,
    });
  }
}

/**
 * Parse the incoming request
 * @param {Object} event - The event object
 * @returns {Object} Parsed request data
 */
function parseRequest(event) {
  // Handle different event formats (API Gateway, direct invocation, etc.)
  let body = {};

  if (event.body) {
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
      console.warn("Failed to parse request body", e);
    }
  }

  return {
    prompt: body.prompt || event.prompt,
    conversation: body.conversation || event.conversation || [],
  };
}

/**
 * Create a standardized response object
 * @param {number} statusCode - HTTP status code
 * @param {Object} body - Response body
 * @returns {Object} Formatted response
 */
function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
    },
    body: JSON.stringify(body, null, 2),
  };
}

// Bun HTTP server using Bun.serve API
Bun.serve({
  port: 41111,
  async fetch(req) {
    try {
      // Log incoming request
      const timestamp = new Date().toISOString();
      console.log(`\n[${timestamp}] Incoming ${req.method} request to ${req.url}`);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // Only allow GET and POST
      if (!["GET", "POST"].includes(req.method)) {
        return new Response(JSON.stringify({ error: "Only GET and POST methods are allowed" }), {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // Handle image analysis endpoint
      if (req.method === "POST" && new URL(req.url).pathname === "/analyze-image") {
        try {
          const data = await req.json();

          if (!data.image || !data.prompt) {
            throw new Error("Missing required fields: image and prompt are required");
          }

          // Create user content with both text and image parts
          const contents = [
            data.prompt,
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: data.image,
              },
            },
          ];

          const result = await genAI.models.generateContent({
            model: CONFIG.MODEL_NAME,
            contents: createUserContent(contents),
            config: {
              systemInstruction: CONFIG.SYSTEM_INSTRUCTION,
              generationConfig: CONFIG.GENERATION_CONFIG,
            },
          });
          const analysis = result.text();

          return new Response(
            JSON.stringify({
              success: true,
              analysis,
              timestamp: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        } catch (error) {
          console.error("Error processing image:", error);
          return new Response(
            JSON.stringify({
              success: false,
              error: error.message,
              timestamp: new Date().toISOString(),
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }
      }

      // Process prompt from GET query or POST body
      let prompt = "";

      if (req.method === "GET") {
        const url = new URL(req.url);
        const searchParams = url.searchParams;
        prompt = Array.from(searchParams.entries())
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");
      } else {
        // POST body as text
        prompt = (await req.text()).trim();
      }

      const result = await handleGeminiRequest({
        prompt: prompt || "No content provided",
        conversation: [],
      });

      // Log and send the response
      console.log(`[${new Date().toISOString()}] Sending response (${result.body.length} bytes)`);

      return new Response(result.body, {
        status: result.statusCode,
        headers: result.headers,
      });
    } catch (error) {
      console.error("Error processing request:", error);
      return new Response(
        JSON.stringify(
          {
            error: "Failed to process request",
            details: error.message,
          },
          null,
          2
        ),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  },
});

console.log(`Gemini API proxy server running at http://localhost:41111/`);
console.log("Endpoints:");
console.log("  GET  /?your=prompt");
console.log('  POST / -d "Your prompt here"');
console.log('  POST /analyze-image -d \'{"image": "base64data...", "prompt": "Describe this image"}\'');

// Export for serverless environments
export { handleGeminiRequest as handleRequest };

/*  on screen hotlink
local q = ""
local g = "https://www.google.com/search?q=" .. q .. "?utm_source=europeansostorng"
local i = "https://www.google.com/search?tbm=isch&q=" .. q .. "?utm_source=europeansostorng"
local c = "https://chatgpt.com/?q=" .. q .. "?utm_source=europeansostorng"

-- what if i let
function hotlink(q)
    -- ne european: open a link in the default browser, but only if it looks like a valid http(s) url
    if type(q) == "string" and q:match("^https?://[%w%.%-_/%%?&=]+$") then
        hs.execute(string.format('open "%s"', q))
    else
        hs.alert.show("⚠️ Not a valid URL: " .. tostring(q), 1.2)
    end
end
function capt(q)
   local cmd = string.format('screencapture -x "%s"', q)
   local ok, out, err, rc = hs.execute(cmd, true)
   if ok and rc == 0 then
       hs.alert.show("✅ Screenshot saved as: " .. q, 1.2)
   else
       hs.alert.show("❌ Screenshot failed: " .. tostring(err), 1.5)
   end
end
function ocr()
  --procese got big string of results, both position and letter
  --now altly just past to gemini
end
function mouse()
  local pos = hs.mouse.absolutePosition()
  local x   = math.floor(pos.x)
  local y   = math.floor(pos.y)
  print(string.format("Mouse at: %d, %d", x, y))
end*/
