//background.js v5.55

// Legacy:
// const logs = [];
// let msgCount = 0; // Message counter for debugging
try {
    importScripts('commandManager.js', 'stackerManager.js');
    console.log('[background.js v5.55] commandManager.js and stackerManager.js imported successfully.');
    // console.log('[background.js v5.55] typeof queueDetectedCommands after import:', typeof queueDetectedCommands);
    console.log('[background.js v5.55] typeof queueCommandsFromText after import:', typeof queueCommandsFromText);
    console.log('[background.js v5.55] typeof sanitizeTextForLogging after import:', typeof sanitizeTextForLogging);
} catch (e) {
    console.error('[background.js v5.55] Failed to import commandManager.js', e);
}

// === Global Tracking Variables ===
let tabStatusMap = new Map(); // Stores { tabId: 'fresh_awaiting_interaction' | 'session_assigned' | 'generic_not_fresh' | 'freshness_unknown' | 'no_llm' }
let tabIdToFreshnessMap = new Map(); // Stores { tabId: boolean (isFreshPage) }
let isAssistantCommandModeActive = false; // Default to OFF

// === Default Settings & Storage Keys ===
const STORAGE_KEY_PROJECT_YOU = 'projectYouData';
const GEMINI_URL_PATTERNS = ['https://gemini.google.com/',
    'https://gemini.google.com/app/', // Requires a chat ID after /app/
    'https://gemini.google.com/gem/',   // Requires context and often an ID after /gem/
    'https://bard.google.com/']; // Add more if needed
const GEMINI_CHAT_ID_REGEX = /\/app\/[a-zA-Z0-9_-]{10,}|gem\/[^/]+(\/[a-zA-Z0-9_-]{10,})?$/; // Matches /app/ID or /gem/context/ID

const SUPPORTED_PLATFORMS_CONFIG = {
    GEMINI: {
        id: 'gemini-chat-interface', // Matches platform ID content.js might send
        displayName: 'Gemini',
        // Base URLs to identify the site
        basePatterns: ['https://gemini.google.com/', 'https://bard.google.com/'],
        // Regex to identify a specific chat thread URL AND capture a unique chat identifier from it if possible
        // This regex should only match URLs for which a distinct session should be created/resumed.
        // Group 1 might be the app/gem part, Group 2 the specific ID.
        specificChatRegex: /^(?:https?:\/\/(?:gemini\.google\.com|bard\.google\.com))\/(app\/([a-zA-Z0-9_-]{15,})|gem\/([^/]+)(?:\/([a-zA-Z0-9_-]{10,}))?)/,
        // sample URL:
        // https://gemini.google.com/gem/coding-partner/6d0154ad373ee620
        // Example captured groups: 
        // For /app/ID: match[2] = ID
        // For /gem/CONTEXT/ID: match[3] = CONTEXT, match[4] = ID
        // For /gem/CONTEXT: match[3] = CONTEXT, match[4] = undefined
        getChatIdentifier: (match) => match[2] || match[4] || match[3] // Logic to get the unique part
    },
    CHATGPT: {
        id: 'chatgpt-interface',
        displayName: 'ChatGPT',
        basePatterns: ['https://chat.openai.com/', 'https://chatgpt.com/'], // chatgpt.com redirects
        specificChatRegex: /^https:\/\/chat(?:gpt)?\.openai\.com\/(c|chat)\/([a-zA-Z0-9_-]+)/,
        // sample URL:
        // https://chatgpt.com/g/g-p-67632850f2948191a2aa9be5272ceea0-local-llms/c/6827a484-4a14-8005-977c-13ed0757b2a6
        getChatIdentifier: (match) => match[2]
    },
    CLAUDE: {
        id: 'claude-chat-interface',
        displayName: 'Claude',
        basePatterns: ['https://claude.ai/'],
        specificChatRegex: /^https:\/\/claude\.ai\/(?:chat|new)\/([a-zA-Z0-9_-]+(?:-\w{8}-\w{4}-\w{4}-\w{4}-\w{12})?)/, // Claude IDs can be complex
        getChatIdentifier: (match) => match[1]
    }
    // Add Perplexity, etc. here later
};

function isActualGeminiChatPage(url) {
    if (!url) return false;
    // Check if it starts with a known base and also has a chat ID like structure
    if (GEMINI_URL_PATTERNS.some(pattern => url.startsWith(pattern)) && // Your existing broad check
        GEMINI_CHAT_ID_REGEX.test(url)) { // New specific check
        return true;
    }
    return false;
}

// ===== Operation: Furby! Initial State Variables =====

let isFurbyModeActive = false;
let furbyAlphaTabId = null;
let furbyBravoTabId = null;
let nextFurbyToSpeak = null; // To manage turn-taking, e.g., 'alpha' or 'bravo'

// Function to activate Furby mode (called by commandManager.js)
function activateFurbyMode(alphaId, bravoId, firstSpeaker = 'alpha') {
    furbyAlphaTabId = parseInt(alphaId, 10); // Ensure they are numbers
    furbyBravoTabId = parseInt(bravoId, 10);
    if (isNaN(furbyAlphaTabId) || isNaN(furbyBravoTabId)) {
        console.error("[Furby BG] Invalid Tab IDs for Furby Mode:", alphaId, bravoId);
        isFurbyModeActive = false;
        return false;
    }
    isFurbyModeActive = true;
    nextFurbyToSpeak = firstSpeaker; // Who starts the "relayed" conversation
    console.log(`[Furby BG] Operation: Furby ACTIVATED. Alpha: ${furbyAlphaTabId}, Bravo: ${furbyBravoTabId}. Next to speak: ${nextFurbyToSpeak}`);
    return true;
}

// Function to deactivate Furby mode (called by commandManager.js)
function deactivateFurbyMode() {
    isFurbyModeActive = false;
    furbyAlphaTabId = null;
    furbyBravoTabId = null;
    nextFurbyToSpeak = null;
    console.log("[Furby BG] Operation: Furby DEACTIVATED.");
}


// === Initialization and Session Handling ===

// We'll need a way to map tab IDs to conversation IDs if a tab hosts an ongoing, known conversation.
// This can be a simple in-memory object for now. It could be persisted in chrome.storage.local later if needed.
// the startNewSession function is looking for tabInfo or it sets it to null starting a clean session in any tab regardless of its contents
// The onStartup listener assumes every time it fires that a new session should start right now and passes no tab info
let tabIdToConversationIdMap = new Map(); // In-memory cache for quick tabId -> conversationId lookup
let pendingUserInputs = {}; // Key: conversationId (which is currentSessionId), Value: userMessagePayload
let pendingSessionCreations = new Map(); // store an sessions that are off in Promise land

function getLLMPlatformAndChatDetails(url) {
    if (!url) return null;

    for (const platformKey in SUPPORTED_PLATFORMS_CONFIG) {
        const config = SUPPORTED_PLATFORMS_CONFIG[platformKey];
        // Check if the URL belongs to this platform's domain
        if (config.basePatterns.some(pattern => url.startsWith(pattern))) {
            // Now check if it's a specific chat thread URL for this platform
            const match = config.specificChatRegex.exec(url);
            if (match) {
                const chatIdentifier = config.getChatIdentifier(match) || 'unknown_chat_id';
                console.log(`[background.js 5.55] [getLLMPlatformAndChatDetails] Detected platform: ${config.displayName}, Identifier: ${chatIdentifier} for URL: ${url}`);
                return {
                    platformId: config.id,          // e.g., 'gemini-chat-interface'
                    displayName: config.displayName,    // e.g., 'Gemini'
                    isSpecificChat: true,           // Yes, this URL points to a specific chat
                    chatIdentifier: chatIdentifier,     // The unique ID for this chat on this platform
                    fullUrl: url                    // The full URL that matched
                };
            } else {
                // It's a page on a supported LLM site, but not a specific chat thread URL
                // (e.g., could be gemini.google.com/app without a chat ID)
                return {
                    platformId: config.id,
                    displayName: config.displayName,
                    isSpecificChat: false, // Not specific enough to start a new session for
                    chatIdentifier: null,
                    fullUrl: url
                };
            }
        }
    }
    return null; // Not a supported LLM platform page we recognize
}

function isTargetLLMPage(url) {
    if (!url) return false;
    return GEMINI_URL_PATTERNS.some(pattern => url.startsWith(pattern));
    // this might not be specific enough. It might match partial URLs or other pages that start with these patterns.
}

// Function to get initial data from storage or set defaults
async function getProjectData() {
    return new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_KEY_PROJECT_YOU], (result) => {
            if (chrome.runtime.lastError) {
                console.error("Error getting project data:", chrome.runtime.lastError.message);
                // Resolve with default structure in case of error to prevent downstream issues
                resolve({
                    currentSessionId: null,
                    previousSessionId: null,
                    userSettings: { preferredTimeZone: 'America/Los_Angeles', nickname: 'User' },
                    sessions: {}
                });
                return;
            }
            const data = result[STORAGE_KEY_PROJECT_YOU];
            if (data && data.sessions && data.userSettings) { // Basic validation
                resolve(data);
            } else {
                // Initialize with default structure
                const defaultData = {
                    currentSessionId: null,
                    previousSessionId: null,
                    userSettings: { preferredTimeZone: 'America/Los_Angeles', nickname: 'User' },
                    sessions: {}
                };
                chrome.storage.local.set({ [STORAGE_KEY_PROJECT_YOU]: defaultData }, () => {
                    console.log('[background.js] Project-You data initialized in storage.');
                    resolve(defaultData);
                });
            }
        });
    });
}

async function resolveSessionForTab(tab, projectData, options = { createIfNotFound: true }) {
    const platformDetails = getLLMPlatformAndChatDetails(tab.url);
    const isFreshPage = tabIdToFreshnessMap.get(tab.id);

    console.log(`✨✨✨ [resolveSessionForTab V3] For TabID: ${tab.id}, URL: ${tab.url}, CreateOpt: ${options.createIfNotFound}`);
    console.log(`[resolveSessionForTab V3] PlatformDetails:`, platformDetails ? JSON.parse(JSON.stringify(platformDetails)) : null, `IsFreshPage: ${isFreshPage}`);

    let decisionType = 'unknown';
    let sessionStartedNow = false;
    let sessionIdToMakeActive = null; // This is the ID of a session if one is found/created FOR THIS SPECIFIC TAB'S content.
    // It's NOT necessarily what projectData.currentSessionId will become.
    let resolvedPlatformId = platformDetails ? platformDetails.platformId : null;

    if (!platformDetails) {
        decisionType = 'no_llm_page';
        tabStatusMap.set(tab.id, 'no_llm');
        console.log(`[SESSION_TRACE V3 resolveSessionForTab] Tab ${tab.id} is not an LLM page.`);
        return { projectData, sessionIdToMakeActive: null, sessionStartedNow: false, decisionType, platformId: null };
    }

    // Scenario A: URL is for a specific chat thread
    if (platformDetails.isSpecificChat) {
        console.log(`[SESSION_TRACE V3 resolveSessionForTab] Tab ${tab.id} URL ${tab.url} IS a specific chat page for ${platformDetails.displayName}.`);

        // A1: Check in-memory map FIRST for a fully matching and existing session.
        const mappedConvId = tabIdToConversationIdMap.get(tab.id);
        if (mappedConvId) {
            const mappedSession = projectData.sessions[mappedConvId];
            if (mappedSession && mappedSession.metadata.initiatingUrl === tab.url && mappedSession.metadata.platform === platformDetails.platformId) {
                decisionType = 'specific_url_match_tab_map';
                sessionIdToMakeActive = mappedConvId;
                tabStatusMap.set(tab.id, 'session_assigned');
                console.log(`[SESSION_TRACE V3] Found fully matching session ${sessionIdToMakeActive} via tabIdToConversationIdMap.`);
                // This is a clean match, we can return immediately.
                return { projectData, sessionIdToMakeActive, sessionStartedNow: false, decisionType, platformId: resolvedPlatformId };
            }
        }

        // A2: Search stored sessions for a session matching this specific URL.
        let foundSessionId = null;
        let foundSessionStatus = null;
        for (const sessionIdLoop in projectData.sessions) {
            const session = projectData.sessions[sessionIdLoop];
            if (session.metadata && session.metadata.initiatingUrl === tab.url && session.metadata.platform === platformDetails.platformId) {
                foundSessionId = sessionIdLoop;
                foundSessionStatus = session.metadata.status;
                break;
            }
        }

        if (foundSessionId) {
            decisionType = (foundSessionStatus === "active") ? 'specific_url_match_storage' : 'specific_url_match_storage_revivable';
            sessionIdToMakeActive = foundSessionId;
            tabIdToConversationIdMap.set(tab.id, sessionIdToMakeActive);
            tabStatusMap.set(tab.id, 'session_assigned');
            console.log(`[SESSION_TRACE V3] Found session ${sessionIdToMakeActive} by URL in storage.`);
        } else if (options.createIfNotFound) {
            // A3: No session found. Attempt to create one, protected by a lock.
            const pendingKey = `${tab.id}_${tab.url}`;
            if (pendingSessionCreations.has(pendingKey)) {
                // A lock is already held by another process for this exact tab+url. Do not create a duplicate.
                decisionType = 'specific_url_creation_pending';
                console.warn(`[SESSION_TRACE V3] Creation for ${pendingKey} is already pending. Aborting duplicate creation.`);
                sessionIdToMakeActive = null; // Ensure we don't return a session ID
            } else {
                // No lock, so we acquire it and proceed with creation.
                pendingSessionCreations.set(pendingKey, true); // --- LOCK ACQUIRED ---
                try {
                    decisionType = 'specific_url_created';
                    console.log(`[SESSION_TRACE V3 resolveSessionForTab] No existing session for specific chat URL ${tab.url}. Creating new distinct session.`);
                    const tabInfo = { tabId: tab.id, windowId: tab.windowId, url: tab.url };

                    const sessionCreationResult = await startNewSession(projectData, platformDetails.platformId, tabInfo, { setAsCurrentGlobal: false });

                    projectData = sessionCreationResult.updatedProjectData;
                    sessionIdToMakeActive = sessionCreationResult.createdSessionId;
                    sessionStartedNow = true;

                    tabStatusMap.set(tab.id, 'session_assigned');
                    console.log(`[SESSION_TRACE V3] New distinct session ${sessionIdToMakeActive} created for specific URL ${tab.url}.`);

                } catch (error) {
                    console.error(`[SESSION_TRACE V3] Error during session creation process:`, error);
                    // In case of error, ensure no session is returned as active
                    sessionIdToMakeActive = null;
                    sessionStartedNow = false;
                } finally {
                    pendingSessionCreations.delete(pendingKey); // --- LOCK RELEASED ---
                    console.log(`[SESSION_TRACE V3] Lock for ${pendingKey} released.`);
                }
            }
        } else {
            decisionType = 'specific_url_not_found_no_create';
            tabStatusMap.delete(tab.id);
        }
        // if we reach this spot we found a session or created one.
        if (sessionIdToMakeActive) {
            console.log(`[SESSION_TRACE V3 resolveSessionForTab] Specific URL: Resolved to session ${sessionIdToMakeActive}. Decision: ${decisionType}`);
        } else {
            console.log(`[SESSION_TRACE V3 resolveSessionForTab] Specific URL: No session resolved. Decision: ${decisionType}`);
        }
    }
    // Scenario B: URL is generic (not a specific chat thread)
    else { // platformDetails.isSpecificChat === false
        console.log(`[SESSION_TRACE V3 resolveSessionForTab] Tab ${tab.id} URL ${tab.url} is a GENERIC page for ${platformDetails.displayName}. Freshness: ${isFreshPage}`);
        sessionIdToMakeActive = null; // Generic pages don't get their own session *from this function*.
        // They either inherit global, or await interaction.

        if (isFreshPage === true) {
            decisionType = 'fresh_page_awaits_interaction';
            tabStatusMap.set(tab.id, 'fresh_awaiting_interaction');
            tabIdToConversationIdMap.delete(tab.id); // Explicitly no specific session for this tab yet
            console.log(`[SESSION_TRACE V3 resolveSessionForTab] Generic fresh page TabID ${tab.id}. Status set to 'fresh_awaiting_interaction'.`);
        } else if (isFreshPage === false) {
            decisionType = 'generic_url_not_fresh_no_action';
            tabStatusMap.set(tab.id, 'generic_not_fresh');
            console.log(`[SESSION_TRACE V3 resolveSessionForTab] Generic URL ${tab.url} for TabID ${tab.id} is NOT fresh. No session assignment action by resolveSessionForTab.`);
        } else { // isFreshPage is undefined
            decisionType = 'generic_url_freshness_unknown';
            tabStatusMap.set(tab.id, 'freshness_unknown');
            console.log(`[SESSION_TRACE V3 resolveSessionForTab] Generic URL ${tab.url} for TabID ${tab.id}, freshness unknown. No session assignment action.`);
        }
    }

    return { projectData, sessionIdToMakeActive, sessionStartedNow, decisionType, platformId: resolvedPlatformId };
}

async function startNewSession(projectData, platform = 'unknown', tabInfo = null, options = { setAsCurrentGlobal: true }) {
    const newSessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const oldGlobalSessionId = projectData.currentSessionId;
    console.log(` ✨✨✨  [startNewSession V4] Creating NEW Session ID: ${newSessionId} for platform: ${platform}`, tabInfo || "(No tab info)", `SetAsGlobal: ${options.setAsCurrentGlobal}`);

    // Ensure projectData.sessions exists
    if (!projectData.sessions) {
        console.warn("[startNewSession V4] projectData.sessions was undefined. Initializing.");
        projectData.sessions = {};
    }

    // 1. Create the new session object directly within the passed projectData.sessions
    projectData.sessions[newSessionId] = {
        metadata: {
            startedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            endedAt: null,
            platform: platform,
            title: (tabInfo && tabInfo.url && new URL(tabInfo.url).hostname) ? `Session for ${new URL(tabInfo.url).hostname} (${platform})` : `Session ${newSessionId.substring(0, 12)} (${platform})`,
            initiatingUrl: tabInfo ? tabInfo.url : null,
            initialTabId: tabInfo ? tabInfo.tabId : null,
            status: "active",
        },
        logEntries: [],
        stackerProcessingBuffer: [],
        stackerChunks: []
    };

    // 2. Map the initiating tab (if any) to this new session ID
    if (tabInfo && tabInfo.tabId) {
        tabIdToConversationIdMap.set(tabInfo.tabId, newSessionId);
        console.log(`[startNewSession V4] Mapped tabId ${tabInfo.tabId} to new session ${newSessionId}`);
    }

    // 3. Initialize Stacker for the new session
    if (projectData.sessions[newSessionId]) {
        initializeStackerForSession(projectData.sessions[newSessionId]);
    } else {
        console.error(`[startNewSession V4] Session object for ${newSessionId} not found before Stacker initialization!`);
    }

    // 4. Handle global session changes and notifications
    if (options.setAsCurrentGlobal) {
        console.log(`[startNewSession V4] Setting ${newSessionId} as the NEW GLOBAL current session. Old global was: ${oldGlobalSessionId || 'null'}`);
        if (oldGlobalSessionId && projectData.sessions[oldGlobalSessionId] && projectData.sessions[oldGlobalSessionId].metadata) {
            projectData.sessions[oldGlobalSessionId].metadata.status = "inactive";
            projectData.sessions[oldGlobalSessionId].metadata.endedAt = new Date().toISOString();
        }
        projectData.previousSessionId = oldGlobalSessionId;
        projectData.currentSessionId = newSessionId;
        chrome.runtime.sendMessage({
            type: 'session_updated',
            newSessionId: projectData.currentSessionId,
            previousSessionId: projectData.previousSessionId,
            logsCleared: true
        }).catch(err => console.warn(`[startNewSession V4] Error sending session_updated (new global) to popup: ${err.message}`));
        if (tabInfo && tabInfo.tabId) {
            chrome.tabs.sendMessage(tabInfo.tabId, {
                type: 'current_session_id_update',
                currentSessionId: projectData.currentSessionId,
                associatedUrl: tabInfo.url
            }).catch(err => console.warn(`[startNewSession V4] Could not send session update (new global) to tab ${tabInfo.tabId}: ${err.message}`));
        }
    } else {
        console.log(`[startNewSession V4] Created new DISTINCT session ${newSessionId}. Global current remains: ${projectData.currentSessionId || 'null'}`);
        chrome.runtime.sendMessage({
            type: 'session_updated',
            newSessionId: projectData.currentSessionId,
            previousSessionId: projectData.previousSessionId,
            logsCleared: false,
        }).catch(err => console.warn(`[startNewSession V4] Error sending session_updated (distinct created) to popup: ${err.message}`));
        if (tabInfo && tabInfo.tabId) {
            chrome.tabs.sendMessage(tabInfo.tabId, {
                type: 'current_session_id_update',
                currentSessionId: newSessionId,
                associatedUrl: tabInfo.url
            }).catch(err => console.warn(`[startNewSession V4] Could not send session update (distinct session) to tab ${tabInfo.tabId}: ${err.message}`));
        }
    }

    // 5. Save projectData immediately
    try {
        await saveProjectData(projectData);
        console.log(`[startNewSession V4] projectData saved successfully after creating/modifying session ${newSessionId}.`);
    } catch (error) {
        console.error(`[startNewSession V4] CRITICAL: Failed to save projectData after creating/modifying session ${newSessionId}:`, error);
    }

    return { createdSessionId: newSessionId, updatedProjectData: projectData };
}

// Function to save the entire project data object back to storage
async function saveProjectData(projectData) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [STORAGE_KEY_PROJECT_YOU]: projectData }, () => {
            if (chrome.runtime.lastError) {
                console.error("Error saving project data:", chrome.runtime.lastError.message);
                reject(chrome.runtime.lastError);
            } else {
                // console.log('[background.js] Project data saved.'); // Can be noisy
                resolve();
            }
        });
    });
}

async function ensureTabIsInitialized(tab, platformDetails, projectData) {
    console.log(`[HotLoad BG] Ensuring Tab ID: ${tab.id} (Platform: ${platformDetails.displayName}) is initialized.`);

    try {
        await new Promise((resolve, reject) => {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js'] // Your main content script
            }, (results) => {
                if (chrome.runtime.lastError) {
                    console.warn(`[HotLoad BG] executeScript for Tab ${tab.id} (${platformDetails.displayName}): ${chrome.runtime.lastError.message || 'No results (might be okay if already injected or protected page).'}`);
                } else {
                    console.log(`[HotLoad BG] Script executed/ensured in tab ${tab.id} (${platformDetails.displayName}).`);
                }
                resolve();
            });
        });

        // --- NEW: Send the ping message AFTER trying to execute the script ---
        console.log(`[HotLoad BG] Sending 'ping_sync_session' to Tab ID: ${tab.id}`);
        try {
            const response = await chrome.tabs.sendMessage(tab.id, {
                type: "ping_sync_session", // Let's call it this for clarity
                platformDetails: platformDetails, // Send platform details for context
                tabUrl: tab.url // Send current URL for context
            });
            console.log(`[HotLoad BG] Response from content.js ping (Tab ID ${tab.id}):`, response);
        } catch (e) {
            // This catch is important because if content.js isn't there or isn't listening, sendMessage will throw an error.
            console.warn(`[HotLoad BG] Could not send 'ping_sync_session' to Tab ID ${tab.id} or it didn't respond. Content script might not be active/listening yet. Error: ${e.message}`);
        }

    } catch (e) {
        console.error(`[HotLoad BG] Error in ensureTabIsInitialized for Tab ${tab.id}:`, e);
    }

    return projectData; // projectData isn't modified here directly, but kept for consistent function signature
}

/**
 * Ensures content.js is active in a given tab.
 * After content.js is confirmed/made active, it should send a message 
 * (e.g., 'content_script_ready' or 'content_script_page_status')
 * back to background.js, which will then trigger resolveSessionForTab.
 * @param {chrome.tabs.Tab} tab - The tab object to process.
 */
async function ensureContentScriptActive(tab) {
    console.log(`[HotLoad BG] Ensuring content script is active for Tab ID: ${tab.id}, URL: ${tab.url}`);
    try {
        await new Promise((resolve, reject) => {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js'] // Your main content script file
            }, (results) => {
                if (chrome.runtime.lastError) {
                    console.warn(`[HotLoad BG] executeScript for Tab ${tab.id}: ${chrome.runtime.lastError.message || 'No results (content.js might already be active, or this is a protected page).'}`);
                    // Resolve even if there's an error, as content script might be there.
                    // The 'ping' or content_script_ready message will confirm.
                } else {
                    console.log(`[HotLoad BG] Script executed/ensured in tab ${tab.id}.`);
                }
                resolve();
            });
        });

        // Optional: Send a ping to ensure it's responsive and trigger its re-sync if needed.
        // content.js would need a listener for 'ping_sync_session_hotload'
        console.log(`[HotLoad BG] Attempting to ping Tab ID: ${tab.id} for session sync.`);
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: "ping_sync_session_hotload" });
            console.log(`[HotLoad BG] Ping/sync response from Tab ID ${tab.id}:`, response);
        } catch (e) {
            console.warn(`[HotLoad BG] Could not ping Tab ID ${tab.id}. Content script might not be listening yet or tab closed. Error: ${e.message}`);
        }

    } catch (e) {
        console.error(`[HotLoad BG] Error in ensureContentScriptActive for Tab ${tab.id}:`, e);
    }
}

/**
 * Finds all open, supported LLM tabs and ensures their content scripts are active.
 * Relies on content.js sending a message back (e.g. 'content_script_page_status')
 * which will then trigger resolveSessionForTab for each tab.
 */
async function initializeOpenLlmTabs() {
    console.log('[HotLoad BG] Initializing/Checking all open LLM tabs...');
    const allOpenTabs = await new Promise(resolve => chrome.tabs.query({ status: "complete" }, resolve));

    if (allOpenTabs && allOpenTabs.length > 0) {
        console.log(`[HotLoad BG] Found ${allOpenTabs.length} completed tabs. Identifying LLM tabs.`);
        for (const tab of allOpenTabs) {
            if (tab.id && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
                const platformDetails = getLLMPlatformAndChatDetails(tab.url); // Using your function
                if (platformDetails) {
                    console.log(`[HotLoad BG] Found supported LLM tab: ID ${tab.id} - ${platformDetails.displayName}. Ensuring content script is active.`);
                    await ensureContentScriptActive(tab); // This makes content.js run/re-run
                    // content.js will then send its 'ready' message, which your background.js already listens for
                    // and uses to call resolveSessionForTab and update projectData.
                }
            }
        }
    } else {
        console.log('[HotLoad BG] No relevant open tabs found to initialize.');
    }
    // Note: projectData is not directly modified and returned here.
    // Session resolution and projectData updates happen when content.js messages back.
}

// --- Event Listeners ---
chrome.runtime.onStartup.addListener(async () => {
    console.log("[HotLoad onStartup] Browser startup detected.");
    // The IIFE will also run on startup, so initializeOpenLlmTabs will be called.
    // You might just log here or do minimal browser-startup-specific tasks if the IIFE handles most init.
    // For safety, calling it again won't hurt, or ensure IIFE covers all startup needs.
    await initializeOpenLlmTabs();
    console.log("[HotLoad onStartup] Open LLM tab initialization attempted.");
});

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[HotLoad onInstalled] Extension event (reason: ${details.reason}).`);
    await initializeOpenLlmTabs(); // Crucial for updates to re-connect to existing tabs

    if (details.reason === 'install') {
        console.log('[HotLoad onInstalled] First install. Priming Stacker/Logs...');
        let projectData = await getProjectData(); // Get fresh projectData

        // Example: Create a "Welcome" exchange
        const welcomeUserInput = { fullText: "Hello Project-You!", timestamp_user_prompt: new Date().toISOString(), platform: "system_init" };
        const welcomeAssistantOutput = { fullText: "Welcome to Project-You! Your personal AI memory is now active.", timestamp_assistant_response_start: new Date().toISOString(), timestamp_assistant_response_complete: new Date().toISOString(), platform: "system_init" };

        // Create a temporary session ID for this initial chunk or a general init session
        const initSessionId = `session-${Date.now()}-init`;
        if (!projectData.sessions[initSessionId]) {
            // Minimal session object for the chunk
            projectData.sessions[initSessionId] = {
                id: initSessionId,
                logEntries: [],
                metadata: { platform: 'system_init', startedAt: new Date().toISOString() }
            };
        }

        projectData = await createAndLogExchangeChunk(welcomeUserInput, welcomeAssistantOutput, projectData, initSessionId);
        // The chunk is now in projectData.sessions[initSessionId].logEntries
        // Now get that specific chunk and send it to Eddie for daily logging
        const newChunk = projectData.sessions[initSessionId].logEntries[0];
        if (newChunk) {
            await sendChunkToEddieForDailyLogging(newChunk);
        }

        // Prime the Stacker by calling load-today (or an internal equivalent)
        // This is tricky as background.js can't run 'curl'.
        // You'd need to replicate the /load-today logic here or have Eddie do it on first log.
        // For now, let's assume Eddie's /load-today will be called by the user or a dashboard action first time.
        console.log("[HotLoad onInstalled] 'Welcome' exchange logged. User should run 'load today' on Stacker via UI/curl for first use.");

        await saveProjectData(projectData);
    }
    console.log("[HotLoad onInstalled] processing complete.");
});

// //    if (tabIdToConversationIdMap.has('tabID'))???
// // On extension startup (or when service worker wakes up)
// chrome.runtime.onStartup.addListener(async () => {
//     console.log("[background.js 5.55] onStartup event.");
//     const targetPatterns = ["*://gemini.google.com/app/*", "*://claude.ai/chat/*" /*, etc. */];
//     let projectData = await getProjectData();
//     // For simplicity on browser restart, we'll start a new session,
//     // but the previous one is preserved.
//     // More sophisticated logic could try to resume based on open tabs.
//     projectData = await startNewSession(projectData, 'startup'); // *** this needs to send tabInfo now! Or it will be null!
//     // IIFE takes care of this anyway.
//     console.log("[background.js] onStartup completed. New session started.");
// });

// --- IIFE (Runs when service worker starts/wakes up FOR ANY REASON, including install/update/browser start) ---
(async () => {
    console.log("✨✨✨ [INIT IIFE] Background script IIFE starting/re-initializing...");
    await initializeOpenLlmTabs(); // Process all existing relevant tabs

    // Then, specifically focus on the *currently active tab* if one exists,
    // to ensure its session is set as projectData.currentSessionId.
    // Much of your existing IIFE logic for handling the active tab and default sessions is good.
    // The key is that initializeOpenLlmTabs has already "woken up" content.js in all relevant tabs.

    let projectData = await getProjectData(); // Get current state AFTER tabs might have reported in
    const activeTabs = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

    if (activeTabs && activeTabs[0]) {
        const activeTabForStartup = activeTabs[0];
        console.log(`✨✨✨ [INIT IIFE] Focusing on initially active tab ID ${activeTabForStartup.id}, URL: ${activeTabForStartup.url}`);
        // resolveSessionForTab should now find an existing session if initializeOpenLlmTabs worked,
        // or create one if it's a new LLM page.
        const result = await resolveSessionForTab(activeTabForStartup, projectData, { createIfNotFound: true });
        projectData = result.projectData;
        if (result.sessionIdToMakeActive) {
            projectData.currentSessionId = result.sessionIdToMakeActive;
            console.log(`✨✨✨ [INIT IIFE] Active tab session set to: ${projectData.currentSessionId}.`);
        } else {
            console.log(`✨✨✨ [INIT IIFE] Active tab did not resolve to a session to make active. Current session: ${projectData.currentSessionId}`);
        }
    } else {
        console.log("✨✨✨ [INIT IIFE] No single active tab found at IIFE execution.");
    }

    // Ensure a default session if needed, AFTER processing active and all other tabs
    if (!projectData.currentSessionId || !projectData.sessions[projectData.currentSessionId]) {
        console.log("✨✨✨ [INIT IIFE] No valid current session. Starting default session.");
        const sessionCreationResult = await startNewSession(projectData, 'initialization_default_final_check');
        projectData = sessionCreationResult.updatedProjectData;
        // currentSessionId should be set by startNewSession if options.setAsCurrentGlobal is true (which is default)
        console.log(`✨✨✨ [INIT IIFE] Default session started: ${projectData.currentSessionId}`);
    }

    await saveProjectData(projectData);
    console.log("✨✨✨ [INIT IIFE] Initialization complete. Final currentSessionId:", projectData.currentSessionId);
})();

// IIFE for initialization of the background script on extension load or re-initialization

// (async () => {
//     console.log("✨✨✨ [INIT] Background script starting/re-initializing...");
//     let projectData = await getProjectData();
//     let activeTabForStartup = null;
//     let result = null; // <--- Declare 'result' here with a default value

//     try {
//         // Attempt to get the currently active tab in the current window
//         const activeTabs = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
//         if (activeTabs && activeTabs[0]) {
//             activeTabForStartup = activeTabs[0];
//             console.log(`✨✨✨ [INIT] Startup: Initially active tab is ID ${activeTabForStartup.id}, URL: ${activeTabForStartup.url}`);
//         } else {
//             console.log("✨✨✨ [INIT] Startup: No single active tab found (e.g., browser starting, or no focused window).");
//         }
//     } catch (e) {
//         console.error("✨✨✨ [INIT] Startup: Error querying for active tab:", e);
//     }

//     if (activeTabForStartup) {
//         // 'result' will be assigned the return value of resolveSessionForTab
//         result = await resolveSessionForTab(activeTabForStartup, projectData, { createIfNotFound: true });
//         projectData = result.projectData;

//         if (result.sessionIdToMakeActive) {
//             projectData.currentSessionId = result.sessionIdToMakeActive;
//             if (!result.sessionStartedNow && projectData.sessions[result.sessionIdToMakeActive]?.metadata) {
//                 projectData.sessions[result.sessionIdToMakeActive].metadata.lastActivityAt = new Date().toISOString();
//             }
//             console.log(`✨✨✨ [INIT] Startup: Session for active tab ${activeTabForStartup.id} resolved to: ${projectData.currentSessionId}. Decision: ${result.decisionType}`);
//         } else {
//             // No session resolved for the active tab by resolveSessionForTab, and none was created by it.
//             if (!projectData.currentSessionId || !projectData.sessions[projectData.currentSessionId]) {
//                 console.log("✨✨✨ [INIT] Startup: No session resolved for active tab and no valid global session. Starting default session.");
//                 //                                                                      vvvvvv <--- 'result' is available here
//                 const platformForDefault = result.platformId || 'initialization_default_no_active_llm_tab';
//                 const tabInfoForDefault = activeTabForStartup ? { tabId: activeTabForStartup.id, url: activeTabForStartup.url, windowId: activeTabForStartup.windowId } : null;
//                 // projectData = await startNewSession(projectData, platformForDefault, tabInfoForDefault);
//                 const sessionCreationResult1 = await startNewSession(projectData, platformForDefault, tabInfoForDefault); // Defaults to { setAsCurrentGlobal: true }
//                 projectData = sessionCreationResult1.updatedProjectData; // Reassign projectData

//                 // projectData.currentSessionId is now sessionCreationResult1.createdSessionId

//                 // console.log(`✨✨✨ [INIT] Startup: Default session started: ${projectData.currentSessionId}`);
//                 if (projectData === null || projectData === undefined) {
//                     console.warn("🚨🚨🚨🚨🚨🚨 [INIT] CRITICAL: Project data or session creation failed. projectData or sessions is null/undefined after startNewSession.");
//                 } else {
//                     // console.dir(projectData);
//                     console.log(`✨✨✨ [INIT] Startup: Default session started: ${projectData.createdSessionId}`);
//                 }
//             } else {
//                 //                                                                                                                            v-- 'result' is available here
//                 console.log(`✨✨✨ [INIT] Startup: Active tab ${activeTabForStartup.id} did not resolve to a session. Retaining existing global currentSessionId: ${projectData.currentSessionId}. Decision: ${result.decisionType}`);
//             }
//         }
//     } else if (!projectData.currentSessionId || !projectData.sessions[projectData.currentSessionId]) {
//         // No active tab found at startup, AND no valid currentSessionId from storage. Start a default session.
//         console.log("✨✨✨ [INIT] Startup: No active tab and no valid current session from storage. Starting default session.");
//         // projectData = await startNewSession(projectData, 'initialization_no_active_tab');
//         const sessionCreationResult2 = await startNewSession(projectData, platformForDefault, tabInfoForDefault); // Defaults to { setAsCurrentGlobal: true }
//         projectData = sessionCreationResult2.updatedProjectData; // Reassign projectData
//         // projectData.currentSessionId is now sessionCreationResult1.createdSessionId

//         // 'result' remains null in this branch, which is fine for the final 'if' condition.
//     } else {
//         // No active tab, but a valid currentSessionId was loaded from storage. Maintain it.
//         console.log(`✨✨✨ [INIT] Startup: No active tab. Maintaining loaded currentSessionId from storage: ${projectData.currentSessionId}`);
//         if (projectData.sessions[projectData.currentSessionId]?.metadata) { // Check if session and metadata exist
//             projectData.sessions[projectData.currentSessionId].metadata.lastActivityAt = new Date().toISOString();
//         }
//         // 'result' remains null in this branch.
//     }

//     // ... (ensure Stacker for currentSession - this needs currentSessionId to be set) ...
//     if (projectData.currentSessionId && projectData.sessions[projectData.currentSessionId]) {
//         const sessionToInitialize = projectData.sessions[projectData.currentSessionId];
//         if (!sessionToInitialize.metadata) { // Defensive check
//             console.warn(`✨✨✨ [INIT] Current session ${projectData.currentSessionId} missing metadata. Initializing basic metadata.`);
//             sessionToInitialize.metadata = {
//                 startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), status: "active",
//                 platform: "unknown_init_metadata_fix", title: `Session ${projectData.currentSessionId}`
//             };
//         }
//         if (typeof initializeStackerForSession === 'function') {
//             initializeStackerForSession(sessionToInitialize);
//         }
//     } else {
//         console.error(`✨✨✨ [INIT] CRITICAL: Could not establish a valid currentSessionId for Stacker initialization. Value: ${projectData.currentSessionId}`);
//     }


//     // Inform the initially active tab's content script
//     // The condition `&& result && result.platformId` will now correctly short-circuit if 'result' is null.
//     //                                                                      vvvvvv
//     if (activeTabForStartup && activeTabForStartup.id && projectData.currentSessionId && result && result.platformId) {
//         console.log(`✨✨✨ [INIT] Sending initial session_id_update to active tab ${activeTabForStartup.id}: ${projectData.currentSessionId}`);
//         chrome.tabs.sendMessage(activeTabForStartup.id, {
//             type: 'current_session_id_update',
//             currentSessionId: projectData.currentSessionId,
//             associatedUrl: activeTabForStartup.url
//         }).catch(err => console.warn(`[SESSION_TRACE Init] Could not send initial session ID to active tab ${activeTabForStartup.id}: ${err.message}`));
//     }

//     await saveProjectData(projectData);
//     console.log("✨✨✨ [INIT] Initialization complete. Final currentSessionId:", projectData.currentSessionId);

// })();

async function handleSaveLogToDisk(projectData) { // The new dedicated function
    if (!projectData || !projectData.currentSessionId || !projectData.sessions[projectData.currentSessionId]) {
        console.error('[background.js] Save to disk: No current session data found.');
        return { success: false, error: 'No current session data found.' };
    }

    const currentSession = projectData.sessions[projectData.currentSessionId];
    const logsToSave = currentSession.logEntries;
    const sessionMetadata = currentSession.metadata;
    const userSettings = projectData.userSettings || { preferredTimeZone: 'America/Los_Angeles' }; // Default if not set

    let sessionTitleForFile = sessionMetadata.title || projectData.currentSessionId;
    if (sessionTitleForFile === `Session started ${new Date(sessionMetadata.startedAt).toLocaleDateString()}`) {
        sessionTitleForFile = projectData.currentSessionId;
    }
    // Ensure sessionTitleForFile is a string before calling replace
    sessionTitleForFile = String(sessionTitleForFile);

    const sanitizedTitle = sessionTitleForFile.replace(/[\s:/\\?%*|"<>]/g, '_');

    const now = new Date();
    const timestampForFile = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

    const filename = `heartbeat_session_${sanitizedTitle}_${timestampForFile}.txt`;

    const logString = logsToSave.map(chunk => { // 'chunk' here is an exchangeChunk or an old log entry
        let formattedChunkOutput = "";
        const localUserSettings = userSettings || { preferredTimeZone: 'America/Los_Angeles' };

        // Check if it's our new exchangeChunk format
        if (chunk.chunk_id && chunk.type === "exchange") {
            // --- Chunk-level metadata ---
            formattedChunkOutput += `====================================\n`;
            formattedChunkOutput += `Chunk ID: ${chunk.chunk_id}\n`;
            // formattedChunkOutput += `Conversation ID: ${chunk.conversation_id}\n`;
            formattedChunkOutput += `Conversation ID: ${chunk.conversationId}\n`;
            formattedChunkOutput += `Parent Chunk ID: ${chunk.parent_chunk_id || 'N/A'}\n`;
            formattedChunkOutput += `Turn in Conversation: ${chunk.turn_in_conversation}\n`;
            formattedChunkOutput += `LLM Provider: ${chunk.source_llm_provider || 'N/A'}\n`;
            formattedChunkOutput += `LLM Model Approx: ${chunk.source_llm_model_approx || 'N/A'}\n`;

            if (chunk.extension_capture_metadata) {
                formattedChunkOutput += `Origin App: ${chunk.data_origin_app || 'N/A'} (v${chunk.extension_capture_metadata.extension_version || 'N/A'})\n`;
                formattedChunkOutput += `Capture Method: ${chunk.extension_capture_metadata.capture_method || 'N/A'}\n`;
                formattedChunkOutput += `Browser: ${chunk.extension_capture_metadata.browser_name_at_capture || 'N/A'} | WinID: ${chunk.extension_capture_metadata.window_id_at_capture || 'N/A'} | TabID: ${chunk.extension_capture_metadata.tab_id_at_capture || 'N/A'}\n`;
                formattedChunkOutput += `URL: ${chunk.extension_capture_metadata.url_at_capture || 'N/A'}\n`;
            }

            const tokens = chunk.initial_semantic_tokens && chunk.initial_semantic_tokens.length > 0
                ? chunk.initial_semantic_tokens.join(', ')
                : 'N/A';
            formattedChunkOutput += `Semantic Tokens: ${tokens}\n`;
            formattedChunkOutput += `Notes: ${chunk.notes || 'N/A'}\n`;
            formattedChunkOutput += `Custom Fields: ${chunk.custom_fields ? JSON.stringify(chunk.custom_fields) : 'N/A'}\n`;
            formattedChunkOutput += `------------------------------------\n`;

            // --- User Input Part ---
            if (chunk.user_input && typeof chunk.user_input.raw_text === 'string') {
                let userTimestampStr = chunk.timestamp_user_prompt;
                try {
                    userTimestampStr = new Date(chunk.timestamp_user_prompt).toLocaleString('en-US', {
                        timeZone: localUserSettings.preferredTimeZone,
                        year: 'numeric', month: 'short', day: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                    });
                } catch (e) { /* use ISO string as fallback */ }

                const userContent = (chunk.user_input.raw_text || "").replace(/\n/g, '\n\n'); // Double newlines for readability
                const userDomId = chunk.user_input.raw_source_details?.dom_id || 'N/A';

                formattedChunkOutput += `[${userTimestampStr}] (user on ${chunk.source_llm_provider || 'N/A'}):\n`;
                formattedChunkOutput += `User DOM ID: ${userDomId}\n`;
                formattedChunkOutput += `${userContent}\n------------------------------------\n`;
            }

            // --- Assistant Response Part ---
            if (chunk.assistant_response && typeof chunk.assistant_response.raw_text === 'string') {
                let assistantTimestampStr = chunk.timestamp_assistant_response_complete;
                try {
                    assistantTimestampStr = new Date(chunk.timestamp_assistant_response_complete).toLocaleString('en-US', {
                        timeZone: localUserSettings.preferredTimeZone,
                        year: 'numeric', month: 'short', day: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                    });
                } catch (e) { /* use ISO string as fallback */ }

                const assistantContent = (chunk.assistant_response.raw_text || "").replace(/\n/g, '\n\n');
                const assistantDomId = chunk.assistant_response.raw_source_details?.dom_id || 'N/A';
                const platform = chunk.source_llm_provider || 'N/A';

                formattedChunkOutput += `[${assistantTimestampStr}] (assistant on ${platform}):\n`;
                formattedChunkOutput += `Assistant DOM ID: ${assistantDomId}\n`;
                formattedChunkOutput += `${assistantContent}\n====================================\n\n`; // End of chunk
            }
        } else if (chunk.role && typeof chunk.content !== 'undefined' && chunk.timestamp) {
            // --- Fallback for Old Log Entry Format ---
            let readableTimestamp = chunk.timestamp;
            try {
                readableTimestamp = new Date(chunk.timestamp).toLocaleString('en-US', {
                    timeZone: localUserSettings.preferredTimeZone,
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                });
            } catch (e) { /* use ISO string as fallback */ }

            const formattedContent = (chunk.content || "").replace(/\n/g, '\n\n');
            const platform = chunk.platform || 'unknown';

            formattedChunkOutput = `[LEGACY ENTRY]\n[${readableTimestamp}] (${chunk.role} on ${platform}):\n${formattedContent}\n\n------------------------------------\n\n`;
        } else {
            // Unknown format or incomplete chunk
            formattedChunkOutput = `[Unknown Date] (unknown role on unknown platform):\n[Malformed or incomplete log entry data]\n\n------------------------------------\n\n`;
            console.warn("[background.js] handleSaveLogToDisk: Encountered malformed log entry:", chunk);
        }
        return formattedChunkOutput;
    }).join(''); // Join all formatted chunk strings

    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(logString);

    return new Promise((resolve) => {
        chrome.downloads.download({
            url: dataUrl,
            // filename: `heartbeat_session_${sanitizedTitle}.txt`,
            filename: filename, // Uses the new timestamped filename
            saveAs: true
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error('[background.js] Save to disk error:', chrome.runtime.lastError.message);
                resolve({ success: false, error: chrome.runtime.lastError.message });
            } else if (downloadId === undefined && !chrome.runtime.lastError) {
                console.warn('[background.js] Download did not start or was cancelled.');
                resolve({ success: false, error: "Download did not start or was cancelled." });
            } else {
                console.log('[background.js] Log download initiated. DownloadId:', downloadId);
                resolve({ success: true, downloadId: downloadId });
            }
        });
    });
}

// === Log Filtering ===
const IGNORE_BLOCKS = [
    "\n\nSearch\nChatGPT can make mistakes. Check important info.\n?\nChatGPT is generating a response...",
    "?\nChatGPT is generating a response...",
    "ChatGPT is generating a response..."
];

const forkedCodeBuffer = [];
const forkedCodeIdCounter = { count: 0 }; // simple ID tracker

function isIgnored(content) {
    return IGNORE_BLOCKS.some(block => content.includes(block));
}

function extractAndReplaceRunCodeBlocks(content) {
    const pattern = /\\[\\[\\[RUNCODE\\]\\]\\]([\s\S]*?)\\[\\[\\[ENDCODE\\]\\]\\]/g;
    let match;
    let updatedContent = content;
    let newCaptures = [];

    while ((match = pattern.exec(content)) !== null) {
        const codeBlock = match[1].trim();

        // 🧹 Skip empty or invalid captures
        if (!codeBlock || codeBlock.length < 10 || codeBlock === "..." || codeBlock === ". . ." || codeBlock === "") {
            continue;
        }

        // 🧠 Add to the forked code buffer
        const id = `runcode-${forkedCodeBuffer.length}`;
        forkedCodeBuffer.push({
            id,
            code: codeBlock,
            timestamp: new Date().toISOString()
        });

        // 🏷️  Replace with unique ID
        const replacementString = `[[[FORKED_CODE_BLOCK_ID:${id}]]]`;
        updatedContent = updatedContent.replace(match[0], replacementString);

        // Store capture info
        newCaptures.push({
            original: match[0],
            replacement: replacementString,
            id,
            code: codeBlock,
        });
    }
    return { updatedContent, newCaptures };
}

// Add this function in background.js
function getBrowserNameForMetadata() {
    if (navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)) {
        const brands = navigator.userAgentData.brands;

        // Order of checks can matter if a browser identifies as multiple (e.g., Edge might also list "Chromium" and "Google Chrome")
        const edgeBrand = brands.find(b => b.brand.toLowerCase().includes("edge"));
        if (edgeBrand) return "Edge";

        const chromeBrand = brands.find(b => b.brand.toLowerCase().includes("chrome"));
        if (chromeBrand) return "Chrome";

        const chromiumBrand = brands.find(b => b.brand.toLowerCase().includes("chromium"));
        if (chromiumBrand) return "Chromium";

        // Fallback or for other browsers if you ever expand beyond Chromium
        // This is a very basic fallback.
        const userAgent = navigator.userAgent.toLowerCase();
        if (userAgent.includes("firefox")) return "Firefox";
        if (userAgent.includes("safari") && !userAgent.includes("chrome")) return "Safari";
    }
    return "Unknown"; // Default if not identifiable
}

// Then, inside your createAndLogExchangeChunk function in background.js:
// Within the extension_capture_metadata object:
// browser_name_at_capture: getBrowserNameForMetadata(),

async function sendChunkToEddieForDailyLogging(logChunk) {
    console.log("[background.js 5.55] Logging Chunk to Eddie for daily logging:", logChunk);
    console.log("Apologies for having to log it here again but until we're confident we gotta see it!");
    // Possibly this could pass through command-hook.js maybe in the future though?
    // Though it actually IS a function of background.js so separation of concerns is not really violated here.

    fetch('http://localhost:3001/eddie/dailyLogger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logChunk)
    })
        .then(response => response.json())
        .then(data => console.log(`[background.js 5.55] Logging confirmation:`, data))
        .catch(error => console.error('[background.js 5.55] Failed to log exchange:', error));

}

async function createAndLogExchangeChunk(
    userInputPayload,
    assistantOutputPayload,
    projectData,
    targetSessionId // <<< NEW: Explicit session ID for this chunk
) {
    console.log(`[createAndLogExchangeChunk V2] Creating new exchange chunk for targetSessionId: ${targetSessionId}`);

    // Pre-condition check: targetSessionId MUST be valid and exist in projectData.
    // The new_chat_turn handler is now responsible for ensuring this before calling.
    if (!targetSessionId || !projectData.sessions[targetSessionId]) {
        console.error(`[createAndLogExchangeChunk V2] CRITICAL: Invalid or missing targetSessionId: '${targetSessionId}'. Cannot log chunk. Review new_chat_turn logic.`);
        // If this happens, it means there's a flaw in how new_chat_turn determined/created the session ID.
        // We should not attempt to create a new session here as a fallback anymore;
        // new_chat_turn should have handled that (e.g., for a fresh page's first interaction).
        return projectData; // Return unmodified projectData to prevent further errors
    }

    const conversationId = targetSessionId; // Use the explicitly passed targetSessionId
    const currentSessionForChunk = projectData.sessions[conversationId]; // This is the session we're logging to

    // Ensure logEntries array exists for this specific session
    if (!Array.isArray(currentSessionForChunk.logEntries)) {
        console.warn(`[createAndLogExchangeChunk V2] logEntries for session ${conversationId} was not an array. Initializing.`);
        currentSessionForChunk.logEntries = [];
    }

    // --- Assemble Phase 1 Metadata (largely as before, but using currentSessionForChunk) ---

    const chunk_id = `chunk-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    const parent_chunk_id = currentSessionForChunk.logEntries.length > 0 ?
        currentSessionForChunk.logEntries[currentSessionForChunk.logEntries.length - 1].chunk_id :
        null;

    const source_llm_provider = assistantOutputPayload.platform || userInputPayload.platform || "unknown_llm";
    const source_llm_model_approx = assistantOutputPayload.model_approx || userInputPayload.model_approx || null;

    const turn_in_conversation = currentSessionForChunk.logEntries.length + 1;
    const type = "exchange";

    let userTextForChunk = userInputPayload.fullText;
    if (userInputPayload.detectedCommands && typeof sanitizeTextForLogging === 'function') {
        userTextForChunk = sanitizeTextForLogging(userInputPayload.fullText, userInputPayload.detectedCommands);
    }
    const user_input = {
        text: userTextForChunk,
        raw_text: userInputPayload.fullText,
        raw_source_details: userInputPayload.raw_source_details || null
    };

    let assistantTextForChunk = assistantOutputPayload.fullText;
    if (assistantOutputPayload.detectedCommands && typeof sanitizeTextForLogging === 'function') {
        assistantTextForChunk = sanitizeTextForLogging(assistantOutputPayload.fullText, assistantOutputPayload.detectedCommands);
    }
    const assistant_response = {
        text: assistantTextForChunk,
        raw_text: assistantOutputPayload.fullText,
        raw_source_details: assistantOutputPayload.raw_source_details || null
    };

    const extension_capture_metadata = {
        extension_version: chrome.runtime.getManifest().version,
        capture_method: `DOM_observer_${source_llm_provider}_ids`, // Consider making this more dynamic if methods vary
        tab_id_at_capture: assistantOutputPayload.sender_tab_id || userInputPayload.sender_tab_id,
        window_id_at_capture: assistantOutputPayload.sender_window_id || userInputPayload.sender_window_id,
        browser_name_at_capture: getBrowserNameForMetadata() || "Unknown",
        url_at_capture: assistantOutputPayload.sender_url || userInputPayload.sender_url
    };

    const data_origin_app = `Heartbeat-v${chrome.runtime.getManifest().version}`;

    const userTokens = userInputPayload.detectedCommands?.semanticTokens?.map(t => t.raw.trim()) || [];
    const assistantTokens = assistantOutputPayload.detectedCommands?.semanticTokens?.map(t => t.raw.trim()) || [];
    const initial_semantic_tokens = [...new Set([...userTokens, ...assistantTokens])];

    const notes = null;
    const custom_fields = null;

    // --- Assemble the Exchange Chunk ---
    const exchangeChunk = {
        chunk_id,
        conversationId, // This is now targetSessionId
        parent_chunk_id,
        timestamp_user_prompt: userInputPayload.timestamp_user_prompt,
        timestamp_assistant_response_start: assistantOutputPayload.timestamp_assistant_response_start || null,
        timestamp_assistant_response_complete: assistantOutputPayload.timestamp_assistant_response_complete,
        source_llm_provider,
        source_llm_model_approx,
        turn_in_conversation,
        type,
        user_input,
        assistant_response,
        extension_capture_metadata,
        data_origin_app,
        initial_semantic_tokens,
        notes,
        custom_fields
    };

    // --- Log to the correct session, Save, Notify, Process for Stacker ---
    currentSessionForChunk.logEntries.push(exchangeChunk);
    if (currentSessionForChunk.metadata) { // Ensure metadata exists before updating
        currentSessionForChunk.metadata.lastActivityAt = new Date().toISOString();
    } else {
        console.warn(`[createAndLogExchangeChunk V2] Metadata missing for session ${conversationId}. Cannot update lastActivityAt.`);
    }

    try {
        // Save projectData after adding the chunk to the specific session
        await saveProjectData(projectData);
        console.log(`[createAndLogExchangeChunk V2] Logged exchange chunk to session ${conversationId}. Chunk ID: ${exchangeChunk.chunk_id}`);

        // Notify popup. It gets the global currentSessionId for its main display context,
        // but also the actualSessionIdLoggedTo so it *could* potentially highlight or use this info.
        chrome.runtime.sendMessage({
            type: 'log_update',
            entry: exchangeChunk,
            currentSessionId: projectData.currentSessionId, // The global current (might be different from conversationId)
            actualSessionIdLoggedTo: conversationId         // The session this chunk actually went into
        }).catch(err => console.warn(`[createAndLogExchangeChunk V2] Error sending log_update to popup: ${err.message}`));

        // Manage Stacker for the *specific session* this chunk belongs to.
        if (typeof manageStackerBuffer === 'function') {
            console.log(`[createAndLogExchangeChunk V2] Calling manageStackerBuffer for exchange chunk: ${exchangeChunk.chunk_id} in session: ${conversationId}`);
            // We will need to modify manageStackerBuffer and processNewLogEntryForStacker
            // to accept and use this `conversationId` (targetSessionId)
            const mainStackerUpdatedByBuffer = await manageStackerBuffer(projectData, exchangeChunk, conversationId); // Pass conversationId
            if (mainStackerUpdatedByBuffer) {
                // If Stacker made changes (graduated item), projectData was modified within manageStackerBuffer/processNewLogEntryForStacker. Save again.
                console.log('[createAndLogExchangeChunk V2] Main Stacker was updated. Saving ProjectData again...');
                await saveProjectData(projectData);
            }
        } else {
            console.error("[createAndLogExchangeChunk V2] manageStackerBuffer function is not defined!");
        }

        // Send to Eddie (if applicable)
        if (typeof sendChunkToEddieForDailyLogging === 'function') {
            sendChunkToEddieForDailyLogging(exchangeChunk)
                .then(() => console.log(`[createAndLogExchangeChunk V2] Exchange chunk ${exchangeChunk.chunk_id} sent to Eddie.`))
                .catch(error => console.error(`[createAndLogExchangeChunk V2] Error sending chunk ${exchangeChunk.chunk_id} to Eddie:`, error));
        }

    } catch (error) {
        console.error('[createAndLogExchangeChunk V2] Error saving/processing exchange chunk:', error);
    }

    return projectData; // Return the (potentially modified) projectData
}

function addLogEntry(role, content, platform = 'general') {
    if (isIgnored(content)) return;

    const { updatedContent, newCaptures } = extractAndReplaceRunCodeBlocks(content);


    const entry = {
        role,
        content: updatedContent, // use updated content
        timestamp: new Date().toISOString(),
        msgId: ++msgCount, // Increment and assign
        platform,
        forkedBlocks: newCaptures, // Store info about extracted code blocks
    };

    logs.push(entry);
    console.log('[background.js] Logged entry:', entry); // Keep this for debugging
    chrome.runtime.sendMessage({ type: 'log_update', entry }); // Send new entry
}

function getLogs() {
    return logs;
}

async function addLogEntryToSession(role, content, platform = 'general', projectData) {
    if (isIgnored(content)) return;

    // let projectData = await getProjectData();
    // if (!projectData.currentSessionId || !projectData.sessions[projectData.currentSessionId]) {
    //     console.warn("[background.js] No current session to add log to. Starting a new one.");
    //     projectData = await startNewSession(projectData, platform); // Pass current platform
    // }

    console.log(`[background.js] addLogEntryToSession CALLED. Role: ${role}, Content snippet: "${content.substring(0, 30)}..."`);
    if (!projectData || !projectData.currentSessionId || !projectData.sessions[projectData.currentSessionId]) {
        console.warn("[background.js] addLogEntryToSession: No current session. Attempting to start a new one.");
        // This call to startNewSession needs to RE-ASSIGN projectData if it modifies it.
        projectData = await startNewSession(projectData, platform);
        // And this new session needs its projectData saved by the caller or here.
        // The new_chat_turn handler should saveProjectData after this if it re-assigns.
    }

    const currentSession = projectData.sessions[projectData.currentSessionId];
    if (!currentSession.metadata) { /* Initialize metadata if somehow missing */ }
    if (!Array.isArray(currentSession.logEntries)) currentSession.logEntries = [];

    const { updatedContent, newCaptures } = extractAndReplaceRunCodeBlocks(content); // Your existing function

    const entry = {
        role,
        content: updatedContent,
        timestamp: new Date().toISOString(),
        msgId: currentSession.logEntries.length + 1, // ID relative to session log
        platform, // Platform of the message (from content.js)
        forkedBlocks: newCaptures,
    };

    currentSession.logEntries.push(entry);
    currentSession.metadata.lastActivityAt = new Date().toISOString();

    // If this message is from a different platform than the session's main platform, update it.
    // if (currentSession.metadata.platform === 'initialization' || currentSession.metadata.platform === 'startup' || currentSession.metadata.platform === 'unknown') {
    //     currentSession.metadata.platform = platform;
    // }
    if (currentSession.metadata.platform === 'initialization' || /*... a new session might default to 'unknown' ...*/ currentSession.metadata.platform === 'unknown') {
        currentSession.metadata.platform = platform;
    }

    // try {
    //     await saveProjectData(projectData);
    //     console.log(`[background.js] Logged entry to session ${projectData.currentSessionId}:`, entry);
    //     chrome.runtime.sendMessage({ type: 'log_update', entry, currentSessionId: projectData.currentSessionId });
    // } catch (error) {
    //     console.error('[background.js] Error adding log entry:', error);
    // }
    try {
        await saveProjectData(projectData); // Save the new log entry
        console.log(`[background.js] Logged entry to session ${projectData.currentSessionId}. Total logs: ${currentSession.logEntries.length}. Entry:`, entry);
        chrome.runtime.sendMessage({ type: 'log_update', entry, currentSessionId: projectData.currentSessionId });

        // NOW, Process for Stacker
        if (typeof processNewLogEntryForStacker === 'function') {
            console.log(`[background.js] Calling processNewLogEntryForStacker for session ${projectData.currentSessionId}.`);
            const stackerMadeChanges = processNewLogEntryForStacker(projectData); // Pass the whole projectData
            if (stackerMadeChanges) {
                console.log('[background.js] Stacker made changes, saving ProjectData again...');
                await saveProjectData(projectData); // Save projectData again if Stacker modified it
                console.log('[background.js] ProjectData saved after Stacker update.');
            } else {
                console.log('[background.js] Stacker made no changes to projectData this time.');
            }
        } else {
            console.error("[background.js] processNewLogEntryForStacker function not found after import!");
        }

    } catch (error) {
        console.error('[background.js] Error during addLogEntryToSession or Stacker processing:', error);
    }
}

async function getSessionLogs(projectData) { // projectData is passed in
    const currentSessionId = projectData.currentSessionId;
    const previousSessionId = projectData.previousSessionId; // Used for your continuity logic

    let logsToShow = [];
    let currentSessionTitle = "No active session";
    let currentSessionMetadata = null; // Initialize to null
    let resolvedUserSettings = projectData.userSettings || { preferredTimeZone: 'America/Los_Angeles' };

    if (currentSessionId && projectData.sessions && projectData.sessions[currentSessionId]) {
        const session = projectData.sessions[currentSessionId]; // Get the current session object

        // Ensure logEntries exists and is an array
        if (Array.isArray(session.logEntries)) {
            logsToShow = [...session.logEntries]; // Create a shallow copy
        } else {
            console.warn(`[background.js] getSessionLogs: logEntries for session ${currentSessionId} is not an array or is missing. Initializing as empty.`);
            session.logEntries = []; // Initialize if missing/corrupt
            logsToShow = [];
        }

        // Ensure metadata object exists before trying to access its properties
        if (session.metadata) {
            currentSessionTitle = session.metadata.title || `Session ${currentSessionId}`;
            currentSessionMetadata = session.metadata; // <<< KEY CHANGE: Capture the metadata object
        } else {
            // Fallback if metadata is somehow missing for an existing session
            currentSessionTitle = `Session ${currentSessionId} (metadata missing)`;
            currentSessionMetadata = {
                platform: 'N/A',
                startedAt: 'N/A',
                initiatingUrl: 'N/A',
                status: 'N/A',
                title: currentSessionTitle // include the title in the fallback metadata
            };
            console.warn(`[background.js] getSessionLogs: Metadata missing for session ${currentSessionId}. Using fallback.`);
        }

        // Your continuity logic (if you still want to use it with exchangeChunks)
        if (logsToShow.length === 0 && previousSessionId &&
            projectData.sessions[previousSessionId] &&
            Array.isArray(projectData.sessions[previousSessionId].logEntries)) {

            const previousLogs = projectData.sessions[previousSessionId].logEntries;
            if (previousLogs.length > 0) {
                const continuityCount = Math.min(previousLogs.length, 3); // Example: show last 3
                const continuityEntries = previousLogs.slice(-continuityCount).map(chunk => ({
                    // Create a summary or a simplified version of the exchangeChunk for continuity display
                    // This needs to match what renderLogs now expects if it processes these.
                    // For simplicity, let's just mark it and pass the chunk.
                    // renderLogs would need to know how to handle a chunk marked 'isContinuity'
                    // or you can format it here into a simpler object for renderLogs.
                    ...chunk, // Pass the whole chunk, or select fields
                    isContinuity: true,
                    originalTimestamp: chunk.timestamp_user_prompt || chunk.timestamp_assistant_response_complete, // Pick one
                    // The 'timestamp' field renderLogs uses for continuity might need specific handling
                }));
                logsToShow = [...continuityEntries];
                console.log(`[background.js] getSessionLogs: Added ${continuityEntries.length} continuity entries to display.`);
            }
        }
    } else {
        console.warn(`[background.js] getSessionLogs: No current session ID or session data found. Current ID: ${currentSessionId}`);
    }

    // Return the comprehensive object
    return {
        logs: logsToShow,
        currentSessionId: currentSessionId || null,
        currentSessionTitle: currentSessionTitle,
        userSettings: resolvedUserSettings,
        currentSessionMetadata: currentSessionMetadata // <<< KEY CHANGE: Include the metadata object
    };
}

// Function to get a descriptive name for the message sender
function getSenderName(sender) {
    if (sender.tab) {
        // Likely a content script because sender.tab is present
        let tabUrl = sender.tab.url || 'URL not available';
        if (tabUrl.length > 70) { // Truncate long URLs for readability
            tabUrl = tabUrl.substring(0, 67) + '...';
        }
        return `Content Script (Tab ID: ${sender.tab.id}, URL: ${tabUrl})`;
    } else if (sender.id === chrome.runtime.id) {
        // Message is from this extension, but not a content script
        if (sender.url) {
            const extensionPrefix = `chrome-extension://${chrome.runtime.id}/`;
            const path = sender.url.substring(extensionPrefix.length);

            if (path.startsWith("popup.html")) { // Replace "popup.html" with your actual popup file name
                return "Popup Script";
            } else if (path.includes("options.html")) { // Replace "options.html" if you have an options page
                return "Options Page Script";
            } else if (path.includes("_generated_background_page.html") || path.endsWith(".js")) {
                // Check if it's the background script itself or a service worker URL
                // For MV3, sender.url might be chrome-extension://<id>/service-worker.js or similar
                // or if the background is sending to itself via runtime.sendMessage
                // (though typically sender is another context when background is the listener).
                // This condition helps identify other extension internal scripts.
                return `Extension Internal Script (e.g., Background or other utility script: ${path})`;
            } else {
                return `Other Extension Page (${path})`;
            }
        } else {
            // If sender.url is not present but ID matches, it's likely from the background/service worker
            // or an extension context without a specific document URL (less common for onMessage sender).
            return "Extension Context (Background/Service Worker or similar)";
        }
    } else if (sender.id) {
        // From another extension
        return `Another Extension (ID: ${sender.id})`;
    } else {
        return "Unknown Sender";
    }
}

function deFangCommandsForRecall(text) {
    if (typeof text !== 'string') return text; // Handle non-string inputs gracefully
    let deFangedText = text;

    // For LLM Commands: (((CMD arg))) -> :::CMD arg:::
    // This regex tries to capture the command name and its arguments carefully.
    deFangedText = deFangedText.replace(/(\(\(\()(\s*[A-Z0-9_-]+(?:[\s\S]*?)?)(\)\)\))/g, ':::$2:::');

    // For User Commands: |||CMD arg||| -> :::CMD arg:::
    deFangedText = deFangedText.replace(/(\|\|\|)(\s*[A-Z0-9_-]+(?:[\s\S]*?)?)(\|\|\|)/g, ':::$2:::');

    // For Semantic Tokens: [[[TOKEN]]] -> :::TOKEN::: (or similar, adjust as needed)
    // This makes them look similar to discussed commands.
    // If semantic tokens should NEVER be executable and have a simpler structure:
    // deFangedText = deFangedText.replace(/(\[\[\[)(\s*[A-Z0-9_-]+\s*)(\]\]\])/g, ':::$2:::'); 
    // Note: If your semantic tokens can have spaces or complex args, this regex might need adjustment.

    // For System Messages: {{{SYSTEM}}}...{{{/SYSTEM}}} -> {{SYSTEM}}...{{/SYSTEM}}
    // This is optional. If you want the LLM to still recognize the structure of system messages
    // from recalled text but not have them processed by your parser as active system message blocks,
    // this could be useful. Otherwise, you can leave them as is if your parser for new system messages is robust.
    // deFangedText = deFangedText.replace(/(\{\{\{\s*(SYSTEM)\s*\}\}\})([\s\S]*?)(\{\{\{\s*\/SYSTEM\s*\}\}\})/gi, '{{$2}}$3{{/SYSTEM}}');

    return deFangedText;
}

// Helper function to determine platform from URL (you'd need to create this)
function determinePlatformFromUrl(url) {
    if (url.includes("gemini.google.com") || url.includes("bard.google.com")) return "gemini-chat-interface";
    if (url.includes("chat.openai.com")) return "chatgpt-interface";
    if (url.includes("claude.ai")) return "claude-chat-interface";
    return "unknown_platform";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const senderDescription = getSenderName(sender);
    console.log(`[background.js] Received message from: [${senderDescription}] saying:`, message);

    (async () => {
        let projectData = await getProjectData(); // Load data at the beginning of handler

        switch (message.type) {

            // case 'add_log_entry':
            //     if (message.role && typeof message.content !== 'undefined') {
            //         await addLogEntry(message.role, message.content, message.platform || 'unknown'); // Ensure platform is passed
            //         sendResponse({ status: 'Log entry added' });
            //     } else {
            //         console.warn('[background.js] add_log_entry: Missing role or content', message);
            //         sendResponse({ status: 'Error: Missing role or content' });
            //     }
            //     break;

            case 'trigger_test_injection':
                console.log('[background.js] Received trigger_test_injection with prompt:', message.promptToInject);
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0] && tabs[0].id) {
                        // Check if the active tab is a Gemini tab (optional, but good practice)
                        if (tabs[0].url && (tabs[0].url.startsWith('https://gemini.google.com/') || tabs[0].url.startsWith('https://bard.google.com/'))) {
                            chrome.tabs.sendMessage(tabs[0].id, {
                                type: 'insert_prompt', // This is the type content.js already listens for
                                prompt: message.promptToInject,
                                autoSubmit: message.autoSubmit
                            }, response => {
                                if (chrome.runtime.lastError) {
                                    console.error('[background.js] Error sending insert_prompt:', chrome.runtime.lastError.message);
                                } else {
                                    console.log('[background.js] insert_prompt message sent. Response from content.js:', response);
                                }
                            });
                        } else {
                            console.warn('[background.js] Test injection: Active tab is not a Gemini page.');
                            // Optionally notify the user via an alert in the popup or a browser notification
                            // For now, just logging is fine.
                        }
                    } else {
                        console.error("[background.js] No active tab found for prompt injection.");
                    }
                });
                sendResponse({ status: "Injection trigger message processed by background." }); // Let popup know it was received
                return true; // Indicate async response because of chrome.tabs.query
                break;

            case 'new_chat_turn':
                if (!message.role || typeof message.fullText !== 'string' || !sender.tab || typeof sender.tab.id !== 'number') {
                    console.warn('[background.js V3 new_chat_turn] Critical info missing (role, fullText, or sender.tab.id). Aborting.', message, sender);
                    sendResponse({ status: 'Error: Missing critical info for new_chat_turn' });
                    break;
                }

                const tabId = sender.tab.id;
                const currentTabInfo = { tabId: tabId, windowId: sender.tab.windowId, url: sender.tab.url };
                const tabCurrentStatus = tabStatusMap.get(tabId);
                let conversationIdForThisTurn = null;
                let justCreatedNewSession = false;

                console.log(`[NCT V3] Received new_chat_turn for TabID ${tabId}. Status: ${tabCurrentStatus}. Role: ${message.role}`);

                // Check if this is the first interaction on a page that was awaiting it
                if (tabCurrentStatus === 'fresh_page_awaits_interaction' && message.role === 'user') {
                    console.log(`[NCT V3] First user interaction on fresh TabID ${tabId}. Creating new global session.`);
                    // This is the point to create a new session for this tab and make it global.

                    const oldGlobalSessionId = projectData.currentSessionId; // Capture before it changes

                    const sessionCreationResult = await startNewSession(
                        projectData,
                        message.platform || 'unknown_fresh_interaction',
                        currentTabInfo,
                        { setAsCurrentGlobal: true } // This interaction defines the new global task
                    );

                    projectData = sessionCreationResult.updatedProjectData; // Use the returned projectData
                    conversationIdForThisTurn = sessionCreationResult.createdSessionId;
                    // projectData.currentSessionId is now conversationIdForThisTurn

                    tabStatusMap.set(tabId, 'session_assigned');
                    // tabIdToConversationIdMap is updated by startNewSession

                    console.log(`[NCT V3] New global session ${conversationIdForThisTurn} created for TabID ${tabId}. Previous global was ${oldGlobalSessionId || 'null'}.`);
                    justCreatedNewSession = true; // Flag that we just made a new session

                    // Notify popup that the global session has changed
                    // This is already handled by startNewSession if setAsCurrentGlobal is true

                } else {
                    // Tab already has an assigned session, or it's an assistant turn continuing a session.
                    conversationIdForThisTurn = tabIdToConversationIdMap.get(tabId);
                    if (!conversationIdForThisTurn) {
                        // Fallback: If no session is specifically mapped to this tab ID,
                        // but it's not a 'fresh_awaiting_interaction' user turn,
                        // use the global currentSessionId. This might happen if an assistant message
                        // comes from a tab that resolved to 'generic_not_fresh', for example,
                        // and we decided such tabs should still log to the global context.
                        // Or if a tab was reloaded and lost its direct mapping but should continue global.
                        if (projectData.currentSessionId && projectData.sessions[projectData.currentSessionId]) {
                            console.warn(`[NCT V3] TabID ${tabId} has no specific session in tabIdToConversationIdMap (status: ${tabCurrentStatus}). Falling back to global currentSessionId: ${projectData.currentSessionId} for role: ${message.role}`);
                            conversationIdForThisTurn = projectData.currentSessionId;
                            // Optionally, re-map this tab to the global session if it makes sense for this state
                            // tabIdToConversationIdMap.set(tabId, conversationIdForThisTurn);
                            // tabStatusMap.set(tabId, 'session_assigned'); // (if assuming it's now part of global)
                        } else {
                            // This is a more problematic state: no mapped session and no global session.
                            console.error(`[NCT V3] CRITICAL: No session ID found for TabID ${tabId} (status: ${tabCurrentStatus}) and no valid global currentSessionId. Cannot log turn for role: ${message.role}.`);
                            // Attempt to start a failsafe new session - this indicates a logic gap elsewhere if hit often.
                            console.warn(`[NCT V3] Attempting to start a new failsafe session for TabID ${tabId}.`);

                            const failsafeSessionResult = await startNewSession(projectData, message.platform || 'unknown_failsafe', currentTabInfo, { setAsCurrentGlobal: true });
                            projectData = failsafeSessionResult.updatedProjectData;
                            conversationIdForThisTurn = failsafeSessionResult.createdSessionId;

                            tabStatusMap.set(tabId, 'session_assigned');
                            justCreatedNewSession = true;
                            console.warn(`[NCT V3] Failsafe session ${conversationIdForThisTurn} created and set as global.`);
                        }
                    }
                }

                if (!conversationIdForThisTurn || !projectData.sessions[conversationIdForThisTurn]) {
                    console.error(`[NCT V3] FATAL: Could not determine or create a valid session for TabID ${tabId}. Aborting turn processing for role: ${message.role}. conversationIdForThisTurn: ${conversationIdForThisTurn}`);
                    sendResponse({ status: 'Error: No valid session to log to.' });
                    break;
                }

                // --- Operation: Furby Relay Logic ---
                let currentMessageSenderTabId = sender.tab.id;

                if (isFurbyModeActive && message.role === 'assistant' && currentMessageSenderTabId) { // Added check for currentMessageSenderTabId
                    let targetTabIdForRelay = null;
                    let relayingFurbyName = null;

                    // 👇 Use currentMessageSenderTabId here 👇
                    if (currentMessageSenderTabId === furbyAlphaTabId && nextFurbyToSpeak === 'alpha') {
                        targetTabIdForRelay = furbyBravoTabId;
                        relayingFurbyName = "Furby Alpha";
                        nextFurbyToSpeak = 'bravo';
                        console.log(`[Furby] Alpha (Tab ${currentMessageSenderTabId}) spoke. Relaying to Bravo (Tab ${targetTabIdForRelay}). Next to speak: Bravo.`);
                    } else if (currentMessageSenderTabId === furbyBravoTabId && nextFurbyToSpeak === 'bravo') {
                        // 👇 And here 👇
                        targetTabIdForRelay = furbyAlphaTabId;
                        relayingFurbyName = "Furby Bravo";
                        nextFurbyToSpeak = 'alpha';
                        console.log(`[Furby] Bravo (Tab ${currentMessageSenderTabId}) spoke. Relaying to Alpha (Tab ${targetTabIdForRelay}). Next to speak: Alpha.`);
                    }

                    if (targetTabIdForRelay && relayingFurbyName) {
                        const textToRelay = message.fullText;
                        const promptForNextFurby =
                            `You are Furby ${targetTabIdForRelay === furbyAlphaTabId ? 'Alpha' : 'Bravo'}, an advanced AI. ` +
                            `You are in a discussion with Furby ${relayingFurbyName}. ` +
                            `${relayingFurbyName} just said: "${textToRelay}"\n\n` +
                            `What is your direct response to ${relayingFurbyName}?`;

                        console.log(`[Furby] Relaying to Tab ID ${targetTabIdForRelay}: "${promptForNextFurby.substring(0, 100)}..."`);

                        chrome.tabs.sendMessage(targetTabIdForRelay, {
                            type: 'insert_prompt',
                            prompt: promptForNextFurby,
                            autoSubmit: true
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.error(`[Furby] Error relaying message to Tab ID ${targetTabIdForRelay}: ${chrome.runtime.lastError.message}`);
                                if (typeof deactivateFurbyMode === 'function') deactivateFurbyMode(); // Good safety
                            } else {
                                console.log(`[Furby] Message successfully relayed to Tab ID ${targetTabIdForRelay}. Response:`, response);
                            }
                        });
                    }
                }
                // --- End of Furby Relay Logic ---

                // // --- Operation: Furby Relay Logic ---
                // if (isFurbyModeActive && message.role === 'assistant') { // Only relay assistant responses in Furby mode
                //     let targetTabId = null;
                //     let senderFurbyName = null;

                //     if (sender.tab.id === furbyAlphaTabId && nextFurbyToSpeak === 'alpha') {
                //         targetTabId = furbyBravoTabId;
                //         senderFurbyName = "Furby Alpha";
                //         nextFurbyToSpeak = 'bravo'; // Next, Bravo should "speak" by getting Alpha's output as input
                //         console.log(`[Furby] Alpha spoke. Relaying to Bravo. Next to speak: Bravo.`);
                //     } else if (sender.tab.id === furbyBravoTabId && nextFurbyToSpeak === 'bravo') {
                //         targetTabId = furbyAlphaTabId;
                //         senderFurbyName = "Furby Bravo";
                //         nextFurbyToSpeak = 'alpha'; // Next, Alpha should "speak"
                //         console.log(`[Furby] Bravo spoke. Relaying to Alpha. Next to speak: Alpha.`);
                //     }

                //     if (targetTabId && senderFurbyName) {
                //         const textToRelay = message.fullText; // The full response from the speaking Furby
                //         const promptForNextFurby = `Context from ${senderFurbyName}: "${textToRelay}"\n\nWhat are your thoughts or response to this?`;

                //         console.log(`[Furby] Relaying to Tab ID ${targetTabId}: "${promptForNextFurby.substring(0, 100)}..."`);

                //         // Ensure programming mode is ON for the target tab if it needs RUNCODE for some reason,
                //         // but for simple text relay, direct insert_prompt is fine.
                //         // We might need to activate command mode on the *target* tab if it's going to run commands.
                //         // For now, let's just send the text.
                //         chrome.tabs.sendMessage(targetTabId, {
                //             type: 'insert_prompt',
                //             prompt: promptForNextFurby,
                //             autoSubmit: true
                //         }, (response) => {
                //             if (chrome.runtime.lastError) {
                //                 console.error(`[Furby] Error relaying message to Tab ID ${targetTabId}: ${chrome.runtime.lastError.message}`);
                //                 // Potentially stop Furby mode if a tab closes or errors out
                //                 isFurbyModeActive = false;
                //             } else {
                //                 console.log(`[Furby] Message successfully relayed to Tab ID ${targetTabId}. Response:`, response);
                //             }
                //         });
                //     }
                // }

                console.log(`[NCT V3] Turn from TabID ${tabId} (Role: ${message.role}) will be processed for session: ${conversationIdForThisTurn}`);

                let textToInjectFromCommandProcessing = null;

                // --- Step 1: Check for a role-appropriate RUNCODE block ---



                if (message.detectedCommands && message.detectedCommands.llmCommands && message.detectedCommands.llmCommands.length > 0) {
                    // if (message.detectedCommands &&
                    //     message.detectedCommands.runcodeBlockPresent &&
                    //     (message.detectedCommands.llmCommands && message.detectedCommands.llmCommands.length > 0) ||
                    //     (message.detectedCommands.userCommands && message.detectedCommands.userCommands.length > 0)) {

                    console.log('[background.js] Detailed llmCommands[0] from content.js:',
                        JSON.stringify(message.detectedCommands.llmCommands[0]));
                    console.log(`[background.js] Value of message.detectedCommands.llmCommands[0].command: "${message.detectedCommands.llmCommands[0].command}"`);
                    console.log(`[background.js] Does it strictly equal 'SYSTEM_COMMAND'? `,
                        message.detectedCommands.llmCommands[0].command === 'SYSTEM_COMMAND');

                    const isModeCommand = message.detectedCommands.llmCommands.some(cmd => cmd.command === 'SYSTEM_COMMAND');

                    // First, check if the content itself was a SYSTEM message (e.g. recalled text)
                    // If so, we should NOT process commands from it, even if it's from assistant role and has RUNCODE
                    if (message.detectedCommands.isSystemMessageContent) {
                        console.log('[background.js] Assistant message was SYSTEM content. Ignoring any RUNCODE blocks within it.');
                    } else { // Processing for LLM or USER commands...

                        // --- Step 2: If a block was found, process it ---
                        console.log(`[background.js] Calculated isModeCommand: ${isModeCommand}`);

                        console.log("[background.js] Valid commands found within a RUNCODE block by content.js. Proceeding to queue.");
                        console.log(`[background.js] isAssistantCommandModeActive: ${isAssistantCommandModeActive}`);
                        // --- Step 2a: But only process it if the we find we have queueDetectedCommands ---

                        if (typeof queueDetectedCommands === 'function') { // This is in commandManager.js and it only works if we're linked
                            // --- Step 2b: Check if the Assistant is in command mode ---
                            if (isAssistantCommandModeActive || isModeCommand) {
                                console.log('[background.js] Programming mode IS ON. Proceeding to queue commands.');
                                textToInjectFromCommandProcessing = await queueDetectedCommands(
                                    message.detectedCommands,
                                    message.role,
                                    conversationIdForThisTurn,
                                    projectData
                                );
                                // CRUCIAL: Auto-reset the flag after processing one block
                                // isAssistantCommandModeActive = false;
                                // console.log('[background.js] Programming mode has been AUTO-RESET to OFF.');
                                if (!isModeCommand && isAssistantCommandModeActive) {
                                    isAssistantCommandModeActive = false;
                                    console.log('[background.js] Programming mode has been AUTO-RESET to OFF after non-mode command.');
                                } else if (isModeCommand) {
                                    // We want the mode to STAY ON after an ACTIVATE command.
                                    // The current log: "[background.js] Programming mode has been AUTO-RESET to OFF."
                                    // suggests something is resetting it regardless.
                                    // Perhaps the reset is happening *outside* this specific if/else if, unconditionally?
                                    console.log(`[background.js v5.55] isModeCommand is: ${isModeCommand}`);
                                }

                            } else {
                                console.log('[background.js] Programming mode is OFF. Assistant RUNCODE block ignored.');
                                // Optional: Notify the user or me that a command was ignored due to mode being off?
                            } // end of check for isAssistantCommandModeActive or not.

                            if (textToInjectFromCommandProcessing) {
                                console.log("[background.js] Command processing yielded text to inject:", textToInjectFromCommandProcessing);
                                // Your logic to inject text back into the page would go here if needed.
                            }
                        } else {
                            console.log('[background.js] Condition FAILED: Programming mode is OFF and not a ModeCommand. Assistant RUNCODE block ignored.');
                        }
                    }
                } else {
                    console.log("[background.js] No actionable commands found within a valid RUNCODE block (or no RUNCODE block present).");
                }

                // --- 3. Buffering User Input OR Pairing with Assistant Response ---
                const currentTurnPayload = {
                    fullText: message.fullText,
                    platform: message.platform,
                    model_approx: message.model_approx || null,
                    detectedCommands: message.detectedCommands,
                    raw_source_details: message.raw_source_details,
                    sender_tab_id: currentTabInfo.tabId,
                    sender_window_id: currentTabInfo.windowId,
                    sender_url: currentTabInfo.url
                };

                if (message.role === 'user') {
                    pendingUserInputs[conversationIdForThisTurn] = { // Use determined conversationId
                        ...currentTurnPayload,
                        timestamp_user_prompt: new Date().toISOString()
                    };
                    console.log(`[NCT V3] User input buffered for session: ${conversationIdForThisTurn}`);
                } else if (message.role === 'assistant') {
                    const bufferedUserData = pendingUserInputs[conversationIdForThisTurn]; // Use determined conversationId
                    if (bufferedUserData) {
                        const assistantDataForChunk = {
                            ...currentTurnPayload,
                            timestamp_assistant_response_start: message.timestamp_assistant_response_start || null,
                            timestamp_assistant_response_complete: new Date().toISOString()
                        };

                        // Pass conversationIdForThisTurn explicitly to createAndLogExchangeChunk if it doesn't already get it from projectData.currentSessionId
                        // However, createAndLogExchangeChunk uses projectData.currentSessionId. If we just created a new global session,
                        // projectData.currentSessionId IS conversationIdForThisTurn. If not, this needs care.
                        // Let's ensure createAndLogExchangeChunk uses the right ID.
                        // For now, assuming projectData.currentSessionId is correctly set if a new global session was made.
                        // If a distinct session logs here, projectData.currentSessionId might be different.

                        // Best to modify createAndLogExchangeChunk to accept the targetSessionId.
                        // For now, if justCreatedNewSession is true, projectData.currentSessionId IS conversationIdForThisTurn.
                        // If not, and conversationIdForThisTurn came from tabIdToConversationIdMap, then
                        // projectData.currentSessionId might be different if this is a background tab.
                        // This highlights a need: createAndLogExchangeChunk should probably take targetSessionId as a param.

                        // TEMPORARY: If we didn't just create a new global session, but are logging to a specific tab's session,
                        // ensure createAndLogExchangeChunk knows which one.
                        // This means we might need to temporarily set projectData.currentSessionId if logging to non-global,
                        // or better, pass conversationIdForThisTurn into createAndLogExchangeChunk.

                        // Let's assume for now that if conversationIdForThisTurn is resolved, it IS the one
                        // that createAndLogExchangeChunk should use, which means if it's not already projectData.currentSessionId,
                        // we have a slight mismatch in how createAndLogExchangeChunk gets its target.
                        // The simplest path is that new_chat_turn ensures projectData.currentSessionId IS conversationIdForThisTurn
                        // if an exchange is happening, which means an active tab.

                        if (projectData.currentSessionId !== conversationIdForThisTurn && !justCreatedNewSession) {
                            // This implies an interaction from a non-active tab that has its own session,
                            // or the global current changed since this tab was last active.
                            // For an exchange to complete, the tab is likely active.
                            // This area might need more thought if background tabs can complete exchanges.
                            // For now, let's assume an exchange happens in what effectively becomes the current context.
                            console.warn(`[NCT V3] Logging to ${conversationIdForThisTurn}, but global is ${projectData.currentSessionId}. This is okay if TabID ${tabId} is now considered active context.`);
                            // If the tab is active, onActivated should have made conversationIdForThisTurn the global current.
                        }

                        projectData = await createAndLogExchangeChunk( // This needs to use `conversationIdForThisTurn`
                            bufferedUserData,
                            assistantDataForChunk,
                            projectData,
                            conversationIdForThisTurn // Pass the target session ID
                        );
                        delete pendingUserInputs[conversationIdForThisTurn];
                    } else {
                        console.warn(`[NCT V3] Assistant message for session ${conversationIdForThisTurn} (TabID ${tabId}) without pending user input.`);
                        // Potentially log as an assistant-only chunk if desired for this session
                    }
                }

                // --- 4. Orchestrate RECALL and Other Command Injections ---
                // This part should largely work as is, but ensure it uses `conversationId` consistently.
                // The RECALL search might need to be adapted if `stackerChunks` are directly replaced by
                // the new `exchangeChunk` format in `projectData.sessions[conversationId].logEntries`.

                conversationId = conversationIdForThisTurn; // maybe this kludges it? 

                const commandToOrchestrate = commandQueue.find(cmd => cmd.state === 'completed_requires_background_action' && cmd.sessionId === conversationId);

                // let stackerResult = null; // Initialize stackerResult for RECALL handling
                // Does it have another name? Where are we handling the RECALL results in this damn spaghetti code? LMAO
                // Yes we'll keep it here for another iteration but it should be deleted if we don't come back to access it!

                if (commandToOrchestrate && commandToOrchestrate.result && commandToOrchestrate.result.action === 'perform_recall') {
                    console.log(`[background.js] Orchestrating RECALL command for search term: "${commandToOrchestrate.result.searchTerm}" (ID: ${commandToOrchestrate.id})`);
                    const searchTerm = commandToOrchestrate.result.searchTerm;
                    const originalCommandId = commandToOrchestrate.id; // Store for use in async callbacks

                    // Default message if things go wrong, or if no results
                    let textForUserDisplay = `{{{SYSTEM}}} Could not retrieve information for "${searchTerm}" from server Stacker. {{{/SYSTEM}}}`;
                    let stackerResultFromServer = null; // Declare here to use in callback

                    try {
                        console.log(`[background.js] Calling Eddie's server-side Stacker for RECALL: "${searchTerm}"`);
                        const response = await fetch('http://localhost:3001/eddie/stacker/simple-recall', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ query: searchTerm })
                        });

                        if (!response.ok) {
                            // Try to get error message from server if available
                            let serverErrorMsg = `HTTP error! status: ${response.status}`;
                            try {
                                const errorJson = await response.json();
                                serverErrorMsg = errorJson.error || serverErrorMsg;
                            } catch (e) { /* ignore if response isn't json */ }
                            throw new Error(serverErrorMsg);
                        }

                        stackerResultFromServer = await response.json();
                        console.log('[background.js] Received response from Eddie Stacker:', stackerResultFromServer);

                        if (stackerResultFromServer && stackerResultFromServer.results_for_injection) {
                            textForUserDisplay = `{{{SYSTEM}}} ${stackerResultFromServer.results_for_injection} {{{/SYSTEM}}}`;
                        } else if (stackerResultFromServer && stackerResultFromServer.status === "no_matches_found") {
                            textForUserDisplay = `{{{SYSTEM}}} No information found in Stacker for "${searchTerm}". Please use your own knowledge. {{{/SYSTEM}}}`;
                        } else if (stackerResultFromServer && stackerResultFromServer.status === "no_data_loaded") {
                            textForUserDisplay = `{{{SYSTEM}}} Stacker logs not loaded on server. Could not recall "${searchTerm}". {{{/SYSTEM}}}`;
                        }
                        // If stackerResultFromServer is null or has no results_for_injection, textForUserDisplay remains the default error

                    } catch (error) {
                        console.error('[background.js] Error during RECALL fetch to Eddie Stacker:', error);
                        textForUserDisplay = `{{{SYSTEM}}} Error recalling information for "${searchTerm}": ${error.message} {{{/SYSTEM}}}`;
                        stackerResultFromServer = null; // Ensure it's null on error
                    }

                    // Now, send the prepared text (results or error) to content.js for DOM display
                    // const targetTabIdForDisplay = message.sender?.tab?.id || commandToOrchestrate?.sender_tab_id;
                    const targetTabIdForDisplay = tabId;
                    // ^ Ensure one of these provides a valid ID of the Gemini tab.
                    // 'message.sender.tab.id' refers to the tab that sent the message that *resulted* in this 'new_chat_turn'
                    // processing. If the RECALL command was from an assistant, 'message' would be the assistant's message.
                    // If you stored the original user's tab ID on the command object, that's more reliable.

                    console.log(`[RecallDebug BG] Preparing to send to DOM. Target Tab ID: ${targetTabIdForDisplay}`);
                    console.log(`[RecallDebug BG] Display String: ${textForUserDisplay.substring(0, 100)}...`);

                    if (targetTabIdForDisplay) {
                        chrome.tabs.sendMessage(targetTabIdForDisplay, {
                            type: 'display_dom_message_in_chat',
                            text: textForUserDisplay
                        }, async (responseFromContentScript) => { // Make callback async
                            if (chrome.runtime.lastError) {
                                console.error(`[RecallDebug BG] sendMessage ERROR to content.js (Tab ID ${targetTabIdForDisplay}): ${chrome.runtime.lastError.message}`);
                            } else {
                                console.log(`[RecallDebug BG] sendMessage SUCCESS to content.js (Tab ID ${targetTabIdForDisplay}). Response:`, responseFromContentScript);

                                // Only proceed if DOM display was confirmed and we actually got recall results
                                if (responseFromContentScript && responseFromContentScript.status && responseFromContentScript.status.includes("displayed") &&
                                    stackerResultFromServer && stackerResultFromServer.results_for_injection && stackerResultFromServer.status !== "no_matches_found" && stackerResultFromServer.status !== "no_data_loaded") {

                                    console.log(`[background.js] Recall results displayed in DOM. Now preparing AI context prompt for session ${conversationIdForThisTurn}.`);

                                    const originalUserQuery = stackerResultFromServer.query; // From the server response
                                    const recalledContentForAI = stackerResultFromServer.results_for_injection;

                                    const aiContextPrompt = `System Task for Gemini (following a user recall on "${originalUserQuery}"): Based on the following recalled context that was just displayed to the user, please provide a relevant follow-up comment or question.\n\nRecalled Context:\n"${recalledContentForAI}"`;

                                    console.log(`[background.js] Sending system-generated prompt to content.js for UI submission: "${aiContextPrompt.substring(0, 100)}..."`);

                                    chrome.tabs.sendMessage(targetTabIdForDisplay, {
                                        type: 'insert_prompt',
                                        prompt: aiContextPrompt,
                                        autoSubmit: true
                                    }, (insertResponse) => {
                                        if (chrome.runtime.lastError) {
                                            console.error(`[background.js] Error sending system-generated prompt via insert_prompt: ${chrome.runtime.lastError.message}`);
                                        } else {
                                            console.log(`[background.js] System-generated prompt sent via insert_prompt. Response:`, insertResponse);
                                        }
                                        // Mark original RECALL command as completed and remove AFTER this attempt
                                        const cmdToFinalize = commandQueue.find(cmd => cmd.id === originalCommandId);
                                        if (cmdToFinalize) {
                                            cmdToFinalize.state = 'completed';
                                            const cmdIndex = commandQueue.findIndex(cmd => cmd.id === originalCommandId);
                                            if (cmdIndex > -1) {
                                                console.log(`[background.js] Removing RECALL command ${originalCommandId} from queue after AI prompt.`);
                                                commandQueue.splice(cmdIndex, 1);
                                            }
                                        }
                                    });
                                } else {
                                    console.warn('[background.js] DOM display not confirmed or no valid recall results. AI context prompt not sent. Response:', responseFromContentScript);
                                    // If DOM display failed or no actual results, still complete the original RECALL command
                                    const cmdToFinalize = commandQueue.find(cmd => cmd.id === originalCommandId);
                                    if (cmdToFinalize) {
                                        cmdToFinalize.state = (responseFromContentScript && responseFromContentScript.status && responseFromContentScript.status.includes("displayed")) ? 'completed' : 'failed';
                                        cmdToFinalize.error = cmdToFinalize.state === 'failed' ? 'DOM display failed or no recall results for AI prompt' : null;
                                        const cmdIndex = commandQueue.findIndex(cmd => cmd.id === originalCommandId);
                                        if (cmdIndex > -1) {
                                            console.log(`[background.js] Removing RECALL command ${originalCommandId} from queue (no AI prompt).`);
                                            commandQueue.splice(cmdIndex, 1);
                                        }
                                    }
                                }
                            }
                            // DO NOT complete/splice commandToOrchestrate here, it's done in the sendMessage callback
                        });
                    } else {
                        console.error("[RecallDebug BG] NO TARGET TAB ID for DOM display message! RECALL command cannot complete display.");
                        // Mark command as failed if no tab ID
                        if (commandToOrchestrate) { // Check if commandToOrchestrate is defined
                            commandToOrchestrate.state = 'failed';
                            commandToOrchestrate.error = 'No target tab ID for display';
                            const cmdIndex = commandQueue.findIndex(cmd => cmd.id === originalCommandId);
                            if (cmdIndex > -1) {
                                console.log(`[background.js] Removing failed RECALL command ${originalCommandId} from queue.`);
                                commandQueue.splice(cmdIndex, 1);
                            }
                        }
                    }
                    // This ensures the original RECALL flow doesn't try to inject into the prompt box itself
                    textToInjectFromCommandProcessing = null;
                }
                // Final save after all operations for this turn are complete.
                // createAndLogExchangeChunk also calls saveProjectData, so if it was called, this might be redundant
                // unless pendingUserInputs itself needs to be part of projectData and persisted.
                // For now, let's assume createAndLogExchangeChunk handles its own save and updates projectData.
                // If pendingUserInputs is just an in-memory object, then only call saveProjectData if it wasn't called by createAndLogExchangeChunk.
                // To be safe, if projectData was potentially modified by createAndLogExchangeChunk, this save is good.

                await saveProjectData(projectData);
                sendResponse({ status: `Chat turn processed for session ${conversationIdForThisTurn}` });
                break;

            case 'get_logs': // This now fetches session logs + continuity
                const sessionData = await getSessionLogs(projectData);
                sendResponse(sessionData);

                console.log('[background.js] [chrome.runtime.onMessage] For case get_logs, sending sessionData.logs count:',
                    (sessionData && sessionData.logs ? sessionData.logs.length : 'N/A'),
                    'Full sessionData:', JSON.parse(JSON.stringify(sessionData)));

                break;

            case 'start_new_session': // New message type from popup
                projectData = await startNewSession(projectData, message.platform || 'manual'); //*** this needs to also send tab info!!!
                // getSessionLogs will be called by popup on session_updated message
                sendResponse({ status: 'New session started', newSessionId: projectData.currentSessionId });
                break;
            // case 'get_current_session_info_for_content_script':
            //     sendResponse({
            //         currentSessionId: projectData.currentSessionId,
            //         previousSessionId: projectData.previousSessionId
            //     });
            //     break;

            case 'get_current_session_info_for_content_script':
                // The 'sender' object contains sender.tab
                if (sender.tab) {
                    const requestingTab = sender.tab;
                    console.log(`✨✨✨ [get_current_session_info] Request from content script in TabID: ${requestingTab.id}, URL: ${requestingTab.url}`);

                    // Use resolveSessionForTab to get the definitive session for this tab
                    // This ensures if onActivated/onUpdated hasn't run yet for it, we still get correct context.
                    // Pass a *copy* of projectData to avoid unintended modifications if resolveSessionForTab changes it
                    // and we don't want to save those changes from this read-only path.
                    // However, resolveSessionForTab *does* call startNewSession which modifies projectData.
                    // So, we must treat projectData as potentially modified.
                    let tempProjectData = JSON.parse(JSON.stringify(projectData)); // Deep copy for read-only resolve
                    const result = await resolveSessionForTab(requestingTab, tempProjectData);
                    // Note: If resolveSessionForTab *started a new session*, that new session is in result.projectData
                    // but NOT yet in our main projectData or saved unless we explicitly do it.
                    // For a get_current_session_info, we probably DON'T want it to start a new session if one isn't found.
                    // Let's refine resolveSessionForTab to have a flag for "allowCreateNew"
                    // For now, let's assume resolveSessionForTab might have updated currentSessionId in projectData
                    // if it created a new one, and it returns the updated projectData.

                    projectData = result.projectData; // Update projectData in case a new session was made
                    await saveProjectData(projectData);

                    // SAFER: The handler for get_current_session_info should be simpler.
                    // It should reflect the *current state* of projectData.currentSessionId,
                    // assuming onActivated/onUpdated have already set it correctly for this tab.
                    // Or, it finds the session for sender.tab.url without creating a new one.

                    let sessionIdForContentScript = null;
                    let associatedUrlForContentScript = null;

                    // Try to find a session for this tab's URL without creating a new one
                    for (const sid in projectData.sessions) {
                        const sess = projectData.sessions[sid];
                        if (sess.metadata && sess.metadata.initiatingUrl === requestingTab.url && sess.metadata.status === "active") {
                            sessionIdForContentScript = sid;
                            associatedUrlForContentScript = sess.metadata.initiatingUrl;
                            break;
                        }
                    }

                    // If no specific session for this tab's URL, what is the global current?
                    // This logic might need to align with what currentSessionId truly means.
                    // For now, let's just send what is globally current, plus what we found for its URL.
                    console.log(`✨✨✨ [get_current_session_info] Responding to Tab ${requestingTab.id}. Current globally: ${projectData.currentSessionId}. Found for its URL: ${sessionIdForContentScript}`);
                    sendResponse({
                        currentSessionId: projectData.currentSessionId, // Send the global current
                        // You could also send sessionIdForContentScript if it's different, and let content.js decide
                        // or background.js should ensure currentSessionId IS sessionIdForContentScript if this tab is active.
                        // For now, sending the global current means content.js gets whatever background thinks is globally active.
                        // This is simpler if onActivated/onUpdated already correctly set currentSessionId for THIS tab.
                        associatedUrl: requestingTab.url, // Let content.js know its own URL for context
                        // previousSessionId is also available in projectData if needed
                    });

                } else {
                    console.warn("[get_current_session_info] Request did not come from a tab. Sending global currentSessionId.");
                    sendResponse({
                        currentSessionId: projectData.currentSessionId,
                        associatedUrl: null
                    });
                }
                break;
            case 'save_log_to_disk':
                /*
                if (projectData.currentSessionId && projectData.sessions[projectData.currentSessionId]) {
                    const logsToSave = projectData.sessions[projectData.currentSessionId].logEntries;
                    const sessionTitle = projectData.sessions[projectData.currentSessionId].metadata.title || projectData.currentSessionId;
                    const logString = logsToSave.map(entry => `[${new Date(entry.timestamp).toLocaleString()}] (${entry.role} on ${entry.platform}): ${entry.content}`).join('\n\n');
                    const blob = new Blob([logString], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    chrome.downloads.download({
                        url: url,
                        filename: `heartbeat_session_${sessionTitle.replace(/[\s:/]/g, '_')}.txt`,
                    }, () => { URL.revokeObjectURL(url); });
                    sendResponse(true);
                } else {
                    sendResponse(false);
                }
                break;
                */
                const saveResult = await handleSaveLogToDisk(projectData); // Call the dedicated function
                console.log(`[background.js] [chrome.runtime.onMessage] [case 'save_log_to_disk'] saveResult: ${saveResult}`);
                sendResponse(saveResult);
                break;
            // ... other cases like test_prompt_injection, send_to_eddie ...

            case 'get_all_session_summaries':
                const sessionSummaries = Object.entries(projectData.sessions).map(([id, session]) => ({
                    id: id,
                    title: session.metadata?.title || id,
                    startedAt: session.metadata?.startedAt,
                    platform: session.metadata?.platform,
                    logCount: session.logEntries?.length || 0,
                    status: session.metadata?.status || "unknown" // Include status
                })).filter(s => s.status !== "ended_or_deleted"); // Example: filter out explicitly ended sessions
                sendResponse({ sessions: sessionSummaries });
                break;

            case 'set_active_session':
                if (message.sessionId && projectData.sessions[message.sessionId]) {
                    projectData.currentSessionId = message.sessionId;
                    projectData.sessions[message.sessionId].metadata.lastActivityAt = new Date().toISOString();
                    projectData.sessions[message.sessionId].metadata.status = "active"; // Mark as active

                    console.log(`[background.js] Active session changed to: ${message.sessionId}`);
                    await saveProjectData(projectData);

                    // Inform the currently focused Gemini tab (if any) about this change
                    // so its content.js can reset its 'processed DOM IDs' set.
                    const activeTabs = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
                    if (activeTabs && activeTabs[0] && activeTabs[0].id) {
                        const tabToInform = activeTabs[0];
                        // Also need to update our in-memory map
                        tabIdToConversationIdMap[tabToInform.id] = message.sessionId;

                        if (tabToInform.url && (tabToInform.url.startsWith('https://gemini.google.com/') || tabToInform.url.startsWith('https://bard.google.com/'))) {
                            chrome.tabs.sendMessage(tabToInform.id, {
                                type: 'current_session_id_update',
                                currentSessionId: projectData.currentSessionId,
                                associatedUrl: projectData.sessions[message.sessionId].metadata.initiatingUrl || tabToInform.url // Send initiating URL of session
                            }).catch(err => console.warn("[background.js] Could not inform content script of session change after manual set:", err.message));
                        }
                    }
                    sendResponse({ status: 'Active session updated successfully', newSessionId: message.sessionId });
                } else {
                    console.error(`[background.js] set_active_session: Invalid sessionId provided: ${message.sessionId}`);
                    sendResponse({ status: 'Error: Invalid sessionId' });
                }
                break;

            case 'delete_session':
                if (message.sessionId && projectData.sessions[message.sessionId]) {
                    delete projectData.sessions[message.sessionId];
                    console.log(`[background.js] Deleted session: ${message.sessionId}`);
                    // If the deleted session was the current one, we need to pick a new current one or start fresh
                    if (projectData.currentSessionId === message.sessionId) {
                        projectData.currentSessionId = null; // Force re-evaluation or new session start
                        // Try to find another session or start a new one.
                        // For simplicity, let's just say it will start a new one on next action if needed.
                        // Or, you could try to activate the most recent other session.
                        const sessionIds = Object.keys(projectData.sessions);
                        if (sessionIds.length > 0) {
                            // Make the most recent (by startedAt, or just first in list) the current one.
                            // This is simplistic; a better way would be to sort by lastActivityAt or startedAt.
                            projectData.currentSessionId = sessionIds.sort((a, b) =>
                                new Date(projectData.sessions[b].metadata.startedAt) - new Date(projectData.sessions[a].metadata.startedAt)
                            )[0];
                        } else {
                            // No sessions left, startNewSession will be triggered by next 'new_chat_turn' or init logic
                        }
                    }
                    await saveProjectData(projectData);
                    sendResponse({ status: 'Session deleted successfully' });
                } else {
                    sendResponse({ status: 'Error: Session not found for deletion' });
                }
                break;

            case 'force_start_new_session_for_active_tab':

                const currentActiveTabs = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
                if (currentActiveTabs && currentActiveTabs[0]) {
                    const tabInfo = { tabId: currentActiveTabs[0].id, windowId: currentActiveTabs[0].windowId, url: currentActiveTabs[0].url };
                    const platform = determinePlatformFromUrl(tabInfo.url); // You'll need a helper like this
                    projectData = await startNewSession(projectData, platform, tabInfo);
                    tabIdToConversationIdMap[tabInfo.tabId] = projectData.currentSessionId; // Update map
                    await saveProjectData(projectData);
                    sendResponse({ status: 'New session forced for active tab', newSessionId: projectData.currentSessionId });
                } else {
                    sendResponse({ status: 'Error: No active tab found to start new session for.' });
                }
                break;

            case 'content_script_page_status':
                console.log('[background.js] MSG: content_script_page_status received. Full sender object:', sender ? JSON.parse(JSON.stringify(sender)) : 'Sender is null/undefined');
                console.log('[background.js] MSG: content_script_page_status received. Message object:', message ? JSON.parse(JSON.stringify(message)) : 'Message is null/undefined');

                // Ensure sender.tab and sender.tab.id are valid numbers before proceeding
                if (sender && sender.tab && typeof sender.tab.id === 'number' && message && message.payload && typeof message.payload.isFreshPage === 'boolean') {
                    const tabId = sender.tab.id; // Use the validated tabId
                    const { isFreshPage } = message.payload;
                    tabIdToFreshnessMap.set(tabId, isFreshPage);
                    // Use tabId directly in this log
                    console.log(`[background.js] Storing freshness for ACTUAL TabID ${tabId}: isFreshPage = ${isFreshPage}. Map size: ${tabIdToFreshnessMap.size}`);

                    // Provisional response logic
                    let responseSessionId = null;
                    let responseAssociatedUrl = sender.tab.url || null;
                    const currentTabInfoForResponse = {
                        tabId: tabId, // Use validated tabId
                        windowId: sender.tab.windowId || null,
                        url: sender.tab.url || null
                    };

                    const platformDetails = getLLMPlatformAndChatDetails(currentTabInfoForResponse.url);

                    if (platformDetails && platformDetails.isSpecificChat) {
                        for (const sid in projectData.sessions) {
                            const sess = projectData.sessions[sid];
                            if (sess.metadata && sess.metadata.initiatingUrl === currentTabInfoForResponse.url &&
                                sess.metadata.platform === platformDetails.platformId &&
                                sess.metadata.status === "active") {
                                responseSessionId = sid;
                                break;
                            }
                        }
                    } else if (platformDetails && !platformDetails.isSpecificChat && isFreshPage) {
                        if (projectData.currentSessionId && projectData.sessions[projectData.currentSessionId]) {
                            responseSessionId = projectData.currentSessionId;
                        } else {
                            if (currentTabInfoForResponse.url && typeof currentTabInfoForResponse.tabId === 'number') {
                                console.log(`[background.js] content_script_page_status: No global session for fresh page TabID ${currentTabInfoForResponse.tabId}. Starting new conceptual session.`);
                                projectData = await startNewSession(projectData, platformDetails.platformId || 'unknown_fresh_page_init', currentTabInfoForResponse);
                                responseSessionId = projectData.currentSessionId;
                                await saveProjectData(projectData); // Save because new session was started
                            } else {
                                console.warn('[background.js] content_script_page_status: Cannot start new session for fresh page, missing critical tab info in sender.', currentTabInfoForResponse);
                            }
                        }
                    } else { // Not specific, and (not fresh OR freshness unknown OR not LLM)
                        if (projectData.currentSessionId && projectData.sessions[projectData.currentSessionId]) {
                            responseSessionId = projectData.currentSessionId; // Fallback to global if it exists
                        }
                        console.log(`[background.js] content_script_page_status: TabID ${tabId} is generic non-fresh, freshness unknown, or not LLM. Provisional session to send: ${responseSessionId || 'null'}`);
                    }

                    console.log(`[background.js] Sending provisional response to content_script_page_status for TabID ${tabId}: SessionID ${responseSessionId || 'null'}, URL ${responseAssociatedUrl}`);
                    sendResponse({
                        currentSessionId: responseSessionId,
                        associatedUrl: responseAssociatedUrl
                    });

                } else {
                    let warning = '[background.js] content_script_page_status: Malformed message or critical sender info missing.';
                    if (!sender || !sender.tab) warning += ' Sender or sender.tab is missing.';
                    else if (typeof sender.tab.id !== 'number') warning += ` sender.tab.id is not a number (value: ${sender.tab.id}).`;
                    if (!message || !message.payload) warning += ' Message or message.payload is missing.';
                    else if (typeof message.payload.isFreshPage !== 'boolean') warning += ` message.payload.isFreshPage is not a boolean (value: ${message.payload.isFreshPage}).`;

                    console.warn(warning, 'Full Sender:', sender ? JSON.parse(JSON.stringify(sender)) : 'N/A', 'Full Message:', message ? JSON.parse(JSON.stringify(message)) : 'N/A');
                    sendResponse({ error: "Malformed content_script_page_status message or sender info" });
                }
                break;

            default:
                console.warn('[background.js] Unknown message type:', message.type);
                sendResponse({ status: 'Error: Unknown message type' });
        }
    })();
    return true; // Required for asynchronous sendResponse
});

function actOnBird(bird) {
    console.log("Did we get into the actOnBird function?");
    console.log("bird: ", bird);

    if (!bird || !bird.action) return;

    // NEW! ✨
    const clientActions = ['open_url', 'show_alert', 'console_log'];

    if (clientActions.includes(bird.action)) {
        // 👂 Handle as client-side UI action
        chrome.runtime.sendMessage({
            type: "heartbeat_action",
            action: bird.action,
            target: bird.target,
            note: bird.note
        });
    } else {
        // 🛰 Forward as server-side command to Eddie
        fetch('http://localhost:3001/eddie/command-hook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command: bird,
                meta: { source: "heartbeat-v3", timestamp: new Date().toISOString() }
            })
        })
            .then(response => response.json())
            .then(data => {
                console.log('[background.js] Eddie response:', data);
                if (data.responseFormatted) {
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) {
                            chrome.tabs.sendMessage(tabs[0].id, {
                                type: 'insert_response_prompt',
                                command: bird.command,
                                responseUrl: bird.responseUrl,
                                origin: bird.origin || 'eddie'
                            });
                        } else {
                            console.error("[heartbeat-v5] No active tab found for inserting prompt");
                        }
                    });
                } else {
                    console.warn("This command is bunko! LOL")
                    console.log(`bird.command is: ${bird.command}`);
                    console.log(`bird.responseFormatted is: ${bird.responseFormatted}`);
                }
            })
            .catch(err => console.warn('[heartbeat-v3] Failed to ACK bird:', err.message));

        chrome.runtime.sendMessage({ type: 'log_update' });
    }
}

/**
 * Handles session resolution and state updates for a given tab.
 * This is the centralized logic for onActivated and onUpdated events.
 * @param {chrome.tabs.Tab} tab The tab object to process.
 * @param {boolean} isBecomingActive Should be true if this tab is becoming the main active tab.
 */
async function handleTabSessionUpdate(tab, isBecomingActive) {
    if (!tab || !tab.id || !tab.url) {
        console.warn(`[handleTabSessionUpdate] Invalid tab object received.`, tab);
        return;
    }

    console.log(`[handleTabSessionUpdate] Processing TabID: ${tab.id}, Active: ${isBecomingActive}, URL: ${tab.url}`);

    let projectData = await getProjectData();

    // Determine if we should create a new session if one isn't found.
    // Generally, onUpdated (URL change) should create one, but onActivated (just switching) shouldn't.
    const createIfNotFound = !isBecomingActive;
    const result = await resolveSessionForTab(tab, projectData, { createIfNotFound });
    projectData = result.projectData;

    let sessionChanged = false;
    let informContentScript = false;
    let sessionForContentScript = null;

    // The entire switch statement from your onActivated/onUpdated listeners goes here.
    // It's identical, so I'll just show the structure.
    switch (result.decisionType) {
        case 'specific_url_created':
            if (isBecomingActive || result.sessionStartedNow) {
                projectData.currentSessionId = result.sessionIdToMakeActive;
                sessionChanged = true;
            }
            sessionForContentScript = result.sessionIdToMakeActive;
            informContentScript = true;
            break;

        case 'specific_url_match_tab_map':
        case 'specific_url_match_storage':
        case 'specific_url_match_storage_revivable':
            if (isBecomingActive && projectData.currentSessionId !== result.sessionIdToMakeActive) {
                projectData.currentSessionId = result.sessionIdToMakeActive;
                sessionChanged = true;
            }
            if (projectData.sessions[result.sessionIdToMakeActive]) {
                projectData.sessions[result.sessionIdToMakeActive].metadata.status = "active";
                projectData.sessions[result.sessionIdToMakeActive].metadata.lastActivityAt = new Date().toISOString();
            }
            sessionForContentScript = result.sessionIdToMakeActive;
            informContentScript = true;
            break;

        case 'fresh_page_awaits_interaction':
            console.log(`[SESSION_TRACE handleTabUpdate] TabID ${tab.id} is fresh and awaiting interaction. Global currentSessionId (${projectData.currentSessionId || 'null'}) retained.`);
            sessionForContentScript = projectData.currentSessionId || null;
            informContentScript = true;
            break;

        // ... include all other cases from your switch statement here ...
        // no_llm_page, generic_url_not_fresh, etc.

        default:
            console.warn(`[SESSION_TRACE handleTabUpdate] Unhandled decisionType: ${result.decisionType}`);
            // This is the fallback logic for non-session-changing events
            if (isBecomingActive && result.platformId && projectData.currentSessionId) {
                sessionForContentScript = projectData.currentSessionId;
                informContentScript = true;
            }
            break;
    }

    if (sessionChanged) {
        console.log(`✨✨✨ [handleTabSessionUpdate] Global currentSessionId changed to: ${projectData.currentSessionId}`);
        chrome.runtime.sendMessage({ type: 'session_updated', newSessionId: projectData.currentSessionId }).catch(err => console.warn("session_updated broadcast error:", err.message));
    }

    if (informContentScript && result.platformId) {
        chrome.tabs.sendMessage(tab.id, {
            type: 'current_session_id_update',
            currentSessionId: sessionForContentScript,
            associatedUrl: tab.url
        }).catch(err => console.warn(`[handleTabSessionUpdate] Could not send session update to tab ${tab.id}: ${err.message}`));
    }

    await saveProjectData(projectData);
}

// NEW onActivated listener
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const activeTab = await chrome.tabs.get(activeInfo.tabId);
        await handleTabSessionUpdate(activeTab, true); // Tab is becoming active
    } catch (e) {
        console.error(`✨✨✨ [onActivated] Error getting tab info:`, e);
    }
});

// NEW onUpdated listener
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Only act on complete loads with a URL to avoid duplicate processing
    if (changeInfo.status !== 'complete' || !tab.url) {
        return;
    }

    // `tab.active` tells us if the tab that finished loading is the currently focused one.
    await handleTabSessionUpdate(tab, tab.active);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    console.log(`[SESSION_TRACE onRemoved] Tab removed: ${tabId}`);
    if (tabIdToConversationIdMap[tabId]) {
        // Optionally, mark the session as "ended" in projectData if desired
        // const conversationId = tabIdToConversationIdMap[tabId];
        // projectData.sessions[conversationId].metadata.endedAt = new Date().toISOString();
        // saveProjectData(projectData); // If you modify projectData
        delete tabIdToConversationIdMap[tabId];
        console.log(`[SESSION_TRACE onRemoved] Removed mapping for tabId: ${tabId}`);
    }
});

// ========== INITIALIZATION =========

// Initialize storage handling
// loadBuffersFromStorage();  <--  Removed this function.
// setupStorageAutoSave();    <--  Removed this function.

// Start the heartbeat bird polling
// startHeartbeatPolling();
// This will be replaced by the bird calls alerting their targets when they arrive into the 'bird house' buffer later on

// console.log("[heartbeat-v5] Multi-model background script fully initialized. Active model:", activeModel);
console.log("[background.js] Option B session management initialized.");
console.log("[heartbeat-v5.55] Multi-model background script fully initialized. Active model: tbd");