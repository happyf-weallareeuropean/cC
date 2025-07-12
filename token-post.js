// ==UserScript==
// @name         cC~ (Jul 10, 2025)
// @homepageURL  https://github.com/happyf-weallareeuropean/cC
// @namespace    https://github.com/happyf-weallareeuropean
// @version      cacf-ae-bh
// @author       happyf-weallareeuropean
// @description  close ur eyes or open ur eyes all better for eyes
// @updateURL    https://raw.githubusercontent.com/happyf-weallareeuropean/cC/main/token-post.js
// @match     *://chatgpt.com/*
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
  // dom way
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
        console.log(`📍 change  y=${cur.y.toFixed(1)}, gap=${gap.toFixed(1)}`);
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
    let now = Date.now();
    while (true) {
      if (euok) break;
      if (Date.now() - now >= 1000) break;
      sendEU("ds");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      now = Date.now();
    }
  })();
  let ts = {};
  const l = 40;
  const L = 650;

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
    });

    // Quick‑tap “r” (≤ 65 ms) → fully reload observers
    let rDownTime = null;

    document.addEventListener("keydown", (e) => {
      if (e.key === "r" && rDownTime === null) {
        rDownTime = performance.now();
        console.log(`r‑tap detected ( ${rDownTime.toFixed(0)} ms )`);
      }
    });

    document.addEventListener("keyup", (e) => {
      if (e.key === "r") {
        const duration = performance.now() - (rDownTime ?? 0);
        if (duration <= 65) {
          console.log(
            `Reloading observers on r‑tap ( ${duration.toFixed(0)} ms )`
          );
          reloadObservers();
        }
        rDownTime = null;
      }
    });

    let stt = "a";
    let pressTimerS = null;

    document.addEventListener("keydown", (e) => {
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
      nodeOrList.forEach((el) => el?.style?.setProperty(prop, val, important));
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
})();
