// ==UserScript==
// @name         Force Dark Background EARLY v4 - Diagnostic & Multi-Approach
// @match        *://*/*
// @exclude      *://chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_log
// @version      1.4
// @author       You
// @description  Attempts multiple methods (CSS, class, attribute) VERY early to force dark background and adds detailed logging. Add exclusions for broken sites.
// @run-at       document-start
// @namespace    http://tampermonkey.net/
// ==/UserScript==

(function() {
    'use strict';
    const startTime = performance.now();
    let runCount = (window.forceDarkRunCount || 0) + 1;
    window.forceDarkRunCount = runCount; // Track if script runs multiple times in one load

    // --- Configuration ---
    const DARK_BACKGROUND = '#1a1a1a'; // Dark grey
    const DARK_TEXT = '#e0e0e0';       // Light grey
    const CLASS_TO_ADD = 'dark';       // Common dark mode class
    const ATTR_TO_SET = 'data-theme';  // Common theme attribute
    const ATTR_VALUE = 'dark';
    const MARKER_ATTR = 'data-dark-override-applied-v4'; // Prevents re-running logic
    // --- End Configuration ---

    // Enhanced logging
    const log = (message) => {
        const elapsed = (performance.now() - startTime).toFixed(2);
        GM_log(`[Force Dark v4 #${runCount} | ${elapsed}ms] ${message}`);
        // console.log(`[Force Dark v4 #${runCount} | ${elapsed}ms] ${message}`); // Optional: also log to browser console
    };

    log(`Script start for ${location.href}`);

    // Check if we've already run this logic on this documentElement
    if (document.documentElement && document.documentElement.hasAttribute(MARKER_ATTR)) {
        log("Already applied in this document load. Exiting.");
        return;
    }

    // --- Define the CSS to Inject ---
    // Use html:not([marker]) to ensure it only applies once before the marker is set
    const css = `
       Attempt 1: Use color-scheme hint and force basic colors */
       /* Attempt 1: Use color-scheme hint and force basic colors */
      html:not([${MARKER_ATTR}="true"]) {
        color-scheme: dark !important;
        background-color: ${DARK_BACKGROUND} !important;
        color: ${DARK_TEXT} !important;
      }
      /* Attempt 2: Also try forcing body background early */
      body:not([data-dark-override-applied-v4-body="true"]) {
          background-color: ${DARK_BACKGROUND} !important;
      }
    `;

    // --- Function to apply modifications ---
    const applyDarkModeEarly = () => {
        log("Attempting to apply dark mode styles/attributes...");

        if (!document.documentElement) {
            log("documentElement not ready yet. Retrying...");
            requestAnimationFrame(applyDarkModeEarly);
            return;
        }

        // Check marker one last time before applying
        if (document.documentElement.hasAttribute(MARKER_ATTR)) {
            log("Already applied (checked before modification). Exiting apply function.");
            return;
        }

        let appliedSomething = false;

        // 1. Inject CSS using GM_addStyle (often more reliable at document-start)
        try {
            GM_addStyle(css);
            log("GM_addStyle executed.");
            appliedSomething = true;
        } catch (e) {
            log(`Error using GM_addStyle: ${e}. Falling back to manual injection.`);
            // Fallback: Manual style injection (like previous script)
            try {
                const style = document.createElement('style');
                style.id = 'userscript-force-dark-early-style-v4';
                style.textContent = css;
                if (!document.getElementById(style.id)) {
                    if (document.head) {
                        document.head.insertBefore(style, document.head.firstChild);
                    } else {
                        document.documentElement.appendChild(style); // Append directly to html if head not ready
                    }
                    log("Manual style injection fallback successful.");
                    appliedSomething = true;
                } else {
                     log("Manual style injection fallback: Style element already exists.");
                }
            } catch (e2) {
                log(`Error during manual style injection fallback: ${e2}`);
            }
        }

        // 2. Try adding the class
        try {
            document.documentElement.classList.add(CLASS_TO_ADD);
            log(`Attempted to add class '${CLASS_TO_ADD}' to <html>.`);
            appliedSomething = true;
        } catch (e) {
            log(`Error adding class: ${e}`);
        }

        // 3. Try setting the data attribute
        try {
            document.documentElement.setAttribute(ATTR_TO_SET, ATTR_VALUE);
            log(`Attempted to set attribute '${ATTR_TO_SET}="${ATTR_VALUE}"' on <html>.`);
            appliedSomething = true;
        } catch (e) {
            log(`Error setting attribute: ${e}`);
        }

        // 4. Set the marker attribute ONCE
        if (appliedSomething) {
             document.documentElement.setAttribute(MARKER_ATTR, 'true');
             log(`Set marker attribute [${MARKER_ATTR}="true"] on <html>.`);
        } else {
             log("Failed to apply any modifications.");
        }

        // 5. Diagnostic Log: Check the state immediately after modifications
        log("Checking state immediately after modifications:");
        log(` - <html> classList: ${document.documentElement.classList}`);
        log(` - <html> ${ATTR_TO_SET}: ${document.documentElement.getAttribute(ATTR_TO_SET)}`);
        const styles = window.getComputedStyle(document.documentElement);
        log(` - <html> computed background-color: ${styles.backgroundColor}`);
        log(` - <html> computed color: ${styles.color}`);
        log(` - <html> computed color-scheme: ${styles.colorScheme}`);
        if (document.head) {
           log(` - Style injected by GM? (Check Tampermonkey log/presence in head)`);
           log(` - Manual style exists? ${!!document.getElementById('userscript-force-dark-early-style-v4')}`);
        } else {
           log(` - document.head not available yet for style check.`);
        }
    };

    // --- Execute ---
    // Use requestAnimationFrame to ensure documentElement is likely available,
    // but it still runs extremely early.
    requestAnimationFrame(applyDarkModeEarly);

    // Also listen for DOMContentLoaded as a final check/log, although it's too late to prevent the flash.
    document.addEventListener('DOMContentLoaded', () => {
       log("DOMContentLoaded event fired.");
       if (!document.documentElement.hasAttribute(MARKER_ATTR)) {
           log("Marker attribute was NOT present at DOMContentLoaded. Script might have failed early.");
       } else {
           log("Marker attribute WAS present at DOMContentLoaded.");
           // Re-check styles just in case they got overridden later
           const styles = window.getComputedStyle(document.documentElement);
           log(` - DOMContentLoaded check: computed background-color: ${styles.backgroundColor}`);
           log(` - DOMContentLoaded check: computed color-scheme: ${styles.colorScheme}`);
           log(` - DOMContentLoaded check: <html> classList: ${document.documentElement.classList}`);
           log(` - DOMContentLoaded check: <html> ${ATTR_TO_SET}: ${document.documentElement.getAttribute(ATTR_TO_SET)}`);
       }
    }, { once: true, capture: true });


})();
