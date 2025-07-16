// ==UserScript==
// @name         cC~
// @homepageURL  https://github.com/happyf-weallareeuropean/cC
// @namespace    https://github.com/happyf-weallareeuropean
// @version      a.a
// @author       felixy happyfceleste & Johannes Thyroff(https://github.com/JThyroff/WideGPT)
// @description  close ur eyes or open ur eyes all better for eyes
// @updateURL    https://raw.githubusercontent.com/happyf-weallareeuropean/cC/main/token-post.js
// @downloadURL  https://raw.githubusercontent.com/happyf-weallareeuropean/cC/main/token-post.js
// @match     *://chatgpt.com/*
// @match     *://gemini.google.com/*
// @match     *://claude.ai/*
// @match     *://mistral.ai/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=openai.com
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @run-at       document-start

// ==/UserScript==

(() => {
  /* Use page context for hooks
  const uW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // Lower-level stream hook: intercept fetch streaming tokens directly
  const origFetch = uW.fetch;
  uW.fetch = async (...args) => {
    console.log("[fetch-hook] invoked, url:", args[0]);
    const response = await origFetch(...args);
    const contentType = response.headers.get("Content-Type");
    console.log("[fetch-hook] content-type:", contentType);

    if (args[0].includes("/backend-api/conversation") && contentType?.includes("text/event-stream")) {
      console.log("[fetch-hook] matched conversation endpoint and stream confirmed");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let buffer = '';
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          console.log("[fetch-hook] stream chunk (first 100 bytes):", value && value.slice ? value.slice(0, 100) : value);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const json = line.slice(6);
              try {
                const msg = JSON.parse(json);
                const delta = msg.choices?.[0]?.delta;
                if (delta?.content) {
                  GM_xmlhttpRequest({
                    method: "POST",
                    url: "http://localhost:65535/speak",
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({ text: delta.content })
                  });
                }
              } catch (err) {
                console.warn("Streaming parse failed", err);
              }
            }
          }
        }
      })();
    } else {
      console.log("[fetch-hook] no match conversation endpoint:", args[0], contentType);
    }

    return response;
  };*/
  /* Monkey-patch EventSource to intercept raw ChatGPT token stream
  const _OrigEventSource = uW.EventSource;
  uW.EventSource = function(url, ...args) {
    console.log("[SSE-hook] EventSource intercepted, url:", url);
    const es = new _OrigEventSource(url, ...args);
    if (typeof url === 'string' && url.includes("/backend-api/conversation")) {
      es.addEventListener('message', e => {
        if (!e.data || e.data === '[DONE]') return;
        // split lines in case multiple data: entries
        e.data.split('\n').forEach(line => {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            try {
              const msg = JSON.parse(jsonStr);
              const delta = msg.choices?.[0]?.delta;
              if (delta?.content) {
                // send each raw token to TTS server
                GM_xmlhttpRequest({
                  method: "POST",
                  url: "http://localhost: 65535/speak",
                  headers: { "Content-Type": "application/json" },
                  data: JSON.stringify({ text: delta.content })
                });
              }
            } catch (err) {
              console.error('SSE parse error', err);
            }
          }
        });
      });
    }
    return es;
  };
  uW.EventSource.prototype = _OrigEventSource.prototype;*/
  // -------------------------------------------------------------------
  /* ==== CSS TRIMS ==== */
  const host = location.host;
  function insCss(cssText) {
    const head = document.head || document.documentElement;
    let styleNode = document.getElementById("vwide-css-top");
    if (!styleNode) {
      styleNode = document.createElement("style");
      styleNode.id = "vwide-css-top";
      styleNode.type = "text/css";
      head.append(styleNode);
    }
    styleNode.textContent = cssText;
  }

  // dom way
  if (host === "chatgpt.com") {
    let euok = false;
    const port = 65535; //8080
    // will match   <div class="markdown prose …">
    // will NOT match <div class="dsfji-markdown-prose …">
    // will match only if class starts exactly with "markdown prose"
    const sel_resp = 'div[class~="markdown"][class~="prose"]';

    function ttsend({ text, flushQueue = false, onSuccess = null }) {
      // filter out colons and arten
      const atext = text
        .replace(/:/g, "")
        .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
      const payload = flushQueue
        ? { flushQueue: true, text: atext }
        : { text: atext };
      GM_xmlhttpRequest({
        method: "POST",
        url: `http://localhost:${port}/speak`,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        data: JSON.stringify(payload),
        onload(response) {
          if (response.status === 200) {
            if (onSuccess) onSuccess();
          } else {
            console.error(
              "❌ ttsend failed:",
              response.status,
              response.statusText,
              response.responseText
            );
          }
        },
        onerror(err) {
          console.error("❌ ttsend network error", err);
        },
      });
    }
    const sel_chatlist = [
      "main .group\\/thread .group\\/conversation-turn",
      "main .flex.flex-col.text-sm",
      ".stretch.mx-auto.flex.w-full .flex-col.text-sm",
    ];
    const sel_scrolbut =
      "button.cursor-pointer.absolute.z-10.rounded-full.bg-clip-padding.border.text-token-text-secondary.border-token-border-default";

    // Helper: extract text, include direct text nodes and first-level <span> text, skip deeper spans
    function getCleanText(node) {
      let txt = "";
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          // direct text
          txt += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName === "SPAN") {
            // include only immediate text children of this span
            child.childNodes.forEach((inner) => {
              if (inner.nodeType === Node.TEXT_NODE) {
                txt += inner.textContent;
              }
            });
          } else {
            // for other elements, recurse to capture structured content
            txt += getCleanText(child);
          }
        }
      });
      return txt;
    }

    function but_sdtb() {
      const scb = document.querySelector(sel_scrolbut);
      if (scb) {
        const { x, y, width, height, top, left } = scb.getBoundingClientRect();
        const gapFromBottom = window.innerHeight - (y + height);
        const q1 = window.innerHeight * 0.25;
        console.log(
          `⤵ scroll-scb pos → x=${x.toFixed(1)}, y=${y.toFixed(1)}, ` +
            `w=${width.toFixed(1)}, h=${height.toFixed(1)}, ` +
            `top=${top.toFixed(1)}, left=${left.toFixed(1)}`
        );
        scb.click();
        return true;
      }
      console.log("nahanah");
      return false;
    }

    function sendEU(cmd) {
      // Map command to payload -----------------------------
      let payload;
      switch (cmd) {
        case "play":
          payload = { playEU: true };
          break;
        case "stop":
          payload = { stopEU: true };
          euok = true;
          break;
        case "lp":
          if (euok) break;
          payload = { lpEU: true };
          break;
        case "ds":
          payload = { dsEU: true };
          break;
        default:
          console.warn("sendEU: unknown cmd ▶", cmd);
          return;
      }

      const body = JSON.stringify(payload);
      console.log("sendEU ▶", cmd, "body =", body);

      // POST to local TTS server ----------------------------
      GM_xmlhttpRequest({
        method: "POST",
        url: `http://localhost:${port}/speak`,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "text/plain",
        },
        data: body,
        onload(res) {
          if (res.status === 200) {
            console.log(`✅ sendEU(${cmd}) → 200 OK`);
          } else {
            console.error(
              `❌ sendEU(${cmd}) → ${res.status}`,
              res.statusText,
              res.responseText.trim()
            );
          }
        },
        onerror(err) {
          console.error("❌ sendEU network error", err);
        },
      });
    }

    // -------------------------------------------------------------------
    function watchBtnY(duration = 5000, every = 1000) {
      const scb = document.querySelector(sel_scrolbut);
      if (!scb) {
        console.warn("⚪ watchBtnPosition: button not found");
        return;
      }

      let last = scb.getBoundingClientRect();
      console.log(
        `📌 start   y=${last.y.toFixed(1)}, gap=${(
          window.innerHeight -
          (last.y + last.height)
        ).toFixed(1)}`
      );

      const id = setInterval(() => {
        const cur = scb.getBoundingClientt();
        const gap = window.innerHeight - (cur.y + cur.height);

        if (cur.y !== last.y || cur.height !== last.height) {
          console.log(
            `📍 change  y=${cur.y.toFixed(1)}, gap=${gap.toFixed(1)}`
          );
          last = cur;
        }
      }, every);

      setTimeout(() => {
        clearInterval(id);
        console.log("⏹️ watchBtnPosition done");
      }, duration);
    }
    // -------------------------------------------------------------------

    let lastKnownFullText = "";
    let wordBuf = ""; // holds partial‑word fragments until a full word is finished

    // ---- Global key event blocker ----
    // While active, this stops other scripts from seeing key events.
    let blockKeys = false;
    function keyBlocker(ev) {
      // Allow the “f” keyup that turns the block off to pass through.
      if (blockKeys && !(ev.key === "f" && ev.type === "keyup")) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
      }
    }
    // Capture‑phase listeners ensure we cancel events before anyone else.
    document.addEventListener("keydown", keyBlocker, true);
    document.addEventListener("keyup", keyBlocker, true);

    let detailObserver = null;
    let currentTargetNode = null;
    let listObserver = null;

    // -------------------------------------------------------------------
    // 1) Patch the history methods so we can detect in-app route changes
    //    (pushState, replaceState) and the popstate event
    // -------------------------------------------------------------------
    function onRouteChange() {
      console.log("🔁 Route changed → re-initializing observers...");
      // Disconnect old observer if any
      if (listObserver) {
        listObserver.disconnect();
        listObserver = null;
      }
      ts = T();
      h();
      // Give the DOM a moment to load new content
      setTimeout(startListObserver, 500);
    }

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const ret = originalPushState.apply(history, args);
      onRouteChange();
      return ret;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const ret = originalReplaceState.apply(history, args);
      onRouteChange();
      return ret;
    };

    window.addEventListener("popstate", onRouteChange);

    // -------------------------------------------------------------------
    // 2) DOM-finding utility
    // -------------------------------------------------------------------
    function findElement(selectors) {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          const firstTurn =
            element.closest("article")?.parentElement ||
            element.closest('[data-testid^="conversation-turn-"]')
              ?.parentElement ||
            element;
          console.log(
            `Using container found by selector: "${selector}", actual element:`,
            firstTurn
          );
          return firstTurn;
        }
      }
      console.warn(
        "Could not find chat list container using selectors:",
        sel_chatlist
      );
      return null;
    }

    // -------------------------------------------------------------------
    // 3) Observers for new messages + partial tokens
    // -------------------------------------------------------------------
    function processLatestMessage() {
      but_sdtb();
      const assistantMessages = document.querySelectorAll(
        '[data-message-author-role="assistant"]:not([class*="placeholder-request"])'
      );
      if (assistantMessages.length === 0) return;

      const latestAssistantMessage =
        assistantMessages[assistantMessages.length - 1];
      const targetNode = latestAssistantMessage.querySelector(sel_resp);

      if (!targetNode) return;
      const initialCleanText = getCleanText(targetNode).trim();
      console.log(
        "🔎 Initial detection: latestAssistantMessage element:",
        latestAssistantMessage
      );
      console.log(
        "🔎 Initial detection: targetNode (assistant content):",
        targetNode
      );
      // Skip the interim "thinking…" container; wait for the real reply
      if (targetNode && targetNode.classList.contains("result-thinking")) {
        console.log(
          "⏳ Placeholder thinking node detected, waiting for real content."
        );
        return;
      }

      if (targetNode !== currentTargetNode) {
        but_sdtb();
        console.log(
          "✅ New assistant message content node detected. Attaching detail observer. c:"
        );
        lastKnownFullText = "";
        if (detailObserver) {
          detailObserver.disconnect();
        }

        currentTargetNode = targetNode;
        // --- if the reply arrived fully‑rendered (no token stream), speak it now ---
        const initialText = initialCleanText;
        if (initialText && typeof GM_xmlhttpRequest === "function") {
          ttsend({
            text: initialText,
            flushQueue: true,
            onSuccess: () => {
              console.log("✅ flushQueue + initialText sent successfully");
              if (wordBuf.trim()) {
                ttsend({ text: wordBuf });
                wordBuf = "";
              }
              sendEU("stop");
            },
          });
          lastKnownFullText = initialCleanText;
        }
        // (partial tokens logic below)
        detailObserver = new MutationObserver(() => {
          const currentCleanText = getCleanText(currentTargetNode).trim();

          // Case 1 — text grew
          if (currentCleanText.length > lastKnownFullText.length) {
            const newPortion = currentCleanText.slice(lastKnownFullText.length);
            console.log("🟢 Partial tokens:", newPortion);

            if (newPortion) {
              // append chunk to rolling buffer
              wordBuf += newPortion;

              // look *backwards* for the last delimiter that marks a word boundary
              const boundaryRE = /[ \t\n\r\f\v.,;:!?]/;
              let cut = -1;
              for (let i = wordBuf.length - 1; i >= 0; i--) {
                if (boundaryRE.test(wordBuf[i])) {
                  cut = i;
                  break;
                }
              }

              // if we have at least one full word (i.e. we saw a delimiter)
              if (cut !== -1) {
                const complete = wordBuf.slice(0, cut + 1); // flush thru the delimiter
                wordBuf = wordBuf.slice(cut + 1); // keep the tail fragment
                if (complete.trim()) {
                  ttsend({ text: complete });
                }
              }
            }

            lastKnownFullText = currentCleanText;
            // if streaming appears to be finished, flush any trailing fragment
            if (
              currentCleanText.endsWith(".") ||
              currentCleanText.endsWith("!") ||
              currentCleanText.endsWith("?")
            ) {
              if (wordBuf.trim()) {
                ttsend({ text: wordBuf });
                wordBuf = "";
              }
            }
          }
          // Case 2 — editor rewrote text (rare but happens while streaming)
          else if (
            currentCleanText.length < lastKnownFullText.length &&
            lastKnownFullText !== ""
          ) {
            console.log("🔄 Text reset or changed significantly.");
            lastKnownFullText = currentCleanText;
          }
        });

        detailObserver.observe(currentTargetNode, {
          childList: true,
          subtree: true,
          //characterData: true,
          //attributes: true, //not add, it would break
        });

        lastKnownFullText = initialCleanText;
        if (lastKnownFullText) {
          console.log("🟢 Initial content:", lastKnownFullText);
        }
      }
    }

    function handleMutation(mutation) {
      if (mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches('[data-message-author-role="assistant"]') ||
              node.querySelector('[data-message-author-role="assistant"]'))
          ) {
            return true; // found a new assistant message
          }
        }
      }
      return false;
    }

    function startListObserver() {
      if (!sel_chatlist || sel_chatlist.length === 0) {
        console.error("❌ sel_chatlist is not defined or empty.");
        return;
      }
      const chatListContainer = findElement(sel_chatlist);
      if (chatListContainer && chatListContainer instanceof Node) {
        listObserver = new MutationObserver((mutations) => {
          let potentiallyNewMessage = false;
          for (const mutation of mutations) {
            if (handleMutation(mutation)) {
              potentiallyNewMessage = true;
            }
          }
          if (potentiallyNewMessage) {
            sendEU("play");
            console.log("List observer detected potential new message.");
            setTimeout(processLatestMessage, 150);
          }
        });

        listObserver.observe(chatListContainer, {
          childList: true,
          subtree: true,
        });
        console.log("✅ Chat list observer started on:", chatListContainer);
        setTimeout(processLatestMessage, 500);
      } else {
        waitc(() => {
          ts = T();
          h();
          console.warn("⏳ Waiting for chat list container... Retrying in 1s");
          setTimeout(startListObserver, 1000);
        });
      }
    }
    // ---- Manual observer reset helper (triggered by long‑press “r”) ----
    function reloadObservers() {
      if (detailObserver) {
        detailObserver.disconnect();
        detailObserver = null;
      }
      currentTargetNode = null;
      lastKnownFullText = "";

      processLatestMessage();
    }
    // Utility: wait until URL contains '/c/'
    function waitc(callback) {
      if (location.pathname.includes("/c/")) {
        callback();
      } else {
        console.log("⏳ Waiting for /c/ route...");
        const observer = new MutationObserver(() => {
          if (location.pathname.includes("/c/")) {
            console.log("📍 Detected /c/ route, starting logic.");
            observer.disconnect();
            callback();
          }
        });
        /// [debug] this should add a failb if load ealer use mutation obs wait for that
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }

    sendEU("lp");
    (async () => {
      while (true) {
        if (euok) break;
        sendEU("ds");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    let ts = {};
    const l = 40;
    const L = 650;
    let rDownTime = null;
    let pressTimerS = null;

    function s() {
      let pressTimer = null;
      let shown = false;

      document.addEventListener("keydown", (e) => {
        if (e.key === "f" && pressTimer === null) {
          pressTimer = setTimeout(() => {
            if (!shown) {
              document.execCommand("undo");
              blockKeys = true; // start blocking other key listeners
            }
            shown = true;
            ["a", "b", "c", "d"].forEach((id) =>
              g(id, "display", "flex", "important")
            );
          }, 200);
        }
        if (e.key === "r" && rDownTime === null) {
          rDownTime = performance.now();
          console.log(`r‑tap detected ( ${rDownTime.toFixed(0)} ms )`);
        }
        if (e.key === "S" && e.shiftKey && pressTimerS === null) {
          pressTimerS = setTimeout(() => {
            const label = stt === "a" ? "Dictate button" : "Submit dictation";
            const btn = document.querySelector(`button[aria-label="${label}"]`);
            if (btn) btn.click();
            stt = stt === "a" ? "b" : "a";
          }, 100);
        }
      });

      document.addEventListener("keyup", (e) => {
        if (e.key === "f") {
          // clear pending timer
          clearTimeout(pressTimer);
          pressTimer = null;

          // if elements were shown, hide them now
          if (shown) {
            ["a", "b", "c", "d"].forEach((id) =>
              g(id, "display", "none", "important")
            );
            blockKeys = false; // stop blocking; re‑enable other key listeners
            shown = false;
          }
        }
        if (e.key === "r") {
          const duration = performance.now() - (rDownTime ?? 0);
          if (duration <= 50) {
            reloadObservers();
          }
          rDownTime = null;
        }
        if (e.key === "S" || e.shiftKey) {
          clearTimeout(pressTimerS);
          pressTimerS = null;
        }
      });

      document.addEventListener("mousemove", (e) => {
        if (!shown) {
          const y = e.clientY;
          //more sug to use f hotkey to show, delete didnot none so juterfy like this for now
          g("a", "display", y < l ? "none" : "none", "important");
          g("b", "display", y < l ? "none" : "none", "important");
          /*const Ł = y > L;
        g("b", "display", Ł ? "flex" : "none", "important");
        g("c", "display", Ł ? "flex" : "none", "important");*/
        }
      });
    }

    function g(target, prop, val, important) {
      // When a key string is passed, dereference inside ts first.
      const nodeOrList = typeof target === "string" ? ts[target] : target;

      if (!nodeOrList) return;

      // Apply style to one or many elements transparently.
      if (nodeOrList instanceof NodeList || Array.isArray(nodeOrList)) {
        nodeOrList.forEach((el) =>
          el?.style?.setProperty(prop, val, important)
        );
      } else {
        nodeOrList.style.setProperty(prop, val, important);
      }
    }

    function h() {
      waitc(() => {
        g("all", "display", "none", "important");
        if (!ts.all) {
          ts = T();
          g("all", "display", "none", "important");
        }
      });
    }

    function T() {
      const selectors = `
      #page-header,
      form[data-type="unified-composer"] .flex-auto.flex-col>div[style*="height:48px"],
      .bg-primary-surface-primary,
      #stage-slideover-sidebar,
      #thread-bottom-container .text-token-text-secondary
    `;
      const [a, b, c, d, e] = document.querySelectorAll(selectors);
      return { a, b, c, d, e, all: document.querySelectorAll(selectors) };
    }

    waitc(() => {
      ts = T();
      setTimeout(startListObserver, 1000);
      s();
      h();
    });

    //vh wide css
    insCss(`/* force that div taller */
div.grow.overflow-y-auto {
  min-height: 680px !important;
//  margin: auto !important;
}
/* force a thinner cut */
body,
[data-message-author-role="assistant"],
[data-message-author-role="user"] {
  /* try the light/thin PostScript name first */
  font-weight: 300 !important;    /* very light */
}

/* very important to remove the botom padding. Remove bottom margin from the composer's wrapper */
main div.isolate.w-full.basis-auto.mb-4 {
    margin-bottom: 0 !important;
}
main div.sticky.top-0.max-md\:hidden.h-header-height {
  /* Hide the elements completely */
  display: none !important;
}
div.isolate.w-full.basis-auto.flex.flex-col {
  padding: 0 !important;
}
div.text-base.mx-auto {
  padding-left: 0 !important;
  padding-right: 0 !important;
  --thread-content-margin: 0px !important;
}
div[class*="@thread-xl"] {
  margin-top: 0 !important;
  padding-bottom: 0 !important;
}

/* 1. Target the container setting the overall width and margin */
/* Overrides pl-2 (padding-left) */
div[style*="max-width: 100%"] {
  padding: 0 !important;
  /* Optionally remove the horizontal padding variable if needed, though mx-auto centers it */
  /* padding-right: 0 !important; */
}

/* 2. Target the inner container holding the input grid and buttons */


/* 3. Target the container specifically around the input field */
/* Overrides ps-2 pt-0.5 (padding-start, padding-top) */
form[data-type="unified-composer"] div[class*="ps-2 pt-0.5"] {
  padding: 0 !important;
}

/* 4. Target the main container div holding the ProseMirror editor */
/* Overrides pe-3 (padding-end) */
._prosemirror-parent_1e8bb_2 {
  padding: 0 !important;
  /* Optional: Override min-height if it causes unwanted space */
  /* min-height: auto !important; */
}

/* 5. Target the hidden textarea */
/* Overrides py-2 (padding-top/bottom) */
._prosemirror-parent_1e8bb_2 textarea {
  padding: 0 !important;
  /* Ensure height doesn't add space if it becomes visible */
  height: auto !important;
  min-height: 0 !important;
}

/* 6. Target the actual contenteditable input area (ProseMirror div) */
/* Remove any default or library-added padding/margin */
#prompt-textarea {
  padding: 0 !important;
  margin: 0 !important;
  /* Ensure it can shrink vertically if needed */
   min-height: 0 !important;
}

/* 7. Target the paragraph element often used inside the input area */
/* Remove default browser margins for paragraphs */
#prompt-textarea p {
  margin: 0 !important;
  padding: 0 !important;
}

/* 8. Target the grid container holding the input area */
/* Overrides ms-1.5 (margin-start) */
form[data-type="unified-composer"] div[class*="ms-1.5 grid"] {
  margin: 0 !important; /* Use margin: 0 to reset all margins */
}

/* 9. Target the container for potential elements after the input grid */
/* Overrides ms-2 (margin-start) */
form[data-type="unified-composer"] div[class*="ms-2 flex"] {
  margin: 0 !important; /* Use margin: 0 to reset all margins */
}

/* 10. Optional: Adjust absolute positioned buttons container */
/* If removing padding makes buttons overlap or look wrong, adjust their position. */
/* Example: Resetting left offset */
/*
.bg-primary-surface-primary.absolute.right-0.bottom-\[9px\].left-\[17px\] {
    left: 0 !important;
    bottom: 0 !important; /* Maybe adjust bottom too */
/* } */
/* Target any element whose class contains "prosemirror-parent_" */
div[class*="prosemirror-parent_"] {
  padding: 0 !important;
  margin: 0 !important;
  box-sizing: border-box !important;
  padding-inline-end: 0 !important; /* removes right-side padding from pe-3 */
  padding-right: 0 !important;       /* extra safety */
}

/* Target the actual contenteditable input area (ProseMirror div) */
/* Remove any default or library-added padding/margin */
#prompt-textarea {
  padding: 0 !important;
  margin: 0 !important;
}

/* Target the paragraph element often used inside the input area */
/* Remove default browser margins for paragraphs */
#prompt-textarea p {
  margin: 0 !important;
  padding: 0 !important; /* Less likely needed, but safe */
}
div[class^="prosemirror-parent"] .ProseMirror,
div[class^="prosemirror-parent"] .ProseMirror * {
  padding: 0 !important;
  margin: 0 !important;
  border: none !important;
}
/* 1. Target the direct container holding the input area and buttons */
/* This div has px-3 py-3 which creates the main internal padding */
form[data-type="unified-composer"] > div > div.relative.flex.w-full.items-end {
  padding: 0!important;
}


/* 2. Target the container specifically around the input field */
/* This div has ps-2 pt-0.5 (padding-start, padding-top) */
form[data-type="unified-composer"] div.relative.flex-auto.bg-transparent {
  padding: 0 !important;
}

/*very improtant*/
#prompt-textarea {
  padding: 9.1px !important;
}

/* 4. Target the hidden textarea (might still influence layout slightly) */
/* It has py-2 (padding-top/bottom) */
form[data-type="unified-composer"] textarea[placeholder="Ask anything"] {
  padding: 0 !important;
}

/* 5. Target the grid container holding the input area */
/* It has ms-1.5 (margin-start) */
form[data-type="unified-composer"] div[class*="ms-1.5 grid"] {
  margin: 0 !important;
}

/* 6. Target the container for potential elements after the input grid */
/* It has ms-2 (margin-start) */
form[data-type="unified-composer"] div[class*="ms-2 flex"] {
  margin: 0 !important;
}

/* 7. Optional: Adjust the absolute positioned buttons container if needed */
/* Removing padding might make these overlap; this resets its position slightly */
/*
form[data-type="unified-composer"] .absolute.right-3.bottom-0 {
    right: 0 !important;
    bottom: 0 !important;
}
*/
/* Target the container around the typing area */
.prosemirror-parent, /* If there's a class for that container */
.prose { /* Or a more general prose container */
  padding: 0 !important;
  margin: 0 !important;
  border: none !important;
}

    /*Target the actual surrounding bar*/
.bg-token-main-surface-primary{
    padding: 0 !important;
    margin: 0 !important;
    border: none !important;
}
.bg-clip-padding{
     padding: 0 !important;
    margin: 0 !important;
    border: none !important;
}
.px-3 {
    padding-left: 0 !important;
    padding-right: 0 !important;
}
.py-3{
    padding-top: 4px !important;
    padding-bottom: 6px !important;
}
/*this owuld impect to something not needed*/
/*Extra precaution and get to the children*/

.absolute > * {
    padding: 0 !important;
    margin: 0 !important;
    border: none !important;
}
/* Optional: Kill vertical gaps from container tokens */
div[class*="text-primary"] > div {
  margin: 0 !important;
  padding: 0 !important;
}


div.text-base.my-auto.mx-auto.py-5 {
  padding-left: 1px !important;
  padding-right: 0 !important;
}
/* Main content container */
main.relative.h-full.w-full.flex-1 {
  padding: 0 !important;
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
}

/* Conversation turn block */
div[class*="conversation-turn"].relative.flex.w-full.min-w-0.flex-col {
  padding-left: 0px !important;
  padding-right: 0px !important;
}

/* Inside message: user + assistant full zero padding */
[data-message-author-role="user"] *,
[data-message-author-role="assistant"] * {
//  padding: 0 !important;
}

/* Remove padding from markdown wrapper */
article div.text-base.mx-auto.px-6 {
  padding-left: 0px !important;
  padding-right: 0px !important;
}

/* Max width unlock for bubble containers */
[data-message-author-role="user"] div[class*="max-w-"],
[data-message-author-role="user"] .relative.max-w-\[var\(--user-chat-width\,70\%\)\],
[data-message-author-role="user"] .whitespace-pre-wrap {
  width: 100% !important; /* currently not working but in arc but would work with 'boost' */
  max-width: none !important;
  text-align: right !important;
  box-sizing: border-box !important;
}
/* Keep the global resets you already have */

[data-message-author-role="user"] .relative.max-w-\[var\(--user-chat-width\,70\%\)\] {
  border: 0.01px solid rgb(151, 148, 148) !important; /* currently doesn't work but in arc would work with 'boost' */
  border-radius: 15px !important;
}
[data-message-author-role="user"] .relative {
  display: inline-block !important;
  max-width: 90% !important;       /* keep some edge space */
  padding: 5px 5px !important;   /* smooth inner air */
  margin: 6px 0 !important;
  background-color: #1a1a1a !important; /* dark bubble (for dark mode) */

}
* {
  line-height: 1.275 !important;
}
body {
/*font-stretch: condensed !important;  
margin-block-start: 0 !important; Remove space before blocks */
}
//start of credit to open source extension wide gpt
@media (min-width: 1280px) {
            .xl\\:max-w-\\[48rem\\],
            .xl\\:px-5 {
                max-width: 100% !important;
                padding-left: 1.25rem;
                padding-right: 1.25rem;
            }
        }

        @media (min-width: 768px) {
            .md\\:max-w-3xl {
                max-width: 100% !important;
            }
        }

        @container (width >= 64rem) {
            .\\@\\[64rem\\]\\:\\[--thread-content-max-width\\:48rem\\] {
                --thread-content-max-width: 100% !important;
            }
        }

        @container (width >= 34rem) {
            .\\@\\[34rem\\]\\:\\[--thread-content-max-width\\:40rem\\] {
                --thread-content-max-width: 100% !important;
            }
        }

        /* Extra: override fallback static styles if exist */
        [style*="max-width"] {
            max-width: 100% !important;
        } 
//end credit to open source extension wide gpt
`);
  }


  if (host === "gemini.google.com") {
    insCss(`/* === General Layout Widening === */

/* Make the main application container take full width */
chat-app,
body,
html {
  width: 100% !important;
  max-width: none !important;
}

/* Target the container holding sidebar AND content */
mat-sidenav-container.mat-drawer-container {
  width: 100% !important;
}

/* Target the main content area NEXT TO the sidebar */
mat-sidenav-content.mat-drawer-content {
  width: 100% !important; /* Allow content area to take available width */
  margin-left: 0 !important; /* Override default margin when sidebar is closed */
  margin-right: 0 !important;
  padding-inline: 0px !important; /* Add some padding back for breathing room */
  box-sizing: border-box; /* Include padding in width calculation */
}

/* Ensure the chat window itself fills the content area */
chat-window[_nghost-ng-c1777261061] {
  width: 100% !important;
}

/* Adjust the chat history container padding */
chat-window-content .chat-history {
  padding-inline: 0px !important; /* Keep this 0 if you want edge-to-edge content */
  /* or use 16px for some spacing: padding-inline: 16px !important; */
}


/* === Central Content Widening (Keep previous rules) === */

/* Target the main chat conversation area */
.conversation-container {
  max-width: 1400px !important; /* Increased further, adjust as needed */
}

/* Target the input area container at the bottom */
input-container {
   max-width: 1400px !important; /* Match the conversation width */
   padding-inline: 0px !important; /* Keep this 0 if you want edge-to-edge input */
   /* or use 16px: padding-inline: 16px !important; */
}

/* Target the initial "zero state" screen container */
.zero-state-container {
   max-width: 1400px !important; /* Match the conversation width */
 }

/* Ensure the container *within* input-container fills it */
.input-area-container {
   max-width: 100% !important;
}


/* === User Prompt Widening === */

/* Target the specific container for the user prompt bubble's background/layout */
user-query .user-query-bubble-with-background {
  max-width: none !important; /* Remove the max-width restriction */
  width: 100% !important;     /* Allow it to take full available width */
  box-sizing: border-box; /* Include padding/border in the width */
}

/* Ensure the parent container allows full width */
user-query .query-content {
  width: 100% !important;
}

/* === Optional: Adjust Immersive Mode === */
.immersives-mode[_nghost-ng-c1777261061]:not(.mobile-device) {
    max-width: 100% !important; /* Adjust as needed, e.g., 1800px, none */
    margin: 0 auto !important; /* Center it if not 100% width */
}

/* === Your Line Height Rule (Keep it) === */
.markdown p, .markdown li {
  line-height: 1.5 !important;
}

/* === Sidebar Adjustments (Optional - might break things) === */
/* Hide the collapsed sidebar visually and remove its width influence */
/* Use with caution, might hide the toggle button */
/*
bard-sidenav-container mat-sidenav.mat-drawer-closed {
  width: 0 !important;
  min-width: 0 !important;
  visibility: hidden !important;
  border: none !important;
}
*/
`);
  }

  if (host === "mistral.ai") {
    insCss(`
    .max-w-3xl {
        max-width: 200ch;
    }
    .max-w-\[75ch\] {
        max-width: 200ch;
    }
`);
  }
  if (host === "claude.ai") {
    insCss(`
    .max-w-3xl {
        max-width: 200ch;
    }
    .max-w-[75ch] {
        max-width: 200ch;
    }
`);
  }
})();
