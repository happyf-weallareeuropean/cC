import { serve, type Server, spawn, spawnSync, type Subprocess } from "bun";
import { spawn as ptyspawn, type Pty } from "bun-pty";

// --- Local bin resolver (ship-ready) ---
const HERE_DIR = import.meta.dir; // absolute folder for this file
const BIN_DIR = `${HERE_DIR}/bin`;
const PLATFORM_DIR = (() => {
  if (Bun.platform === "darwin" && Bun.arch.startsWith("arm")) return `${BIN_DIR}/mac-aarch`;
  // Fallback: use a generic mapping if other platforms are added later
  return `${BIN_DIR}/${Bun.platform}-${Bun.arch}`;
})();

async function exists(p: string): Promise<boolean> {
  try {
    return await Bun.file(p).exists();
  } catch {
    return false;
  }
}
async function resolveExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) if (await exists(p)) return p;
  return null;
}

// --- Configuration ---
const SERVER_PORT = 65535;
const TTS_RATE = 190; // Speech rate for the 'say' command
const isProd = Bun.env.NODE_ENV === "production";

const logInfo = (...args: any[]) => {
  if (!isProd) console.log("[INFO]", ...args);
};
const logWarn = (...args: any[]) => {
  if (!isProd) console.warn("[WARN]", ...args);
};
const logError = console.error.bind(console, "[ERROR]"); // Always log errors

// A pool of reliable ad‑free European classical streams
const EU_STREAM_URLS = [
  // "https://www.concertzender.nl/streams/klassiek",
  // "https://icecast.omroep.nl/radio4-bb-mp3",
  // "http://icecast.vrtcdn.be/klaracontinuo-high.mp3",
  "http://116.202.241.212:8010/stream",
  "http://148.251.43.231:8742/160",
  "https://mediaserviceslive.akamaized.net/hls/live/2038317/classic2/index.m3u8",
  "https://pianosolo.streamguys1.com/live",//had speak
];
// Pick one at random from the array (avoid out‑of‑bounds undefined)
const EU_STREAM_URL = EU_STREAM_URLS[Math.floor(Math.random() * EU_STREAM_URLS.length)];
const EU_FIFO_PATH = "/tmp/eu_fifo";
const EU_PLAYER_PATHS = [`${PLATFORM_DIR}/mpv/mpv`, "/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/usr/bin/mpv"];
const CURL_PATH = (await resolveExisting([`${PLATFORM_DIR}/curl/curl`, "/usr/bin/curl", "/opt/homebrew/bin/curl"])) || "curl";
const MKFIFO_PATH = (await resolveExisting([`${PLATFORM_DIR}/mkfifo/mkfifo`, "/usr/bin/mkfifo", "/opt/homebrew/bin/mkfifo"])) || "mkfifo";
const PKILL_PATH = (await resolveExisting([`${PLATFORM_DIR}/pkill/pkill`, "/usr/bin/pkill", "/opt/homebrew/bin/pkill"])) || "pkill";

// --- State ---
let server: Server | null = null;
let speakQueue: string[] = [];
let isSpeaking = false;
let currentSpeechProcess: Subprocess | null = null;
let euPlayerPath: string | null = null;
let euStarting = false;
let euMpv: Pty | null = null;
let euMuted = true; // default muted
// Removed: let euFeederProcess, let euPlayerProcess
let lastEUPing = 0;
let euPingTimer: ReturnType<typeof setInterval> | null = null;

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
const killProcess = (proc: Subprocess | null, name: string, signal: number = 15) => {
  if (proc && proc.pid) {
    if (Bun.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `Attempting to kill ${name} process (PID: ${proc.pid}) with signal ${signal}...`);
    }
    const killed = proc.kill(signal);
    if (Bun.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", `${name} process kill signal sent (success: ${killed}).`);
    }
    return killed;
  }
  return false;
};

const pkillProcess = (pattern: string) => {
  if (Bun.env.NODE_ENV !== "production") {
    console.debug("[DEBUG]", `Attempting to pkill processes matching: ${pattern}`);
  }
  try {
    const result = spawnSync([PKILL_PATH, "-f", pattern]);
    if (result.exitCode === 0) {
      if (Bun.env.NODE_ENV !== "production") {
        console.debug("[DEBUG]", `pkill successful for pattern: ${pattern}`);
      }
    } else if (result.exitCode === 1) {
      if (Bun.env.NODE_ENV !== "production") {
        console.debug("[DEBUG]", `No processes found matching pattern: ${pattern}`);
      }
    } else {
      const stderrText = new TextDecoder().decode(result.stderr);
      logWarn(`pkill for pattern "${pattern}" exited with code ${result.exitCode}. Stderr: ${stderrText}`);
    }
  } catch (error) {
    logError(`Error executing pkill for pattern "${pattern}":`, error);
  }
};

// --- TTS Functions ---

const stopSayProcess = () => {
  if (currentSpeechProcess) {
    if (Bun.env.NODE_ENV !== "production") {
      console.debug("[DEBUG]", "Stopping current 'say' process.");
    }
    killProcess(currentSpeechProcess, "say", 9); // SIGKILL
    currentSpeechProcess = null;
    isSpeaking = false; // Ensure state is reset
  }
};

const flushQueue = () => {
  logInfo("Flushing speech queue and stopping current speech.");
  speakQueue = [];
  stopSayProcess();
  // eumute(); // temporarily disabled per request
};

const enqueueSpeech = (text: string) => {
  logInfo(`[${new Date().toISOString()}] Received incoming letter: "${text}"`);

  const sanitizedText = text.replace(/[^\u{20}-\u{39}\u{3B}-\u{1E79}\u{2000}-\u{218F}\u{2200}-\u{23FF}\u{2460}-\u{24FF}]/gu, " "); // keep all europe safe item to tts

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
  if (!isProd) {
    console.debug("[DEBUG]", `Enqueued: "${sanitizedText}". Queue length: ${speakQueue.length}`);
  }
};

const coretts = (textToSpeak) => ["say", "-r", String(TTS_RATE), textToSpeak];
const startNextSpeech = () => {
  if (!isProd) {
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
        if (!isProd) {
          console.debug("[DEBUG]", `'say' process exited. Code: ${exitCode}, Signal: ${signalCode}`);
        }
        if (error) {
          logError("'say' process exited with error:", error);
        }
        // Check if this callback is for the process we *thought* was current
        if (currentSpeechProcess && currentSpeechProcess.pid === proc.pid) {
          currentSpeechProcess = null;
          isSpeaking = false;
          if (!isProd) {
            console.debug("[DEBUG]", "Current speech finished, checking queue for next.");
          }

          startNextSpeech();
        } else {
          logWarn(`Received onExit callback for a stale 'say' process (PID: ${proc.pid}). Ignoring.`);
        }
      },
    });

    if (!isProd) {
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

const findEuPlayer = async (): Promise<string | null> => {
  // Prefer shipped binary under bin/, then PATH, then known fallbacks
  const localFirst = await resolveExisting([EU_PLAYER_PATHS[0]]);
  if (localFirst) {
    logInfo(`Found EU player: ${localFirst}`);
    return localFirst;
  }
  const inPath = Bun.which("mpv");
  if (inPath) {
    logInfo(`Found EU player in PATH: ${inPath}`);
    return inPath;
  }
  const fallback = await resolveExisting(EU_PLAYER_PATHS.slice(1));
  if (fallback) {
    logInfo(`Found EU player (fallback): ${fallback}`);
    return fallback;
  }
  logWarn(`Could not find mpv in local bin, PATH, or fallbacks: ${EU_PLAYER_PATHS.join(", ")}`);
  return null;
};

const eu_start = async () => {
  if (!euPlayerPath) {
    logError("Cannot start EU stream: Player path not found.");
    return;
  }
  if (euMpv) {
    logInfo("EU (mpv) already running.");
    return;
  }
  if (euStarting) {
    logInfo("EU stream start already in progress; skipping.");
    return;
  }
  euStarting = true;
  logInfo("Starting EU stream (mpv)...");
  try {
    // mpv direct playback; default muted per requirement
    euMpv = ptyspawn(euPlayerPath, [
      "--profile=low-latency",
      "--demuxer-donate-buffer=no",
      "--ad-queue-enable=no",
      "--keep-open=no",
      "--cache=no",
      "--no-video",
      "--quiet",
      "--mute=yes",
      "--no-ytdl",
      "--af=volume=0.15",
      EU_STREAM_URL,
    ]);

    euMuted = true;
    euMpv.onData((d) => {
      if (!isProd) Bun.stdout.write(d);
    });
    euMpv.onExit?.(() => {
      euMpv = null;
    });
    logInfo("EU (mpv) started.");
  } catch (error) {
    logError("Error starting mpv:", error);
  } finally {
    euStarting = false;
  }
};

let eusafe = true;
const eu_flip_mute = () => {
  if (!eusafe) return;
  eusafe = false;
  if (euMpv) {
    euMpv.write("m\r");
  }
  euMuted = !euMuted;
  eusafe = true;
};
const eumute = () => {
  if (!euMuted) eu_flip_mute();
};
const euunmute = () => {
  if (euMuted) eu_flip_mute();
};  
//const eu_mute = (boolean) => {};

const startEUPingWatchdog = () => {
  if (euPingTimer) return; // already watching
  euPingTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastEUPing > 1000) {
      logInfo("⏱️ No lpEU ping in >1 s. Muting EU stream.");
      eumute();
    }
  }, 1000);
};

const eu_exitmpv = () => {
  if (euMpv) {
    euMpv.kill();
  }
};

// --- HTTP Server ---

const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!isProd) {
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
        logWarn(`JSON parse failed: ${jsonError instanceof Error ? jsonError.message : jsonError}. Falling back to using raw body as text.`);
        // Fallback: Use the raw body text if JSON parsing fails *or* doesn't yield an object
        // Ensure payload is at least an empty object before assigning text
        payload = {};
        payload.text = bodyText || ""; // Use the raw text
      }

      // --- EU Ping Handling ---
      if ((payload as any).lpEU) {
        lastEUPing = Date.now();
        if (!isProd) {
          console.debug("[DEBUG]", "🔄 lpEU ping received.");
        }
        // if (!euMpv) await eu_start(); // disabled
        // startEUPingWatchdog(); // keep watchdog off while EU is disabled
        // euunmute(); // disabled
        return new Response("lpEU pong", { status: 200 });
      }

      if ((payload as any).dsEU) {
        lastEUPing = Date.now();
        if (!isProd) {
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
        // if (!euMpv) await eu_start(); // disabled
        // euunmute(); // disabled
        // Return immediately after handling EU command if no text is present
        if (!payload.text?.trim()) return new Response("OK (EU Play)", { status: 200 });
      } else if (payload.stopEU) {
        logInfo("stopEU request received.");
        // eumute(); // disabled
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
        if (!isProd) {
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

const startServer = async () => {
  if (server) {
    logInfo(`Server already running on port ${SERVER_PORT}`);
    return;
  }

  euPlayerPath = await findEuPlayer(); // Find player on startup

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
    // Lazy start EU stream only when requested via playEU/lpEU
    // void eu_warm();
  } catch (error) {
    logError(`Failed to start server on port ${SERVER_PORT}:`, error);
    server = null;
  }
};

const stopServer = async () => {
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
  // eu_exitmpv(); // disabled
};

// Optional Electron integration (guarded so Bun tests won’t fail)
/*let app, globalShortcut;
try {
  const electron = await import("electron");
  app = electron.app;
  globalShortcut = electron.globalShortcut;
  app.whenReady().then(() => {
    globalShortcut.register("Shift+Right", () => {
      console.log("Right Shift pressed");
    });
  });
} catch {
  // Electron not available (e.g., running under Bun), skip integration
}
*/

// --- Shutdown Hook ---
const cleanupAndExit = async (signal: string) => {
  logInfo(`Received ${signal}. Starting graceful shutdown...`);
  await stopServer();
  logInfo("Cleanup complete. Exiting.");
  process.exit(0);
};

process.on("SIGINT", () => {
  void cleanupAndExit("SIGINT");
}); // Ctrl+C
process.on("SIGTERM", () => {
  void cleanupAndExit("SIGTERM");
}); // kill

// --- Main Execution ---
logInfo("Starting script...");
void startServer();

// Keep the script running until interrupted
// Bun automatically keeps running while the server is active.

// --- ai cleanup client --------
// Note: Gemini proxy is disabled in production to avoid overhead.
let handleGeminiRequest: (event: any) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
if (!isProd) {
  // Dev-only dynamic import to avoid loading SDK in production
  const initGemini = async () => {
    const { GoogleGenAI, createUserContent } = await import("@google/genai");

    // Configuration
    const CONFIG = {
      API_KEY: Bun.env.GEMINI_API_KEY,
      MODEL_NAME: "gemini-2.5-flash-lite-preview-06-17",
      GENERATION_CONFIG: { temperature: 1, topK: 32, topP: 0.95, maxOutputTokens: 32000 },
      SYSTEM_INSTRUCTION: `i.main goal: base on full ax tree, ur goal is from there rever to show off exactly last-ai-response(LAR) ; no conversation with user or any other else just pure show off LAR. also the ax tree are noicy avoid any noises eg but not limited like response hist/thoughts/ui etc. also if were none match, the show off shall be empty (null output).
      ii.sub goal: Ingros - facemaks, special simples, non european chars. Replace - simples like '+' '-' if is in math context into 'plus' 'minus' specialy '-' can be mutible means, this just an example the goal is as smartly adatively replace make how to prenowce more direct in europe word.
      iii.main goal - no ur own imgine adds: to make sure the LAR shall as 100% rever as base on the ax tree, no ur own imgine adds, cuz the goal is show or mirr the LAR as it is`,
    } as const;

    if (!CONFIG.API_KEY) {
      console.error("[ERROR] GEMINI_API_KEY environment variable is not set!");
      console.error("Please set it by running: export GEMINI_API_KEY='your-api-key-here'");
    }
    const genAI = new GoogleGenAI({ apiKey: CONFIG.API_KEY || "" });

    async function _handleGeminiRequest(event: any) {
      try {
        const { prompt, conversation = [] } = parseRequest(event);
        if (!prompt) return createResponse(400, { error: "No prompt provided" });

        const chat = genAI.chats.create({
          model: CONFIG.MODEL_NAME,
          config: { systemInstruction: CONFIG.SYSTEM_INSTRUCTION, generationConfig: CONFIG.GENERATION_CONFIG },
          history: [],
        });

        const result: any = await chat.sendMessage({ message: prompt });
        let text: string;
        try {
          if (typeof result === "string") text = result;
          else if (typeof result.text === "function") text = result.text();
          else if (result.response && typeof result.response.text === "function") text = result.response.text();
          else text = JSON.stringify(result);
        } catch (e) {
          console.warn("Unable to extract text from Gemini response:", e);
          text = "Failed to extract text from Gemini response.";
        }
        return createResponse(200, { response: text });
      } catch (error: any) {
        console.error("Error processing request:", error);
        return createResponse(500, { error: "Failed to process request", details: error?.message });
      }
    }

    // Expose handler
    handleGeminiRequest = _handleGeminiRequest;

    // Dev-only Bun server for Gemini proxy
    Bun.serve({
      port: 41111,
      async fetch(req) {
        try {
          const timestamp = new Date().toISOString();
          console.log(`\n[${timestamp}] Incoming ${req.method} request to ${req.url}`);

          if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
          }
          if (!["GET", "POST"].includes(req.method)) {
            return new Response(JSON.stringify({ error: "Only GET and POST methods are allowed" }), { status: 405, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
          }

          if (req.method === "POST" && new URL(req.url).pathname === "/analyze-image") {
            try {
              const data = await req.json();
              if (!data.image || !data.prompt) throw new Error("Missing required fields: image and prompt are required");
              const contents = [data.prompt, { inlineData: { mimeType: "image/jpeg", data: data.image } }];
              const result = await (await import("@google/genai")).GoogleGenAI.prototype.models.generateContent.call(genAI, { model: "gemini-2.5-flash-lite-preview-06-17", contents: (await import("@google/genai")).createUserContent(contents), config: { systemInstruction: (genAI as any).SYSTEM_INSTRUCTION, generationConfig: (genAI as any).GENERATION_CONFIG } });
              const analysis = (result as any).text();
              return new Response(JSON.stringify({ success: true, analysis, timestamp: new Date().toISOString() }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
            } catch (error: any) {
              console.error("Error processing image:", error);
              return new Response(JSON.stringify({ success: false, error: error.message, timestamp: new Date().toISOString() }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
            }
          }

          let prompt = "";
          if (req.method === "GET") {
            const url = new URL(req.url);
            const searchParams = url.searchParams;
            prompt = Array.from(searchParams.entries()).map(([key, value]) => `${key}=${value}`).join("\n");
          } else {
            prompt = (await req.text()).trim();
          }

          const result = await _handleGeminiRequest({ prompt: prompt || "No content provided", conversation: [] });
          console.log(`[${new Date().toISOString()}] Sending response (${result.body.length} bytes)`);
          return new Response(result.body, { status: result.statusCode, headers: result.headers });
        } catch (error: any) {
          console.error("Error processing request:", error);
          return new Response(JSON.stringify({ error: "Failed to process request", details: error.message }, null, 2), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        }
      },
    });

    console.log(`Gemini API proxy server running at http://localhost:41111/`);
    console.log("Endpoints:");
    console.log("  GET  /?your=prompt");
    console.log('  POST / -d "Your prompt here"');
    
  };

  // Kick off init (no await to not block TTS)
  initGemini().catch((e) => console.error("Gemini init failed", e));
} else {
  // Production stub (no extra server started)
  handleGeminiRequest = async () =>
    ({
      statusCode: 503,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Gemini proxy disabled in production" }),
    });
}

/**
 * Parse the incoming request
 * @param {Object} event - The event object
 * @returns {Object} Parsed request data
 */
function parseRequest(event: any) {
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
function createResponse(statusCode: number, body: any) {
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

// Export for serverless environments (stub in production)
export { handleGeminiRequest as handleRequest };

//inspect
// ffmpeg screenshot
// Async ffmpeg screenshot to PNG bytes using Bun.spawn and Web Streams
async function ffmpeg(): Promise<Uint8Array> {
  const ff = spawn(["ffmpeg", "-f", "avfoundation", "-framerate", "1", "-i", "1:none", "-vframes", "1", "-f", "image2pipe", "-c:v", "jxl", "pipe:1"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const outBuf = new Uint8Array(await new Response(ff.stdout!).arrayBuffer());
  // Optional: decode stderr for debugging
  if (!isProd && ff.stderr) {
    const errText = await new Response(ff.stderr).text();
    if (errText.trim()) console.debug("[ffmpeg stderr]", errText);
  }
  return outBuf;
}
// mouse position n click
// ax tree activaty (clicks ele hirachy, )

// env

//triger n memory
// key press
// memo: what the logs is bind with what key preesed
//deci: if likey be try to use this key press to trigger gui

//perform gui action
//ax simula, fallb mouse simulat

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
