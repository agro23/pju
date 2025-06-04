// content.js v5.55
// Integrated with structured text extraction and refined hybrid capture

// --- DOM Selectors ---
const TEXT_INPUT_SELECTOR = 'div.ql-editor[aria-label="Enter a prompt here"]';
const INPUT_BUTTONS_WRAPPER_SELECTOR = '.input-buttons-wrapper-bottom';
const MIC_BUTTON_CONTAINER_SELECTOR = '.mic-button-container';
const SEND_BUTTON_CONTAINER_SELECTOR = '.send-button-container';
// const ICON_INSIDE_SEND_BUTTON_CONTAINER_SELECTOR = `${SEND_BUTTON_CONTAINER_SELECTOR} mat-icon`; // Not directly used in new logic

// const CHAT_HISTORY_SCROLLER_SELECTOR = 'div#chat-history infinite-scroller.chat-history'; // Used in initializeObservers
const CHAT_CONTAINER_SELECTOR = 'div.chat-container'; // More general, often where messages are appended directly or within a scroller


// --- Fonticon Values ---
// const FONTICON_VALUE_SEND = 'send'; // Not directly used in new logic
// const FONTICON_VALUE_MIC = 'mic'; // Not directly used in new logic
const FONTICON_VALUE_STOP = 'stop';

// --- State Variables ---
let assistantWasGeneratingWithStopIcon = false;
let initialDOMScanComplete = false;
// let lastUserMessageLogged = ""; // Superseded by DOM ID check for Gemini
// let lastAssistantMessageLogged = ""; // Superseded by DOM ID check for Gemini

let assistantRecentlyFinished = false;
let assistantRecentlyFinishedTimeout = null;

let processedGeminiDomIdsInCurrentConversation = new Set();
let currentConversationIdForContentScript = null; // Updated by background.js
let latestPendingAssistantMessage = {
    id: null,       // DOM ID of the detected assistant message container
    element: null,  // Reference to the DOM element
    logged: false,  // Has this pending message been processed for logging?
    rawSourceDetails: null // To store {dom_id, selector_used}
};

/**
 * Checks if the main chat area of the LLM page is "fresh"
 * (i.e., contains no significant prior user/assistant messages).
 * This is a heuristic and might need adjustment per LLM platform.
 * @returns {boolean} True if the chat area appears fresh, false otherwise.
 */
function checkIfChatAreaIsFresh() {
    // Selector for the main chat history/container.
    // For Gemini, existing messages are usually within 'div[id^="model-response-message-contentr_"]'
    // or 'div.query-content[id^="user-query-content-"]'.
    // We're looking for the absence of these, or a very low count of nodes in the scroller.
    const chatHistoryElement = document.querySelector(CHAT_CONTAINER_SELECTOR) || document.querySelector('div#chat-history infinite-scroller.chat-history');

    if (!chatHistoryElement) {
        console.warn("[content.js] checkIfChatAreaIsFresh: Chat history element not found. Assuming not fresh for safety, but this needs monitoring.");
        return false; // If we can't find it, can't determine freshness.
    }

    // Heuristic: Check for the presence of known user or assistant message elements.
    // These selectors are from your chatHistoryObserverCallback.
    const hasUserMessages = !!chatHistoryElement.querySelector('div.query-content[id^="user-query-content-"]');
    const hasAssistantMessages = !!chatHistoryElement.querySelector('div[id^="model-response-message-contentr_"]');

    if (hasUserMessages || hasAssistantMessages) {
        console.log("[content.js] checkIfChatAreaIsFresh: Found existing user or assistant messages. Page is NOT fresh.");
        return false; // Found prior exchanges
    }

    // As an additional check, sometimes LLMs have placeholder messages.
    // For a truly fresh page, the number of direct children in some scrollers might be very low (e.g., 0 or 1 placeholder).
    // This part is more platform-specific and might need refinement.
    // For Gemini, the initial state before any chat is quite empty in the relevant containers.

    console.log("[content.js] checkIfChatAreaIsFresh: No existing user/assistant messages detected. Page appears FRESH.");
    return true;
}


// --- Helper Function: Extract Structured Content ---
function extractStructuredContent(element) {
    if (!element) {
        return { plainText: "", htmlContent: "" };
    }

    const htmlContent = element.innerHTML; // Get the raw HTML content
    let plainText = "";

    function getTextNodes(node) {
        let childText = "";
        if (node.nodeType === Node.TEXT_NODE) {
            childText += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            if (tagName === 'br') {
                childText += '\n';
            } else if (tagName === 'p' || tagName === 'div' && (node.style.display === '' || node.style.display === 'block')) {
                if (childText.length > 0 && !/\n\s*$/.test(childText)) {
                    childText += '\n';
                }
                for (const childNode of Array.from(node.childNodes)) {
                    childText += getTextNodes(childNode); // Recurse
                }
                if (childText.length > 0 && !childText.endsWith('\n')) {
                    childText += '\n';
                }
            } else { // Inline elements or unknown, just grab their text recursively
                for (const childNode of Array.from(node.childNodes)) {
                    childText += getTextNodes(childNode);
                }
            }
        }
        return childText;
    }

    plainText = getTextNodes(element);

    // Normalize multiple newlines and trim leading/trailing overall whitespace.
    // Ensure leading/trailing newlines from blocks are mostly preserved before final trim.
    plainText = plainText.replace(/\n\s*\n/g, '\n');
    // Trim only leading/trailing whitespace from the entire string, not internal newlines
    plainText = plainText.replace(/^\s+|\s+$/g, '');


    return { plainText: plainText, htmlContent: htmlContent };
}


// --- Logging Function ---
function logMessage(role, plainText, htmlContent, rawSourceDetails = null) {

    // Check if chrome.runtime is even available
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.error('[content.js] logMessage: chrome.runtime.sendMessage is not available. Skipping message send. Role:', role, 'Text:', plainText.substring(0, 50));
        return false;
    }

    // CAN WE CHECK THE EXTENSION CONTEXT STATE HERE???

    const platform = 'gemini-chat-interface';

    if (!plainText || plainText.trim().length < 1) { // Check plainText now
        // console.log(`[content.js] logMessage: plainText too short or empty for ${role}. Skipping.`);
        return false;
    }

    const actualPlainText = plainText.trim(); // Should already be trimmed by extractStructuredContent

    // DOM ID based deduplication now happens in chatHistoryObserverCallback before calling this.
    // Old content-based deduplication (lastUserMessageLogged, etc.) is removed for Gemini.

    console.log(`[content.js] Preparing to send 'new_chat_turn' for ${role}. DOM ID: ${rawSourceDetails?.dom_id || 'N/A'}. PlainText Snippet: "${actualPlainText.substring(0, 70).replace(/\n/g, " ")}..."`);

    const commands = detectCommandsInText(role, actualPlainText); // Operate on plainText

    const payload = {
        type: 'new_chat_turn',
        role: role,
        platform: platform,
        fullText: actualPlainText,      // This is the plainText with newlines
        htmlContent: htmlContent,       // The rich HTML content
        detectedCommands: commands,
        raw_source_details: rawSourceDetails,
        model_approx: null, // TODO: Try to determine this from the page if possible
        timestamp_assistant_response_start: (role === 'assistant') ? assistantMessageStartTime : null // See below
    };
    // For timestamp_assistant_response_start, we might need another state variable
    // let assistantMessageStartTime = null; // Set when assistant STARTS, cleared when FINISHES

    chrome.runtime.sendMessage(payload);
    return true;
}

// --- Helper: Attempt to Get Content and Log (with Retries) ---
let assistantMessageStartTime = null; // To capture start of assistant generation

function attemptToGetContentAndLog(targetElement, role, domId, rawSourceDetails, attempt = 0) {
    const MAX_ATTEMPTS = 6; // e.g., try 6 times
    const RETRY_DELAY_MS = 250; // e.g., wait 250ms between tries (total 1.5s)

    if (!targetElement) {
        console.warn(`[content.js] Target element for ID ${domId} (${role}) not found. Cannot get content.`);
        if (role === 'assistant' && latestPendingAssistantMessage.id === domId) {
            latestPendingAssistantMessage.logged = true; // Mark as "handled" to prevent it getting stuck
        }
        return;
    }

    const { plainText, htmlContent } = extractStructuredContent(targetElement);

    if (plainText.trim()) { // Check if there's actual text content
        console.log(`[content.js] Structured content found for ${role} ID ${domId} on attempt ${attempt + 1}. PlainText Snippet: "${plainText.substring(0, 70).replace(/\n/g, " ")}"`);
        logMessage(role, plainText, htmlContent, rawSourceDetails);
        if (role === 'assistant' && latestPendingAssistantMessage.id === domId) {
            latestPendingAssistantMessage.logged = true;
            assistantMessageStartTime = null; // Reset for next message
        }
    } else if (attempt < MAX_ATTEMPTS) {
        console.log(`[content.js] PlainText for ${role} ID ${domId} is empty. Retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
        setTimeout(() => attemptToGetContentAndLog(targetElement, role, domId, rawSourceDetails, attempt + 1), RETRY_DELAY_MS);
    } else {
        console.warn(`[content.js] Failed to get plainText for ${role} ID ${domId} after ${MAX_ATTEMPTS} attempts. Element was:`, targetElement);
        if (role === 'assistant' && latestPendingAssistantMessage.id === domId) {
            latestPendingAssistantMessage.logged = true; // Still mark as "handled"
            assistantMessageStartTime = null; // Reset
        }
    }
}

const chatHistoryObserverCallback = (mutationsList, observer) => {
    if (!initialDOMScanComplete) return;

    for (const mutation of mutationsList) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach(node => {
                // --- YOUR NEW INTEGRATED DIAGNOSTIC LOGGING ---
                if (node.nodeType === Node.ELEMENT_NODE) {
                    // Log some identifying features of the node BEFORE trying to process it
                    // We may be able to do this silently so we don't spam the console
                    console.log(
                        '[content.js] chatHistoryObserver: Processing added node. Tag:', node.tagName,
                        'ID:', node.id || 'N/A',
                        'Classes:', node.className || 'N/A'
                    );
                    // Optionally, a small snippet of its HTML to help identify it visually if needed,
                    // but be careful as outerHTML can be very long.
                    // console.log('[content.js] chatHistoryObserver: Node outerHTML snippet:', node.outerHTML.substring(0, 250) + "...");

                    // This is where your existing logic to determine if it's a message node
                    // and then call attemptToGetContentAndLog would be.
                    // Let's assume you have a way to identify if it's a node you care about.
                    // For example, if 'attemptToGetContentAndLog' itself does this check,
                    // then the logs above will fire for every added element, and 'attemptToGetContentAndLog'
                    // will decide whether to proceed to 'logMessage'.

                    // // If you have a separate check like 'isMessageNode(node)' before calling attemptToGetContentAndLog:
                    // if (isRelevantMessageNode(node)) { // Replace isRelevantMessageNode with your actual condition
                    //     console.log('[content.js] chatHistoryObserver: Node IS considered relevant. Calling attemptToGetContentAndLog.');
                    //     // attemptToGetContentAndLog(node, 'assistant'); // Or however role is determined
                    //     // OR, if attemptToGetContentAndLog is always called and filters internally:
                    //     attemptToGetContentAndLog(node, determineRoleFromNode(node)); // You'd need determineRoleFromNode
                    // } else {
                    //     console.log('[content.js] chatHistoryObserver: Node is NOT considered a target message node. Skipping full processing.');
                    // }
                }
                // --- END OF INTEGRATED DIAGNOSTIC LOGGING ---

                if (node.nodeType !== Node.ELEMENT_NODE) return;

                let role = null;
                let domId = null;
                let textExtractTargetElement = null;
                let rawSourceDetails = {};
                let idHoldingElement = null;

                // Try to identify as an Assistant Message
                idHoldingElement = node.matches('div[id^="model-response-message-contentr_"]')
                    ? node
                    : (node.querySelector ? node.querySelector('div[id^="model-response-message-contentr_"]') : null);
                if (idHoldingElement) {
                    role = 'assistant';
                    domId = idHoldingElement.id;
                    textExtractTargetElement = idHoldingElement;
                    rawSourceDetails = { dom_id: domId, selector_used: 'div[id^="model-response-message-contentr_"]' };
                } else {
                    // Try to identify as a User Message
                    idHoldingElement = node.matches('div.query-content[id^="user-query-content-"]')
                        ? node
                        : (node.querySelector ? node.querySelector('div.query-content[id^="user-query-content-"]') : null);
                    if (idHoldingElement) {
                        role = 'user';
                        domId = idHoldingElement.id;
                        textExtractTargetElement = idHoldingElement.querySelector('div.query-text');
                        rawSourceDetails = { dom_id: domId, selector_used: 'div.query-content[id^="user-query-content-"]' };
                    }
                }

                if (role && domId) {
                    if (!domId || domId.endsWith('undefined')) {
                        console.warn(`[content.js] Invalid or undefined DOM ID ('${domId}') for ${role}. Skipping.`);
                        return;
                    }

                    if (processedGeminiDomIdsInCurrentConversation.has(domId)) {
                        return;
                    }

                    processedGeminiDomIdsInCurrentConversation.add(domId);
                    console.log(`[content.js] Added new DOM ID to Set: ${domId} (${role}). Set size: ${processedGeminiDomIdsInCurrentConversation.size}`);

                    if (!textExtractTargetElement && role === 'user') {
                        console.warn(`[content.js] User message container ID ${domId} found, but specific text element (div.query-text) not found.`);
                        return;
                    }
                    if (!textExtractTargetElement && role === 'assistant') {
                        console.warn(`[content.js] Assistant message container ID ${domId} found, but textExtractTargetElement is null.`);
                        return;
                    }


                    if (role === 'user') {
                        // For user messages, content is usually available immediately.
                        // We can use attemptToGetContentAndLog for consistency or simplify if retries are not needed.
                        attemptToGetContentAndLog(textExtractTargetElement, 'user', domId, rawSourceDetails);
                    } else if (role === 'assistant') {
                        // For assistant, store it as pending. inputAreaStateObserverCallback will trigger processing.
                        latestPendingAssistantMessage = { id: domId, element: textExtractTargetElement, logged: false, rawSourceDetails: rawSourceDetails };
                        console.log(`[content.js] Assistant message container DETECTED and PENDING: ID ${domId}`);
                    }
                }

            });
        }
    }
};

// --- Mutation Observer Callbacks ---

// const chatHistoryObserverCallback = (mutationsList, observer) => {
//     if (!initialDOMScanComplete) return;

//     for (const mutation of mutationsList) {
//         if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
//             mutation.addedNodes.forEach(node => {
//                 if (node.nodeType !== Node.ELEMENT_NODE) return;

//                 let role = null;
//                 let domId = null;
//                 let textExtractTargetElement = null;
//                 let rawSourceDetails = {};
//                 let idHoldingElement = null;

//                 // Try to identify as an Assistant Message
//                 idHoldingElement = node.matches('div[id^="model-response-message-contentr_"]')
//                     ? node
//                     : (node.querySelector ? node.querySelector('div[id^="model-response-message-contentr_"]') : null);
//                 if (idHoldingElement) {
//                     role = 'assistant';
//                     domId = idHoldingElement.id;
//                     textExtractTargetElement = idHoldingElement;
//                     rawSourceDetails = { dom_id: domId, selector_used: 'div[id^="model-response-message-contentr_"]' };
//                 } else {
//                     // Try to identify as a User Message
//                     idHoldingElement = node.matches('div.query-content[id^="user-query-content-"]')
//                         ? node
//                         : (node.querySelector ? node.querySelector('div.query-content[id^="user-query-content-"]') : null);
//                     if (idHoldingElement) {
//                         role = 'user';
//                         domId = idHoldingElement.id;
//                         textExtractTargetElement = idHoldingElement.querySelector('div.query-text');
//                         rawSourceDetails = { dom_id: domId, selector_used: 'div.query-content[id^="user-query-content-"]' };
//                     }
//                 }

//                 if (role && domId) {
//                     if (!domId || domId.endsWith('undefined')) {
//                         console.warn(`[content.js] Invalid or undefined DOM ID ('${domId}') for ${role}. Skipping.`);
//                         return;
//                     }

//                     if (processedGeminiDomIdsInCurrentConversation.has(domId)) {
//                         return;
//                     }

//                     processedGeminiDomIdsInCurrentConversation.add(domId);
//                     console.log(`[content.js] Added new DOM ID to Set: ${domId} (${role}). Set size: ${processedGeminiDomIdsInCurrentConversation.size}`);

//                     if (!textExtractTargetElement && role === 'user') {
//                         console.warn(`[content.js] User message container ID ${domId} found, but specific text element (div.query-text) not found.`);
//                         return;
//                     }
//                     if (!textExtractTargetElement && role === 'assistant') {
//                         console.warn(`[content.js] Assistant message container ID ${domId} found, but textExtractTargetElement is null.`);
//                         return;
//                     }


//                     if (role === 'user') {
//                         // For user messages, content is usually available immediately.
//                         // We can use attemptToGetContentAndLog for consistency or simplify if retries are not needed.
//                         attemptToGetContentAndLog(textExtractTargetElement, 'user', domId, rawSourceDetails);
//                     } else if (role === 'assistant') {
//                         // For assistant, store it as pending. inputAreaStateObserverCallback will trigger processing.
//                         latestPendingAssistantMessage = { id: domId, element: textExtractTargetElement, logged: false, rawSourceDetails: rawSourceDetails };
//                         console.log(`[content.js] Assistant message container DETECTED and PENDING: ID ${domId}`);
//                     }
//                 }
//             });
//         }
//     }
// };

const inputAreaStateObserverCallback = (mutationsList, observer) => {
    if (!initialDOMScanComplete) return;
    // console.log("--- INPUT AREA STATE OBSERVER FIRED ---"); // Can be noisy

    const buttonsWrapper = document.querySelector(INPUT_BUTTONS_WRAPPER_SELECTOR);
    if (!buttonsWrapper) return;

    const sendContainer = buttonsWrapper.querySelector(SEND_BUTTON_CONTAINER_SELECTOR);
    let currentStopIconIsActive = false;
    if (sendContainer && !sendContainer.classList.contains('hidden') && sendContainer.querySelector(`mat-icon[fonticon="${FONTICON_VALUE_STOP}"]`)) {
        currentStopIconIsActive = true;
    }

    if (!assistantWasGeneratingWithStopIcon && currentStopIconIsActive) {
        console.log(`[ICON_STATE_CHANGE] ==> Assistant STARTED generating.`);
        assistantWasGeneratingWithStopIcon = true;
        assistantMessageStartTime = new Date().toISOString(); // Capture start time

        if (latestPendingAssistantMessage.id && !latestPendingAssistantMessage.logged) {
            console.warn(`[content.js] New assistant generation started while pending message ID ${latestPendingAssistantMessage.id} was not logged. Clearing old one.`);
        }
        latestPendingAssistantMessage = { id: null, element: null, logged: false, rawSourceDetails: null }; // Reset for new message

    } else if (assistantWasGeneratingWithStopIcon && !currentStopIconIsActive) {
        console.log(`[ICON_STATE_CHANGE] ==> Assistant FINISHED generating.`);
        assistantWasGeneratingWithStopIcon = false;

        if (latestPendingAssistantMessage.id && !latestPendingAssistantMessage.logged) {
            console.log(`[content.js] Assistant finished. Processing pending message ID: ${latestPendingAssistantMessage.id}`);
            const elementToLog = latestPendingAssistantMessage.element || document.getElementById(latestPendingAssistantMessage.id);
            // Pass the originally stored rawSourceDetails
            attemptToGetContentAndLog(elementToLog, 'assistant', latestPendingAssistantMessage.id, latestPendingAssistantMessage.rawSourceDetails);
            // attemptToGetContentAndLog will set latestPendingAssistantMessage.logged = true on success/final attempt
        } else if (latestPendingAssistantMessage.id && latestPendingAssistantMessage.logged) {
            console.log(`[content.js] Assistant finished, pending message ${latestPendingAssistantMessage.id} already logged. Resetting.`);
            latestPendingAssistantMessage = { id: null, element: null, logged: false, rawSourceDetails: null };
        } else {
            console.log("[content.js] Assistant finished, but no pending assistant message ID was set by chatHistoryObserver.");
        }

        if (assistantRecentlyFinishedTimeout) clearTimeout(assistantRecentlyFinishedTimeout);
        assistantRecentlyFinishedTimeout = setTimeout(() => {
            assistantRecentlyFinished = false;
        }, 1500);
    }
};

// --- Initialization Functions ---
function initializeObservers() {
    // Use a more general selector if CHAT_HISTORY_SCROLLER_SELECTOR isn't always the direct parent of added messages
    const chatParentElement = document.querySelector(CHAT_CONTAINER_SELECTOR) || document.querySelector('div#chat-history infinite-scroller.chat-history');
    if (chatParentElement) {
        const chatObserver = new MutationObserver(chatHistoryObserverCallback);
        chatObserver.observe(chatParentElement, { childList: true, subtree: true });
        console.log('[content.js] Chat history observer started on:', chatParentElement);
    } else {
        console.warn('[content.js] Chat parent element for observer not found. Will retry in main tryInit.');
    }

    const buttonsWrapper = document.querySelector(INPUT_BUTTONS_WRAPPER_SELECTOR);
    if (buttonsWrapper) {
        const buttonObserver = new MutationObserver(inputAreaStateObserverCallback);
        buttonObserver.observe(buttonsWrapper, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['class', 'style', 'fonticon'] // fonticon is what Gemini uses for send/stop
        });
        console.log('[content.js] Input area state observer started.');
        // Initial check
        setTimeout(() => { if (initialDOMScanComplete) inputAreaStateObserverCallback([], buttonObserver); }, 550);
    } else {
        console.warn('[content.js] Input buttons wrapper not found. Will retry in main tryInit.');
    }
}

// (setupUserInputListeners remains the same as you provided)
function setupUserInputListeners() {
    const textInput = document.querySelector(TEXT_INPUT_SELECTOR);
    const sendButtonElementHost = document.querySelector(SEND_BUTTON_CONTAINER_SELECTOR);

    const handleUserAction = () => {
        if (textInput) {
            // Use extractStructuredContent to get the text as the user sees it (with newlines)
            const { plainText } = extractStructuredContent(textInput.querySelector('p') || textInput); // Assuming text is in a <p>
            console.log('[content.js] User action (click/Enter) to send: "' + plainText.substring(0, 50).replace(/\n/g, " ") + '"');
            // The actual sending is handled by Gemini's UI. 
            // The user message will be picked up by chatHistoryObserverCallback when it appears in the chat history.
        }
    };

    if (sendButtonElementHost) {
        sendButtonElementHost.addEventListener('click', (event) => {
            if (event.target.closest('button mat-icon[fonticon="send"]') || event.target.closest('button mat-icon[fonticon="stop"]')) {
                handleUserAction();
            }
        }, true);
    }

    if (textInput) {
        textInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                handleUserAction();
            }
        });
    }
}

// Find commands in the log (text) and who issued them (role)
function detectCommandsInText(role, text) {
    const commandData = {
        llmCommands: [],
        userCommands: [], // This will always be empty for now
        semanticTokens: [],
        systemMessages: [],
        runcodeBlockPresent: false // Specific to assistant's (((RUNCODE)))
    };

    if (typeof text !== 'string') {
        console.error('[detectCommandsInText] Received non-string input:', text);
        return null;
    }

    // ===== Global Parsing and Processing =====

    // Semantic Tokens
    const newSemanticTokenRegex = /\[\[\[([\s\S]+?)\]\]\]/gi;
    let tokenMatch;
    while ((tokenMatch = newSemanticTokenRegex.exec(text)) !== null) {
        commandData.semanticTokens.push({
            raw: tokenMatch[0],
            token: tokenMatch[1].trim()
        });
    }

    // System Messages are still good to be ready to parse if they appear
    const systemMessageRegex = /\{\{\{\s*(SYSTEM)\s*\}\}\}([\s\S]*?)\{\{\{\s*\/SYSTEM\s*\}\}\}/gi;

    if (systemMessageRegex.test(text.trim())) {
        commandData.isSystemMessageContent = true;
        console.log('[detectCommandsInText] Text identified as a SYSTEM block content.');
        // If it's a system block, we might not want to parse it for RUNCODE at all,
        // or background.js can use this flag. For now, let's just flag it.
    }

    // message parsing logic
    if (role === 'assistant') {
        // If it's already identified as SYSTEM content, we skip looking for RUNCODE within it.
        // This prevents recalled text containing RUNCODE examples from being parsed here.
        if (commandData.isSystemMessageContent) {
            console.log('[detectCommandsInText] Assistant message is SYSTEM content, skipping RUNCODE parse for execution.');
        } else {

            console.log('[detectCommandsInText] Assistant role detected. Looking for strictly formatted (((RUNCODE))) block...');

            let inRunCodeBlock = false;
            let accumulatedBlockContent = ""; // To store lines between RUNCODE delimiters
            const linesInMessage = text.split('\n');
            const runcodeStartRegex = /^\s*\(\(\(RUNCODE\)\)\)\s*$/; // Expects (((RUNCODE))) on its own line (with optional whitespace)
            const runcodeEndRegex = /^\s*\(\(\(\/RUNCODE\)\)\)\s*$/;   // Expects (((/RUNCODE))) on its own line

            for (const currentLine of linesInMessage) {
                const trimmedLine = currentLine.trim();
                if (runcodeStartRegex.test(trimmedLine)) {
                    if (inRunCodeBlock) { /* handle nested/error */ accumulatedBlockContent = ""; }
                    inRunCodeBlock = true; commandData.runcodeBlockPresent = true; continue;
                }
                if (runcodeEndRegex.test(trimmedLine)) {
                    if (inRunCodeBlock) { inRunCodeBlock = false; break; }
                    continue;
                }
                if (inRunCodeBlock) { accumulatedBlockContent += currentLine + '\n'; }
            }

            if (commandData.runcodeBlockPresent && !inRunCodeBlock && accumulatedBlockContent.trim() !== "") {
                const commandBlockContentToParse = accumulatedBlockContent.trim();
                console.log('[detectCommandsInText] Assistant (((RUNCODE))) content successfully extracted:', commandBlockContentToParse);

                // Now use your existing logic to parse (((COMMAND args))) ONLY from commandBlockContentToParse
                const linesFromBlock = commandBlockContentToParse.split('\n');
                const llmCommandRegex = /^\s*\(\(\(\s*([A-Z0-9_-]+)(?:\s+([\s\S]*?))?\s*\)\)\)\s*$/i;

                linesFromBlock.forEach((lineInBlock) => {
                    const trimmedLineInBlock = lineInBlock.trim();
                    let llmMatch = llmCommandRegex.exec(trimmedLineInBlock);
                    if (llmMatch) {
                        console.log(`[detectCommandsInText] LLM Command Match within RUNCODE:`, llmMatch);
                        commandData.llmCommands.push({
                            raw: llmMatch[0].trim(),
                            command: llmMatch[1].toUpperCase(),
                            args: llmMatch[2] ? llmMatch[2].trim() : null
                        });
                    }
                });

                if (commandData.llmCommands.length === 0) {
                    console.log('[detectCommandsInText] (((RUNCODE))) block was present, but no valid (((COMMAND))) found inside.');
                }

            } else {
                // This 'else' covers several cases:
                // - No (((RUNCODE))) start tag was ever found.
                // - A (((RUNCODE))) start tag was found, but no matching (((/RUNCODE))) end tag.
                // - A complete block was found, but it was empty or only whitespace.
                if (commandData.runcodeBlockPresent && inRunCodeBlock) {
                    console.warn('[detectCommandsInText] Unterminated (((RUNCODE))) block for assistant. No commands processed from it.');
                } else if (!commandData.runcodeBlockPresent) {
                    console.log('[detectCommandsInText] No strictly formatted (((RUNCODE))) block found for assistant.');
                } else {
                    console.log('[detectCommandsInText] (((RUNCODE))) block found for assistant was empty or invalid.');
                }
                commandData.runcodeBlockPresent = false; // Ensure this is false if we don't have actionable commands from a block
                console.log('[detectCommandsInText] Turning off runcodeBlockPresent due to no valid block found or incomplete block.');

            }
        }

        // OLD version from twenty-second-old-content.js
        // for (const currentLine of linesInMessage) {
        //     const trimmedLine = currentLine.trim();

        //     if (runcodeStartRegex.test(trimmedLine)) {
        //         if (inRunCodeBlock) {
        //             // This implies a nested RUNCODE start or a missing end tag for a previous one.
        //             console.warn("[detectCommandsInText] Detected nested (((RUNCODE))) or missing (((/RUNCODE))). Resetting current block.");
        //             // Reset, as we only handle one top-level block for now
        //             accumulatedBlockContent = "";
        //         }
        //         inRunCodeBlock = true;
        //         commandData.runcodeBlockPresent = true; // Mark that we've at least found the start
        //         console.log('[detectCommandsInText] Found start of (((RUNCODE))) block.');
        //         continue; // Don't include the "(((RUNCODE)))" line itself in the content
        //     }

        //     if (runcodeEndRegex.test(trimmedLine)) {
        //         if (inRunCodeBlock) {
        //             inRunCodeBlock = false; // We've found the end of the current block
        //             console.log('[detectCommandsInText] Found end of (((RUNCODE))) block.');
        //             // If we only process the first complete block found, we can break here.
        //             // If you want to allow multiple blocks, you'd process accumulatedBlockContent here
        //             // and then reset it for the next potential block. For now, let's assume one block.
        //             break;
        //         } else {
        //             // Encountered an end tag without a start tag being active.
        //             console.warn("[detectCommandsInText] Found (((/RUNCODE))) without an opening block being active.");
        //         }
        //         continue; // Don't include the "(((/RUNCODE)))" line itself
        //     }

        //     if (inRunCodeBlock) {
        //         accumulatedBlockContent += currentLine + '\n'; // Accumulate the original lines (with their original spacing within the block)
        //     }
        // }
    } else if (role === 'user') {
        console.log('[detectCommandsInText] User role. No command processing for user input in this MVP.');
        // No '|||RUNCODE|||' parsing for user in this iteration, keeps it simple
    }
    // Return commandData if anything actionable or noteworthy was found
    if (commandData.llmCommands.length > 0 ||
        commandData.semanticTokens.length > 0 ||
        commandData.systemMessages.length > 0 ||
        commandData.isSystemMessageContent) {
        // one day user ||| commands ||| will be added here
        console.log('[detectCommandsInText] FINAL detectedCommands:', JSON.parse(JSON.stringify(commandData)));
        return commandData;
    }
    return null; // ending the assistant check here instead for now...

    //     // After checking all lines, process if a complete block was identified and had content
    //     if (commandData.runcodeBlockPresent && !inRunCodeBlock && accumulatedBlockContent.trim() !== "") {
    //         const commandBlockContentToParse = accumulatedBlockContent.trim();
    //         console.log('[detectCommandsInText] Assistant (((RUNCODE))) content successfully extracted:', commandBlockContentToParse);

    //         // Now use your existing logic to parse (((COMMAND args))) ONLY from commandBlockContentToParse
    //         const linesFromBlock = commandBlockContentToParse.split('\n');
    //         const llmCommandRegex = /^\s*\(\(\(\s*([A-Z0-9_-]+)(?:\s+([\s\S]*?))?\s*\)\)\)\s*$/i;

    //         linesFromBlock.forEach((lineInBlock) => {
    //             const trimmedLineInBlock = lineInBlock.trim();
    //             let llmMatch = llmCommandRegex.exec(trimmedLineInBlock);
    //             if (llmMatch) {
    //                 console.log(`[detectCommandsInText] LLM Command Match within RUNCODE:`, llmMatch);
    //                 commandData.llmCommands.push({
    //                     raw: llmMatch[0].trim(),
    //                     command: llmMatch[1].toUpperCase(),
    //                     args: llmMatch[2] ? llmMatch[2].trim() : null
    //                 });
    //             }
    //         });

    //         if (commandData.llmCommands.length === 0) {
    //             console.log('[detectCommandsInText] (((RUNCODE))) block was present, but no valid (((COMMAND))) found inside.');
    //         }

    //     } else {
    //         // This 'else' covers several cases:
    //         // - No (((RUNCODE))) start tag was ever found.
    //         // - A (((RUNCODE))) start tag was found, but no matching (((/RUNCODE))) end tag.
    //         // - A complete block was found, but it was empty or only whitespace.
    //         if (commandData.runcodeBlockPresent && inRunCodeBlock) {
    //             console.warn('[detectCommandsInText] Unterminated (((RUNCODE))) block for assistant. No commands processed from it.');
    //         } else if (!commandData.runcodeBlockPresent) {
    //             console.log('[detectCommandsInText] No strictly formatted (((RUNCODE))) block found for assistant.');
    //         } else {
    //             console.log('[detectCommandsInText] (((RUNCODE))) block found for assistant was empty or invalid.');
    //         }
    //         commandData.runcodeBlockPresent = false; // Ensure this is false if we don't have actionable commands from a block
    //     }
    // } else if (role === 'user') {
    //     console.log('[detectCommandsInText] User role detected. No command processing will occur for user input at this time.');
    //     // No command parsing for user input in this simplified MVP
    // }

    // // Return commandData if any commands OR tokens/system messages were found
    // if (commandData.llmCommands.length > 0 ||
    //     commandData.semanticTokens.length > 0 ||
    //     commandData.systemMessages.length > 0) {
    //     console.log('[detectCommandsInText] FINAL detectedCommands:', JSON.parse(JSON.stringify(commandData)));
    //     return commandData;
    // }

    // return null; // Or return commandData with empty arrays if you prefer
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'ping_sync_session':
            console.log('[content.js] Received "ping_sync_session" from background.js. Tab URL:', message.tabUrl, 'Platform Details:', message.platformDetails);
            // Now, trigger your standard "content script is ready and needs session info" logic.
            // This usually means sending your 'content_script_page_status' message or similar.
            // You might also want to re-run parts of your content script's initialization if needed.

            // Example: Re-send your page status message which background.js uses to resolve session
            chrome.runtime.sendMessage({
                type: 'content_script_page_status', // Or 'content_script_ready'
                payload: {
                    isFreshPage: true, // Or determine this dynamically if possible
                    url: window.location.href,
                    // Any other info background.js needs for resolveSessionForTab
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('[content.js] Error sending page status after ping:', chrome.runtime.lastError.message);
                    sendResponse({ status: "ping_received_page_status_send_error" });
                } else {
                    console.log('[content.js] Page status sent to background.js after ping. Response:', response);
                    sendResponse({ status: "ping_received_page_status_sent" });
                }
            });
            return true; // Important: keep message channel open for async sendResponse from this handler
            break;
        case 'display_dom_message_in_chat':
            if (message.role && typeof message.content === 'string') {
                console.log(`[content.js] "display_dom_message_in_chat" received. Role: ${message.role}, Content: "${message.content.substring(0, 50)}..."`);
                // just want to see it in the console first               
            }

            console.log('[content.js] Received display_dom_message_in_chat:', message.text);

            // --- 1. Find the chat container element (we still might need a general container for fallbacks or initial append) ---
            // Let's try to find the element that directly contains the messages first.
            // The parent of the <p data-sourcepos="..."> elements is a good candidate.

            let insertionPoint = null;
            let parentContainer = null;

            // Try to find the last message paragraph with data-sourcepos (often assistant messages)
            // You might need a more general selector if user messages don't use data-sourcepos
            // or if you want to append after the absolute last message regardless of who sent it.
            // For now, let's use your specific observation.
            const allDataSourcePosParagraphs = document.querySelectorAll('p[data-sourcepos]');

            if (allDataSourcePosParagraphs.length > 0) {
                const lastDataSourcePosParagraph = allDataSourcePosParagraphs[allDataSourcePosParagraphs.length - 1];
                parentContainer = lastDataSourcePosParagraph.parentNode;
                insertionPoint = lastDataSourcePosParagraph.nextSibling; // The element to insert *before* (making ours appear after lastDataSourcePosParagraph)
                console.log('[content.js] Found last <p data-sourcepos>, will insert after it. Parent:', parentContainer);
            } else {
                // Fallback: If no <p data-sourcepos> found, try appending to the scroller or #chat-history
                // This reuses our previous best guess if the specific paragraph isn't found
                parentContainer = document.querySelector('infinite-scroller.chat-history[data-test-id="chat-history-container"]');
                if (!parentContainer) {
                    parentContainer = document.getElementById('chat-history');
                }
                insertionPoint = null; // This means appendChild will be used, adding it to the end of parentContainer
                console.log('[content.js] No <p data-sourcepos> found, using fallback container:', parentContainer);
            }


            if (parentContainer) {
                const systemMessageDiv = document.createElement('div');
                // Style it to look like a system message, distinct from user/assistant
                systemMessageDiv.textContent = message.text;
                systemMessageDiv.style.backgroundColor = 'lightgoldenrodyellow'; // Yet another color for this test
                systemMessageDiv.style.padding = '8px 15px';
                systemMessageDiv.style.margin = '10px 40px'; // Indent
                systemMessageDiv.style.border = '1px solid #ccc';
                systemMessageDiv.style.borderRadius = '6px';
                systemMessageDiv.style.fontStyle = 'italic';
                systemMessageDiv.setAttribute('data-project-you-system-message', 'true');

                // --- 3. Append it ---
                if (insertionPoint) {
                    parentContainer.insertBefore(systemMessageDiv, insertionPoint);
                } else {
                    parentContainer.appendChild(systemMessageDiv); // Fallback if no specific insertion point
                }

                // --- 4. Scroll into view ---
                systemMessageDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });

                console.log('[content.js] System message injected using new strategy.');
                sendResponse({ status: "System message displayed via new strategy" });
            } else {
                console.error('[content.js] CRITICAL: Could not find a suitable parent container or insertion point.');
                sendResponse({ status: "Failed to find container with new strategy" });
            }

            // // --- 1. Find the chat container element ---
            // let chatContainer = document.querySelector('infinite-scroller.chat-history[data-test-id="chat-history-container"]');

            // if (!chatContainer) {
            //     // Fallback to the ID if the more specific scroller isn't found
            //     chatContainer = document.getElementById('chat-history');
            //     if (chatContainer) {
            //         // If #chat-history is an outer wrapper, try to find the scroller within it
            //         const scrollerInsideHistory = chatContainer.querySelector('infinite-scroller.chat-history[data-test-id="chat-history-container"]');
            //         if (scrollerInsideHistory) {
            //             chatContainer = scrollerInsideHistory;
            //         }
            //         // If still no specific scroller, and #chat-history itself might be the direct message list (less likely now)
            //         // we might need to look for a direct child list.
            //         // For now, let's assume if #chat-history is found and the scroller isn't, #chat-history might be it.
            //     }
            // }

            // // As a very last resort if the above fails
            // if (!chatContainer) {
            //     const anyMessage = document.querySelector('.conversation-container'); // Using the class you just found
            //     if (anyMessage && anyMessage.parentElement) {
            //         chatContainer = anyMessage.parentElement; // This would be the direct parent of message units
            //         console.log('[content.js] Last resort: Using parentElement of a .conversation-container');
            //     }
            // }


            // if (chatContainer) {
            //     const systemMessageDiv = document.createElement('div');
            //     // Make it look a bit like a conversation-container for structure, but with our own class
            //     systemMessageDiv.className = 'conversation-container eddie-system-message ng-star-inserted'; // Mimic structure, add our own

            //     systemMessageDiv.style.padding = '10px'; // General padding
            //     systemMessageDiv.style.margin = '10px 0px';   // Margin like other chat bubbles
            //     systemMessageDiv.style.border = '1px solid skyblue';
            //     systemMessageDiv.style.borderRadius = '8px';
            //     systemMessageDiv.style.backgroundColor = '#e0f7fa'; // Light cyan background

            //     // Create an inner structure similar to what Gemini might use for text
            //     const innerTextDiv = document.createElement('div');
            //     innerTextDiv.textContent = message.text;
            //     innerTextDiv.style.padding = '0px 20px'; // Indent text within the bubble

            //     systemMessageDiv.appendChild(innerTextDiv);

            //     // Append and scroll
            //     chatContainer.appendChild(systemMessageDiv);
            //     systemMessageDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });

            //     console.log('[content.js] System message injected. Target container:', chatContainer);
            //     sendResponse({ status: "System message displayed with new selector strategy" });
            // } else {
            //     console.error('[content.js] CRITICAL: Could not find refined chat container element to inject system message.');
            //     sendResponse({ status: "Failed to find chat container with refined selectors" });
            // }
            // // --- 1. Find the chat container element ---
            // // This is the trickiest part and specific to Gemini's UI.
            // // We need to inspect the Gemini page with DevTools to find a reliable selector.
            // // Look for the element that holds all the chat bubbles.
            // // Examples of what it MIGHT be (these are GUESSES, you'll need to inspect):
            // // let chatContainer = document.querySelector('div[aria-live="polite"]'); 
            // // let chatContainer = document.querySelector('.chat-log-scroll-container'); // Or similar
            // // let chatContainer = document.querySelector('YOUR_GEMINI_CHAT_LOG_SELECTOR_HERE');

            // // Let's try a common pattern for chat UIs: the element with message bubbles.
            // // This selector looks for a div that typically wraps user and model responses.
            // // You will likely need to refine this by inspecting Gemini's DOM.
            // let chatContainer = document.querySelector('message-list'); // This is a hypothetical common element
            // if (!chatContainer) {
            //     // Fallback attempt: look for a common attribute
            //     // chatContainer = document.querySelector('div[data-test-id="chat-history"]');
            //     chatContainer = document.querySelector('infinite-scroller[data-test-id="chat-history-container"]');
            // }
            // if (!chatContainer) {
            //     // More specific Gemini structure often involves <annotated-content> or similar wrappers
            //     // for each message. We want the parent of those.
            //     // Let's try to find the element that would contain multiple 'message-container' like elements
            //     const messages = document.querySelectorAll('.message-container, message-viewer, annotated-content');
            //     if (messages.length > 0) {
            //         chatContainer = messages[0].closest('div[style*="overflow-y: auto"], div[style*="overflow: auto"]');
            //         if (!chatContainer) chatContainer = messages[0].parentElement.parentElement; // Go up a couple of levels
            //     }
            // }

            // if (chatContainer) {
            //     const systemMessageDiv = document.createElement('div');

            //     // --- 2. Style it (basic example) ---
            //     systemMessageDiv.textContent = message.text;
            //     systemMessageDiv.style.backgroundColor = 'lightblue'; // Or your preferred style
            //     systemMessageDiv.style.padding = '10px';
            //     systemMessageDiv.style.margin = '10px 40px'; // Indent a bit
            //     systemMessageDiv.style.border = '1px solid blue';
            //     systemMessageDiv.style.borderRadius = '8px';
            //     systemMessageDiv.setAttribute('data-project-you-system-message', 'true'); // Good for identification

            //     // --- 3. Append it ---
            //     chatContainer.appendChild(systemMessageDiv);

            //     // --- 4. Scroll into view ---
            //     systemMessageDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });

            //     console.log('[content.js] System message injected into DOM.');
            //     sendResponse({ status: "System message displayed" });
            // } else {
            //     console.error('[content.js] Could not find chat container element to inject system message.');
            //     sendResponse({ status: "Failed to find chat container" });
            // }
            // Keep the listener open for async sendResponse if needed, though for this simple case it might not be.
            // return true; 
            break;
        case 'insert_prompt':
            if (typeof message.prompt === 'string') {
                console.log(`[content.js] "insert_prompt" received. Prompt: "${message.prompt.substring(0, 50)}..." Auto-submit: ${message.autoSubmit}`);
                const textInputElement = document.querySelector(TEXT_INPUT_SELECTOR);

                if (textInputElement) {
                    const pElement = textInputElement.querySelector('p') || textInputElement;
                    pElement.textContent = message.prompt;
                    // Dispatch input and change events to ensure the page reacts to the new value
                    textInputElement.dispatchEvent(new Event('input', { bubbles: true }));
                    textInputElement.dispatchEvent(new Event('change', { bubbles: true }));
                    console.log(`[content.js] Prompt inserted via 'insert_prompt': "${message.prompt}"`);

                    if (message.autoSubmit === true) {
                        console.log('[content.js] Auto-submitting inserted prompt...');
                        // Use a short timeout to allow the page to process the inserted text before clicking send
                        setTimeout(() => {
                            const sendButton = document.querySelector(SEND_BUTTON_CONTAINER_SELECTOR + ' button[aria-label="Send message"]:not([disabled])');
                            if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
                                sendButton.click();
                                sendResponse({ status: "Prompt inserted and auto-submitted by content.js" });
                            } else {
                                sendResponse({ status: "Prompt inserted, but auto-submit failed (send button not found/active or visible)" });
                            }
                        }, 100); // Reduced timeout slightly, can be adjusted
                    } else {
                        sendResponse({ status: "Prompt inserted by content.js (no auto-submit)" });
                    }
                } else {
                    sendResponse({ status: "Error: Text input not found in content.js for insert_prompt" });
                }
            } else {
                console.warn('[content.js] "insert_prompt" received without a string prompt.');
                sendResponse({ status: "Error: Prompt was not a string." });
            }
            return true; // Crucial: Indicates that sendResponse will be (or might be) called asynchronously

        case 'current_session_id_update':
            console.log(`[content.js] Received 'current_session_id_update'. New ID: ${message.currentSessionId}, Associated URL: ${message.associatedUrl}`);
            if (currentConversationIdForContentScript !== message.currentSessionId) {
                console.log(`[content.js] (current_session_id_update) Conversation ID changing from ${currentConversationIdForContentScript} to ${message.currentSessionId}. Clearing processed DOM IDs.`);
                currentConversationIdForContentScript = message.currentSessionId;
                processedGeminiDomIdsInCurrentConversation.clear();
                // Consider if a re-scan/re-evaluation of existing DOM elements is needed here
                // against the new session ID, though usually this is for future messages.
            }
            sendResponse({ status: "Session ID update acknowledged by content.js" });
            // This is a synchronous response, so `return true` is not strictly needed for this case alone,
            // but the overall listener might return true if any case is async.
            break;

        // Future message types can be added here as new cases:
        // case 'another_message_type':
        //     // ... handle another_message_type ...
        //     sendResponse({ status: "Another message type handled" });
        //     break;

        default:
            // Optional: Handle unknown message types
            console.log('[content.js] Received unhandled message type:', message.type);
            // sendResponse({ status: "Error: Unknown message type received by content.js" });
            // No sendResponse needed if we just want to ignore unknown types silently.
            break;
    }

    // If any case path calls sendResponse asynchronously (like 'insert_prompt'),
    // the listener should return true. If all paths are synchronous, it's not needed.
    // Since 'insert_prompt' IS asynchronous, returning true at the end of the function
    // (if not already returned in the async case) is a common pattern,
    // but it's cleaner to return true specifically within the case that needs it.
    // The `return true;` in the 'insert_prompt' case handles this.
});

// (requestInitialSessionId remains the same, but ensure its callback sets currentConversationIdForContentScript and clears the Set)
function requestInitialSessionId() {
    console.log("[content.js] Requesting initial session ID from background.");
    chrome.runtime.sendMessage({ type: 'get_current_session_info_for_content_script' }, response => {
        if (chrome.runtime.lastError) {
            console.error('[content.js] Error requesting initial session ID:', chrome.runtime.lastError.message);
            return;
        }
        if (response && response.currentSessionId) {
            console.log(`[content.js] Initial Session Info Received: Current ID: ${response.currentSessionId}, Previous ID: ${response.previousSessionId || 'N/A'}`);
            if (currentConversationIdForContentScript !== response.currentSessionId) {
                currentConversationIdForContentScript = response.currentSessionId;
                processedGeminiDomIdsInCurrentConversation.clear();
                console.log(`[content.js] Initial conversation ID set to ${currentConversationIdForContentScript}. Processed DOM IDs cleared.`);
            }
        }
    });
}

function reportPageStatusAndRequestInitialSessionId() {
    console.log("[content.js] Reporting page status and requesting initial session ID from background.");

    const isFresh = checkIfChatAreaIsFresh();
    console.log(`[content.js 5.55] [reportPageStatusAndRequestInitialSessionId]
                Sending 'content_script_page_status' with isFreshPage: ${isFresh} for URL: ${window.location.href}`);

    // We also need to determine if the current URL is generic or specific from content.js's perspective.
    // While background.js does the canonical getLLMPlatformAndChatDetails, content.js can make a good guess.
    // For now, let's focus on sending 'isFresh'. Background.js will use the sender.tab.url.

    chrome.runtime.sendMessage({
        type: 'content_script_page_status', // New message type
        payload: {
            isFreshPage: isFresh,
            // url: window.location.href // background.js can get this from sender.tab.url
        }
    }, response => {
        if (chrome.runtime.lastError) {
            console.error('[content.js] Error reporting page status or requesting initial session ID:', chrome.runtime.lastError.message);
            return;
        }
        if (response && response.currentSessionId) {
            console.log(`[content.js] Initial Session Info Received: Current ID: ${response.currentSessionId}, Associated URL: ${response.associatedUrl}`);
            if (currentConversationIdForContentScript !== response.currentSessionId ||
                (response.associatedUrl && !processedGeminiDomIdsInCurrentConversation.has(response.associatedUrl))) { // A bit of a simplification here

                // If the session ID changes OR if the session ID is the same but the background is associating it with a *new URL for this tab*
                // (which might happen if a generic page inherits a global session and then gets a specific URL),
                // then we should clear the processed DOM IDs.
                if (currentConversationIdForContentScript !== response.currentSessionId) {
                    console.log(`[content.js] Conversation ID changing from ${currentConversationIdForContentScript} to ${response.currentSessionId}. Clearing processed DOM IDs.`);
                } else if (response.associatedUrl && currentConversationIdForContentScript === response.currentSessionId) {
                    // Check if this specific URL is "new" to this content script for this session
                    // This part is tricky; the primary trigger for clearing should be session ID change.
                    // Let background.js handle the primary logic of session association.
                    // Content.js mainly needs to clear its cache if the session it's supposed to log to changes.
                }
                currentConversationIdForContentScript = response.currentSessionId;
                processedGeminiDomIdsInCurrentConversation.clear();
                // Potentially re-scan DOM if session context changes drastically, though usually new messages trigger observer.
            }
        } else {
            console.warn("[content.js] No valid session ID in response from background for page_status/initial_session_info.");
        }
    });
}

// (main function remains the same)
function main() {
    console.log("[content.js] Initializing (Hybrid Capture, Structured Text)...");
    let attempts = 0;
    function tryInit() {
        attempts++;
        const buttonsWrapperFound = !!document.querySelector(INPUT_BUTTONS_WRAPPER_SELECTOR);
        const chatHistoryScroller = document.querySelector('div#chat-history infinite-scroller.chat-history');
        const chatContainer = document.querySelector(CHAT_CONTAINER_SELECTOR);
        const chatElementToObserve = chatContainer || chatHistoryScroller; // Prefer more general chatContainer
        const textInputFound = !!document.querySelector(TEXT_INPUT_SELECTOR);

        if (buttonsWrapperFound && chatElementToObserve && textInputFound) {
            console.log("[content.js] All key elements found. Setting up.");
            initializeObservers(); // This will use chatElementToObserve
            setupUserInputListeners();
            reportPageStatusAndRequestInitialSessionId();
            requestInitialSessionId(); // This should set currentConversationIdForContentScript and clear the Set
            setTimeout(() => {
                initialDOMScanComplete = true;
                console.log("[content.js] Initial DOM scan complete flag SET. Observers active.");
                const tempObserver = new MutationObserver(() => { });
                inputAreaStateObserverCallback([], tempObserver); // Initial check
                tempObserver.disconnect();
            }, 2000);
        } else if (attempts < 30) {
            console.log(`[content.js] Waiting for DOM elements (attempt ${attempts})... chatElementToObserve found: ${!!chatElementToObserve}`);
            setTimeout(tryInit, 500);
        } else {
            console.error("[content.js] CRITICAL: Failed to find key elements for initialization.");
        }
    }
    if (document.readyState === "complete" || document.readyState === "interactive") {
        setTimeout(tryInit, 500); // Give a bit of time for dynamic UIs to settle
    } else {
        document.addEventListener("DOMContentLoaded", () => setTimeout(tryInit, 500));
    }
}

// --- Start Main Initialization ---
main();