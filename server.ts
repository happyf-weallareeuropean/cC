import {
  serve,
  type Server,
  Bun,
  spawn,
  spawnSync,
  type Subprocess,
} from "bun";
import fs from "node:fs";
import path from "node:path";

// --- Configuration ---
const DEBUG = true;
const SERVER_PORT = 8080;
const TTS_RATE = 190; // Speech rate for the 'say' command

// EU Stream Config
const EU_STREAM_URL = "https://stream.srg-ssr.ch/m/rsc_de/mp3_128";
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
const logDebug = (...args: any[]) => {
  if (DEBUG) {
    console.log(`[DEBUG]`, ...args);
  }
};

const logInfo = (...args: any[]) => {
  console.log(`[INFO]`, ...args);
};

const logWarn = (...args: any[]) => {
  console.warn(`[WARN]`, ...args);
};

const logError = (...args: any[]) => {
  console.error(`[ERROR]`, ...args);
};

const killProcess = (
  proc: Subprocess | null,
  name: string,
  signal: NodeJS.Signals | number = "SIGTERM"
) => {
  if (proc && proc.pid) {
    logDebug(
      `Attempting to kill ${name} process (PID: ${proc.pid}) with signal ${signal}...`
    );
    const killed = proc.kill(signal as number); // Bun's types might mismatch NodeJS.Signals sometimes
    logDebug(`${name} process kill signal sent (success: ${killed}).`);
    return killed;
  }
  return false;
};

const pkillProcess = (pattern: string) => {
  logDebug(`Attempting to pkill processes matching: ${pattern}`);
  try {
    const result = spawnSync([PKILL_PATH, "-f", pattern]);
    if (result.exitCode === 0) {
      logDebug(`pkill successful for pattern: ${pattern}`);
    } else if (result.exitCode === 1) {
      logDebug(`No processes found matching pattern: ${pattern}`);
    } else {
      logWarn(
        `pkill for pattern "${pattern}" exited with code ${
          result.exitCode
        }. Stderr: ${result.stderr.toString()}`
      );
    }
  } catch (error) {
    logError(`Error executing pkill for pattern "${pattern}":`, error);
  }
};

// --- TTS Functions ---

const stopSayProcess = () => {
  if (currentSpeechProcess) {
    logDebug("Stopping current 'say' process.");
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
  const trimmedText = text.trim();
  if (!trimmedText) return;

  // Basic sanitation (remove potential non-UTF8 chars that `say` might dislike)
  // This is a very basic filter; more robust UTF8 validation might be needed
  const sanitizedText = trimmedText.replace(/[\u{80}-\u{FFFF}]/gu, ""); // Keep ASCII + basic Latin supplement? Adjust as needed.

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
  logDebug(`Enqueued: "${sanitizedText}". Queue length: ${speakQueue.length}`);
};

const startNextSpeech = () => {
  logDebug(
    `startNextSpeech called. isSpeaking: ${isSpeaking}, queueLength: ${speakQueue.length}`
  );
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
    const coretts = ["say", "-r", String(TTS_RATE), textToSpeak];
    currentSpeechProcess = spawn(coretts, {
      stdin: "ignore", // No input needed
      stdout: "inherit", // Inherit stdout/stderr for potential messages/errors from 'say'
      stderr: "inherit",
      onExit: (proc, exitCode, signalCode, error) => {
        logDebug(
          `'say' process exited. Code: ${exitCode}, Signal: ${signalCode}`
        );
        if (error) {
          logError("'say' process exited with error:", error);
        }
        // Check if this callback is for the process we *thought* was current
        if (currentSpeechProcess && currentSpeechProcess.pid === proc.pid) {
          currentSpeechProcess = null;
          isSpeaking = false;
          logDebug("Current speech finished, checking queue for next.");
          // Use setTimeout to avoid potential deep recursion if 'say' fails instantly
          setTimeout(startNextSpeech, 0);
        } else {
          logWarn(
            `Received onExit callback for a stale 'say' process (PID: ${proc.pid}). Ignoring.`
          );
        }
      },
    });

    logDebug(`Started 'say' process (PID: ${currentSpeechProcess.pid})`);

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
    `Could not find ffplay or mpv in specified paths: ${EU_PLAYER_PATHS.join(
      ", "
    )}. EU stream playback will fail.`
  );
  return null;
};

const stopFeeder = () => {
  logDebug("Stopping EU stream feeder (curl)...");
  if (euFeederProcess) {
    killProcess(euFeederProcess, "curl feeder");
    euFeederProcess = null;
  } else {
    logDebug("No active feeder process handle found, using pkill as fallback.");
    // Use pkill as a fallback to catch manually started or orphaned processes
    pkillProcess(`${CURL_PATH}.*${EU_FIFO_PATH}`);
  }
};

const eu_warm = () => {
  logInfo("Warming EU stream feeder...");
  stopFeeder(); // Ensure any previous feeder is stopped

  // Ensure FIFO exists
  try {
    // Attempt to remove existing FIFO first (ignore error if it doesn't exist)
    try {
      fs.unlinkSync(EU_FIFO_PATH);
      logDebug(`Removed existing FIFO: ${EU_FIFO_PATH}`);
    } catch {
      /* Ignore */
    }

    // Create new FIFO
    logDebug(`Creating FIFO: ${EU_FIFO_PATH}`);
    const mkfifoResult = spawnSync([MKFIFO_PATH, EU_FIFO_PATH]);
    if (mkfifoResult.exitCode !== 0) {
      throw new Error(
        `mkfifo failed with code ${
          mkfifoResult.exitCode
        }: ${mkfifoResult.stderr.toString()}`
      );
    }
    logDebug(`FIFO created successfully.`);

    // Start curl feeder process
    logDebug(
      `Starting curl feeder: ${CURL_PATH} -sL ${EU_STREAM_URL} -o ${EU_FIFO_PATH}`
    );
    euFeederProcess = spawn(
      [CURL_PATH, "-sL", EU_STREAM_URL, "-o", EU_FIFO_PATH],
      {
        stdin: "ignore",
        stdout: "ignore", // Ignore stdout/stderr unless debugging curl itself
        stderr: "ignore",
        onExit: (proc, exitCode, signalCode, error) => {
          logWarn(
            `EU feeder (curl) process (PID: ${
              proc?.pid ?? "unknown"
            }) exited. Code: ${exitCode}, Signal: ${signalCode}`
          );
          if (error) logError("Feeder exit error:", error);
          // If the feeder dies unexpectedly, we might want to clear the handle
          if (euFeederProcess && euFeederProcess.pid === proc?.pid) {
            euFeederProcess = null;
          }
        },
      }
    );

    if (!euFeederProcess || !euFeederProcess.pid) {
      throw new Error("Failed to get valid process handle for curl feeder.");
    }
    logInfo(
      `EU feeder (curl) started (PID: ${euFeederProcess.pid}). Streaming to ${EU_FIFO_PATH}`
    );
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
      ? [
          "--no-video",
          "--quiet",
          "--cache=no",
          "--demuxer-max-bytes=32",
          "--demuxer-readahead-secs=0",
          EU_FIFO_PATH,
        ]
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
          "50",
          EU_FIFO_PATH,
        ];

    logDebug(`Spawning EU player: ${euPlayerPath} ${playerArgs.join(" ")}`);

    euPlayerProcess = spawn([euPlayerPath, ...playerArgs], {
      stdin: "ignore",
      stdout: "inherit", // Show player output/errors
      stderr: "inherit",
      onExit: (proc, exitCode, signalCode, error) => {
        logInfo(
          `EU Player process (PID: ${
            proc?.pid ?? "unknown"
          }) exited. Code: ${exitCode}, Signal: ${signalCode}`
        );
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
    logInfo(
      `EU stream player started (PID: ${euPlayerProcess.pid}). Playing from ${EU_FIFO_PATH}`
    );
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
    logDebug("No active player process handle, using pkill fallback.");
    // Fallback pkill based on likely player paths
    pkillProcess("ffplay.*" + EU_FIFO_PATH);
    pkillProcess("mpv.*" + EU_FIFO_PATH);
  }

  if (warmAfterStop) {
    logDebug("Warming feeder after stopping player (mute behavior).");
    eu_warm(); // Restart the feeder
  }
};

// --- HTTP Server ---

const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  logDebug(`Received request: ${method} ${path}`);

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
        if (!payload.text?.trim())
          return new Response("OK (EU Play)", { status: 200 });
      } else if (payload.stopEU) {
        logInfo("stopEU request received.");
        eu_stop(true); // stopEU implies mute/rewarm
        // Return immediately after handling EU command if no text is present
        if (!payload.text?.trim())
          return new Response("OK (EU Stop)", { status: 200 });
      }

      // TTS Handling
      if (payload.text && payload.text.trim()) {
        enqueueSpeech(payload.text);
        startNextSpeech(); // Trigger speaking if not already active
        return new Response("OK (enqueued)", { status: 200 });
      } else {
        // If we only got EU commands or flush, or empty text
        logDebug("Request handled (non-TTS action or empty text).");
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
      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof payload.text !== "string"
      ) {
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
    logInfo(
      `🎙️ TTS Server (using 'say') started on http://localhost:${server.port}`
    );
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
      logDebug(`Removing FIFO on shutdown: ${EU_FIFO_PATH}`);
      fs.unlinkSync(EU_FIFO_PATH);
    }
  } catch (error) {
    logError(`Error removing FIFO ${EU_FIFO_PATH} on shutdown:`, error);
  }
};

// --- Health Check ---
setInterval(() => {
  logDebug(
    `[HealthCheck] isSpeaking: ${isSpeaking}, queueLength: ${
      speakQueue.length
    }, euFeederPID: ${euFeederProcess?.pid ?? "none"}, euPlayerPID: ${
      euPlayerProcess?.pid ?? "none"
    }`
  );
}, 30 * 1000); // Check every 30 seconds

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
