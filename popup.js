// popup.js v5.55

// Global state (keep as is)
let logEntries = [];

let currentSessionId = null;
let currentSessionTitle = "No Session";
let userSettings = { preferredTimeZone: 'America/Los_Angeles' }; // Default

function renderLogs(entriesToRender, sessionTitle, userSettings) { // Pass these as parameters
    const output = document.getElementById('log-output');
    output.innerHTML = ''; // Clear previous entries
    if (entriesToRender) {
        console.log(`[popup.js 5.55] [renderLogs] entriesToRender.length is: ${entriesToRender.length} `);
    } else {
        console.log(`[popup.js 5.55] [renderLogs] entriesToRender was not received: null, or undefined`);
    }
    const sessionTitleElement = document.querySelector('.header h1');
    if (sessionTitleElement) {
        sessionTitleElement.textContent = sessionTitle || "Log Viewer";
    }

    console.log(`[popup.js v5.55] [renderLogs] Rendering ${entriesToRender ? entriesToRender.length : 0} exchange chunks.`);

    if (entriesToRender && entriesToRender.length > 0) {
        entriesToRender.forEach(chunk => {
            // Each 'chunk' is now an exchangeChunk object

            // --- Create and append User Input part ---
            if (chunk.user_input && chunk.user_input.raw_text) { // Check if user_input exists and has text
                const userEntryDiv = document.createElement('div');
                userEntryDiv.classList.add('log-entry', 'user');
                if (chunk.isContinuity) userEntryDiv.classList.add('continuity-entry');


                let userTimestamp = 'Timestamp N/A';
                if (chunk.timestamp_user_prompt) {
                    try {
                        userTimestamp = new Date(chunk.timestamp_user_prompt).toLocaleString('en-US', {
                            timeZone: userSettings.preferredTimeZone || 'America/Los_Angeles',
                            year: '2-digit', month: 'short', day: 'numeric',
                            hour: 'numeric', minute: '2-digit', hour12: true
                        });
                    } catch (e) { userTimestamp = chunk.timestamp_user_prompt; }
                }

                const userHeaderDiv = document.createElement('div');
                userHeaderDiv.classList.add('entry-header');
                let userHeaderHTML = `<span class="timestamp">${userTimestamp}</span>
                                      <span class="role user">user</span>
                                      ${chunk.source_llm_provider ? `<span class="platform">${chunk.source_llm_provider}</span>` : ''}`;
                if (chunk.isContinuity) { // If the whole chunk is continuity
                    userHeaderHTML = `<span class="continuity-label">[From Previous Session]</span> ` + userHeaderHTML;
                }
                userHeaderDiv.innerHTML = userHeaderHTML;

                const userContentDiv = document.createElement('div');
                userContentDiv.classList.add('entry-content');
                userContentDiv.textContent = chunk.user_input.raw_text; // Or chunk.user_input.text if you prefer sanitized

                userEntryDiv.appendChild(userHeaderDiv);
                userEntryDiv.appendChild(userContentDiv);
                output.appendChild(userEntryDiv);
            }

            // --- Create and append Assistant Response part ---
            if (chunk.assistant_response && chunk.assistant_response.raw_text) { // Check if assistant_response exists
                const assistantEntryDiv = document.createElement('div');
                assistantEntryDiv.classList.add('log-entry', 'assistant');
                if (chunk.isContinuity) assistantEntryDiv.classList.add('continuity-entry');

                let assistantTimestamp = 'Timestamp N/A';
                if (chunk.timestamp_assistant_response_complete) {
                    try {
                        assistantTimestamp = new Date(chunk.timestamp_assistant_response_complete).toLocaleString('en-US', {
                            timeZone: userSettings.preferredTimeZone || 'America/Los_Angeles',
                            year: '2-digit', month: 'short', day: 'numeric',
                            hour: 'numeric', minute: '2-digit', hour12: true
                        });
                    } catch (e) { assistantTimestamp = chunk.timestamp_assistant_response_complete; }
                }

                const assistantHeaderDiv = document.createElement('div');
                assistantHeaderDiv.classList.add('entry-header');
                let assistantHeaderHTML = `<span class="timestamp">${assistantTimestamp}</span>
                                           <span class="role assistant">assistant</span>
                                           ${chunk.source_llm_provider ? `<span class="platform">${chunk.source_llm_provider}</span>` : ''}`;
                // Continuity label already added if chunk.isContinuity for user part,
                // or you can decide if it applies per-message part.
                assistantHeaderDiv.innerHTML = assistantHeaderHTML;

                const assistantContentDiv = document.createElement('div');
                assistantContentDiv.classList.add('entry-content');
                assistantContentDiv.textContent = chunk.assistant_response.raw_text; // Or chunk.assistant_response.text

                assistantEntryDiv.appendChild(assistantHeaderDiv);
                assistantEntryDiv.appendChild(assistantContentDiv);
                output.appendChild(assistantEntryDiv);
            }
        });
        output.scrollTop = output.scrollHeight; // Auto-scroll to bottom
    } else {
        output.innerHTML = '<div class="empty-state">No conversation messages yet. Start chatting!</div>';
    }

    const statsDiv = document.getElementById('stats');
    if (statsDiv) {
        statsDiv.textContent = `Displaying ${entriesToRender ? entriesToRender.length : 0} exchanges.`;
    }
}

// Ensure refreshLogs correctly updates the global logEntries and calls renderLogs.
// The chrome.runtime.onMessage listener for 'log_update' should also correctly call refreshLogs or renderLogs.

// Function to refresh logs from the background script
function refreshLogs() {
    chrome.runtime.sendMessage({ type: 'get_logs' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("[popup.js 5.55] Error getting logs:", chrome.runtime.lastError.message);
            logEntries = [];
            // } else if (response && response.logs) {
            //     logEntries = response.logs;
        } else if (response) {
            logEntries = response.logs || [];
            currentSessionId = response.currentSessionId;
            currentSessionTitle = response.currentSessionTitle || `Session: ${currentSessionId ? currentSessionId.slice(-6) : 'N/A'}`;
            userSettings = response.userSettings || userSettings; // Update user settings
            sessionMetadata = response.currentSessionMetadata; // The new field

            document.getElementById('session-id-display').textContent = currentSessionId || 'N/A';
            if (sessionMetadata) {
                document.getElementById('session-platform-display').textContent = sessionMetadata.platform || 'N/A';
                document.getElementById('session-started-display').textContent = sessionMetadata.startedAt ? new Date(sessionMetadata.startedAt).toLocaleString() : 'N/A';
                document.getElementById('session-url-display').textContent = sessionMetadata.initiatingUrl || 'N/A';
                document.getElementById('session-status-display').textContent = sessionMetadata.status || 'N/A';
            } else {
                /* Clear these fields */
                document.getElementById('session-platform-display').textContent = "-";
                document.getElementById('session-started-display').textContent = "-";
                document.getElementById('session-url-display').textContent = "-";
                document.getElementById('session-status-display').textContent = "-";
            }

        } else {
            console.warn("[popup.js 5.55] No logs received from background or response was empty.");
            logEntries = [];
        }
        // expecting:
        // renderLogs(entriesToRender, sessionTitle, userSettings) { // Pass these as parameters
        renderLogs(logEntries, currentSessionTitle, userSettings, sessionMetadata);
    });
}

function startNewSession() { // Renamed from clearLogs
    // Could pass a default platform if known, e.g., from content.js detecting current page
    chrome.runtime.sendMessage({ type: 'start_new_session', platform: 'manual-new-session' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("[popup.js] Error starting new session:", chrome.runtime.lastError.message);
        } else {
            console.log('[popup.js] New session started:', response);
            // The 'session_updated' message from background should trigger refreshLogs
        }
    });
}

// Function to clear logs
function clearLogs() {
    chrome.runtime.sendMessage({ type: 'clear_logs' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("[popup.js 5.55] Error clearing logs:", chrome.runtime.lastError.message);
        } else {
            console.log('[popup.js 5.55] Clear logs response:', response);
            // The background script should send a 'log_update' with logsCleared: true
            // which will trigger the listener below to refresh and render.
            // As a fallback, or if you want immediate visual feedback without waiting for the message:
            logEntries = [];
            renderLogs();
        }
    });
}

// Function to save logs to disk
function saveToDisk() {
    console.log(`[popup.js 5.55] [saveToDisk] At least we got here!`);
    chrome.runtime.sendMessage({ type: 'save_log_to_disk' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("[popup.js 5.55] Error saving log:", chrome.runtime.lastError.message);
        } else if (response) {
            console.log('[popup.js 5.55] Log saved to disk successfully.');
        } else {
            console.error('[popup.js 5.55] Failed to save log to disk.');
        }
    });
}

async function loadAndDisplaySessions() {
    const sessionSelector = document.getElementById('session-selector');
    if (!sessionSelector) return;

    // Get the currently set currentSessionId from background to pre-select it
    const bgResponse = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'get_current_session_info_for_content_script' }, resolve)
    );
    const activeSessionIdFromBg = bgResponse?.currentSessionId;

    chrome.runtime.sendMessage({ type: 'get_all_session_summaries' }, response => {
        if (chrome.runtime.lastError) {
            console.error("[popup.js] Error getting all session summaries:", chrome.runtime.lastError.message);
            sessionSelector.innerHTML = '<option value="">Error loading</option>';
            return;
        }
        if (response && response.sessions) {
            console.log("[popup.js] Received session summaries:", response.sessions);
            sessionSelector.innerHTML = ''; // Clear existing options

            if (response.sessions.length === 0) {
                sessionSelector.innerHTML = '<option value="">No sessions found</option>';
                return;
            }

            // Sort sessions by startedAt date, newest first
            response.sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

            response.sessions.forEach(session => {
                const option = document.createElement('option');
                option.value = session.id;
                // Format title: "Chat about X (Gemini) - May 25, 2025, 10:30 PM (30 logs)"
                let displayTitle = session.title || session.id;
                if (session.platform && session.platform !== "unknown_turn_context" && session.platform !== "initialization_not_gemini_active" && session.platform !== "initialization_no_tab") {
                    displayTitle += ` (${session.platform.replace(/-chat-interface$/, '')})`;
                }
                let displayDate = "";
                try {
                    displayDate = ` - ${new Date(session.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}`;
                } catch (e) {/*ignore*/ }

                option.textContent = `${displayTitle}${displayDate} (${session.logCount} exchanges)`;

                if (session.id === activeSessionIdFromBg) {
                    option.selected = true;
                }
                sessionSelector.appendChild(option);
            });
        } else {
            sessionSelector.innerHTML = '<option value="">No sessions</option>';
        }
    });
}

// Event listener for DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {

    loadAndDisplaySessions(); // Load sessions when popup opens

    const sessionSelector = document.getElementById('session-selector');
    const activateButton = document.getElementById('activate-session-button');
    const deleteButton = document.getElementById('delete-session-button');
    const newSessionButton = document.getElementById('new-session-button');

    if (activateButton && sessionSelector) {
        activateButton.addEventListener('click', () => {
            const selectedSessionId = sessionSelector.value;
            if (selectedSessionId) {
                console.log(`[popup.js] Requesting to set active session to: ${selectedSessionId}`);
                chrome.runtime.sendMessage({ type: 'set_active_session', sessionId: selectedSessionId }, response => {
                    if (chrome.runtime.lastError) console.error("[popup.js] Error setting active session:", chrome.runtime.lastError.message);
                    else console.log("[popup.js] Set active session response:", response);
                    // After setting, refresh the logs to show the new current session's content
                    if (typeof refreshLogs === 'function') refreshLogs();
                    // Also, re-populate the dropdown to reflect the new current selection
                    loadAndDisplaySessions();
                });
            }
        });
    }

    if (deleteButton && sessionSelector) {
        deleteButton.addEventListener('click', () => {
            const selectedSessionId = sessionSelector.value;
            if (selectedSessionId && confirm(`Are you sure you want to delete session: ${selectedSessionId}? This cannot be undone.`)) {
                console.log(`[popup.js] Requesting to delete session: ${selectedSessionId}`);
                chrome.runtime.sendMessage({ type: 'delete_session', sessionId: selectedSessionId }, response => {
                    if (chrome.runtime.lastError) console.error("[popup.js] Error deleting session:", chrome.runtime.lastError.message);
                    else console.log("[popup.js] Delete session response:", response);
                    loadAndDisplaySessions(); // Refresh list
                    if (typeof refreshLogs === 'function') refreshLogs(); // Refresh view
                });
            }
        });
    }

    if (newSessionButton) {
        newSessionButton.addEventListener('click', () => {
            console.log("[popup.js] Requesting to start a new session for the current tab.");
            // To start a new session properly, background.js needs context of the current tab
            // We can ask background.js to start a new session for WHATEVER tab is currently active in the browser.
            chrome.runtime.sendMessage({ type: 'force_start_new_session_for_active_tab' }, response => {
                if (chrome.runtime.lastError) console.error("[popup.js] Error starting new session:", chrome.runtime.lastError.message);
                else console.log("[popup.js] Start new session response:", response);
                loadAndDisplaySessions(); // Refresh list to show the new session
                if (typeof refreshLogs === 'function') refreshLogs(); // Refresh view
            });
        });
    }

    document.getElementById('refresh-logs').addEventListener('click', () => {
        console.log('[popup.js 5.55] Refresh button clicked!');
        refreshLogs();
    });

    document.getElementById('new-session').addEventListener('click', () => {
        console.log('[popup.js 5.55] New Session button clicked!');
        startNewSession();
    });

    document.getElementById('test-inject').addEventListener('click', () => {
        console.log('[popup.js 5.55] "Inject Test Prompt" button clicked.');
        const textToInject = "Hello Gemini, this is a test injection from my extension's popup!";
        chrome.runtime.sendMessage({
            type: 'trigger_test_injection',
            promptToInject: textToInject,
            autoSubmit: true
        });
    });

    document.getElementById('save-to-disk').addEventListener('click', () => {
        console.log('[popup.js 5.55] Save to Disk button clicked!');
        if (typeof saveToDisk === 'function') saveToDisk();
    });

    refreshLogs(); // Initial load
});

// document.addEventListener('DOMContentLoaded', () => {
//     initializeUIElements(); // Function to get all your getElementById/querySelector calls
//     setupEventListeners();  // Function to attach all your button click listeners, etc.
//     loadAndDisplaySessions(); // Your function to populate the session dropdown
//     refreshLogs();          // Initial log load
// });


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'get_current_session_info_for_content_script':
            console.log(`[popup.js 5.55] [chrome.runtime.onMessage] I'm not sure why popup would care about current session info yet.`);
            break;
        case 'log_update':
        case 'session_updated':
        case 'new_chat_turn':
            console.log('[popup.js 5.55] Received update from background:', message);
            // A full refresh is safest to get continuity lines and new session state
            refreshLogs();
            break;
        case 'show_popup_notification':
            console.log('[popup.js 5.55] Received notification:', message.message);
            // For an MVP, we can use a simple alert.
            // Later, you can create a more sophisticated notification area in popup.html
            alert(message.message);
            sendResponse({ status: "Notification shown" }); // Optional: send confirmation
            // break;
            return true;
        default:
            console.log("[popup.js 5.55] Received unhandled message type:", message.type);
            // No response for this type.
            break;
    }

    // return true;
});
