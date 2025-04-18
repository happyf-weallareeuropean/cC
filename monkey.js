// ==UserScript==
// @name         close eyes chating v.1b (aloud inticial n path suplemental)
// @homepageURL  https://github.com/happyf-weallareeuropean/close-eyes-chat-gpt
// @namespace    https://github.com/happyf-weallareeuropean
// @version      cacf-ae-bh
// @author       happyfweallareeuropean
// @description  try to take over the world! during closed ur eyes, no setInterval
// @match        *://chatgpt.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=chatgpt.com
// @connect      localhost
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(() => {
  const CONTENT_SELECTOR_INSIDE_ASSISTANT = 'div.markdown.prose';

  const CHAT_LIST_CONTAINER_SELECTORS = [
    'main .group\\/thread .group\\/conversation-turn',
    'main .flex.flex-col.text-sm',
    '.stretch.mx-auto.flex.w-full .flex-col.text-sm'
  ];

  let lastKnownFullText = "";
  let detailObserver = null;
  let currentTargetNode = null;
  let listObserver = null;
 let hasSentFlushSignal = false;

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
    // Give the DOM a moment to load new content
    setTimeout(startListObserver, 500);
  }

  const originalPushState = history.pushState;
  history.pushState = function(...args) {
    const ret = originalPushState.apply(history, args);
    onRouteChange();
    return ret;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function(...args) {
    const ret = originalReplaceState.apply(history, args);
    onRouteChange();
    return ret;
  };

  window.addEventListener('popstate', onRouteChange);

  // -------------------------------------------------------------------
  // 2) DOM-finding utility
  // -------------------------------------------------------------------
  function findElement(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const firstTurn = element.closest('article')?.parentElement
          || element.closest('[data-testid^="conversation-turn-"]')?.parentElement
          || element;
        console.log(`Using container found by selector: "${selector}", actual element:`, firstTurn);
        return firstTurn;
      }
    }
    console.warn("Could not find chat list container using selectors:", CHAT_LIST_CONTAINER_SELECTORS);
    return null;
  }

  // -------------------------------------------------------------------
  // 3) Observers for new messages + partial tokens
  // -------------------------------------------------------------------
  function processLatestMessage() {
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length === 0) return;

    const latestAssistantMessage = assistantMessages[assistantMessages.length - 1];
    const targetNode = latestAssistantMessage.querySelector(CONTENT_SELECTOR_INSIDE_ASSISTANT);
      console.log("🔎 Initial detection: latestAssistantMessage element:", latestAssistantMessage);
      console.log("🔎 Initial detection: targetNode (assistant content):", targetNode);
      // Skip the interim “thinking…” container; wait for the real reply
      if (targetNode && targetNode.classList.contains('result-thinking')) {
        console.log('⏳ Placeholder thinking node detected, waiting for real content.');
        return;
      }
    if (!targetNode) return;

    if (targetNode !== currentTargetNode) {
      console.log("✅ New assistant message content node detected. Attaching detail observer.");
      lastKnownFullText = "";
      if (detailObserver) {
        detailObserver.disconnect();
      }

      currentTargetNode = targetNode;
      // --- if the reply arrived fully‑rendered (no token stream), speak it now ---
      const initialText = currentTargetNode.innerText.trim();
      if (initialText && typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: "POST",
          url: "http://localhost:8080/speak",
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ flushQueue: true, text: initialText }),
    onload(response) {
      if (response.status === 200) {
        console.log("✅ flushQueue + initialText sent successfully");
      } else {
        console.error(
          "❌ flushQueue+initialText failed:",
          response.status,
          response.statusText,
          response.responseText
        );
      }
    },
    onerror(err) {
      console.error("❌ Error sending flushQueue+initialText:", err);
    }
  });
        lastKnownFullText = currentTargetNode.innerText; // keep observer in sync
      }
          detailObserver = new MutationObserver(() => {
        const currentFullText = currentTargetNode.innerText;
        if (currentFullText.length > lastKnownFullText.length) {
          const newPortion = currentFullText.slice(lastKnownFullText.length);
          console.log("🟢 Partial tokens:", newPortion);

          if (newPortion.trim() && typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
              method: "POST",
              url: "http://localhost:8080/speak",
              headers: { "Content-Type": "application/json" },
              data: JSON.stringify({ text: newPortion }),
              onload: function(response) {
                if (response.status !== 200) {
                  console.error(
                    'Speak request failed (GM):',
                    response.status,
                    response.statusText,
                    response.responseText
                  );
                }
              },
              onerror: function(response) {
                console.error('Error sending speak request (GM):', response.statusText, response.error);
              }
            });
          }
          lastKnownFullText = currentFullText;
        } else if (currentFullText.length < lastKnownFullText.length && lastKnownFullText !== "") {
          console.log("🔄 Text reset or changed significantly.");
          lastKnownFullText = currentFullText;
          if (currentFullText) {
            console.log("🟢 Reset to:", currentFullText);
          }
        }
      });

      detailObserver.observe(currentTargetNode, {
        childList: true,
        subtree: true,
        characterData: true
      });

      lastKnownFullText = currentTargetNode.innerText;
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
    const chatListContainer = findElement(CHAT_LIST_CONTAINER_SELECTORS);
    if (chatListContainer && chatListContainer instanceof Node) {
      listObserver = new MutationObserver((mutations) => {
        let potentiallyNewMessage = false;
        for (const mutation of mutations) {
          if (handleMutation(mutation)) {
            potentiallyNewMessage = true;
          }
        }
        if (potentiallyNewMessage) {
          console.log("List observer detected potential new message.");
          setTimeout(processLatestMessage, 150);
        }
      });

      listObserver.observe(chatListContainer, { childList: true, subtree: true });
      console.log("✅ Chat list observer started on:", chatListContainer);
      setTimeout(processLatestMessage, 500);
    } else {
      console.warn("⏳ Waiting for chat list container... Retrying in 4s");
      setTimeout(startListObserver, 4000);
    }
  }

  // Run the observer logic once the page loads.
  // On route changes, `onRouteChange()` is called again for a fresh attach.
  setTimeout(startListObserver, 2000);
})();
