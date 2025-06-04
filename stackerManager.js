// stackerManager.js (V2)

const MAX_STACKER_CHUNKS = 3;
const STACKER_RECENCY_BUFFER_SIZE = 1;

/**
 * Initializes Stacker-related arrays for a given session object.
 * This function is called by startNewSession.
 * @param {object} sessionObject - The specific session object from projectData.sessions[sessionId].
 */
function initializeStackerForSession(sessionObject) {
    if (!sessionObject) {
        console.error("[StackerManager] initializeStackerForSession: Received null or undefined session object.");
        return;
    }
    if (!sessionObject.stackerChunks) {
        sessionObject.stackerChunks = [];
    }
    if (sessionObject.metadata && sessionObject.metadata.turnsProcessedByStacker !== undefined) {
        delete sessionObject.metadata.turnsProcessedByStacker; // Clean up old field if present
    }
    if (!sessionObject.stackerProcessingBuffer) {
        sessionObject.stackerProcessingBuffer = [];
    }
    // console.log(`[StackerManager] Initialized Stacker arrays for session. Max chunks: ${MAX_STACKER_CHUNKS}`);
}

/**
 * Manages the recency buffer for a specific session and graduates items to its main Stacker.
 * @param {object} projectData - The entire project data object.
 * @param {object} newExchangeChunk - The newly created exchange chunk.
 * @param {string} targetSessionId - The ID of the session this chunk belongs to.
 * @returns {boolean} True if the main Stacker for the targetSessionId was updated, false otherwise.
 */
async function manageStackerBuffer(projectData, newExchangeChunk, targetSessionId) {
    if (!targetSessionId || !projectData.sessions[targetSessionId]) {
        console.error(`[BufferMgr V2] Invalid targetSessionId: ${targetSessionId} or session not found.`);
        return false;
    }
    const sessionForBuffer = projectData.sessions[targetSessionId];

    // Ensure stackerProcessingBuffer is initialized (should be by initializeStackerForSession)
    if (!sessionForBuffer.stackerProcessingBuffer) {
        console.warn(`[BufferMgr V2] stackerProcessingBuffer missing for session ${targetSessionId}. Initializing.`);
        sessionForBuffer.stackerProcessingBuffer = [];
    }

    sessionForBuffer.stackerProcessingBuffer.push(newExchangeChunk);
    console.log(`[BufferMgr V2] Added chunk ${newExchangeChunk.chunk_id} to recency buffer for session ${targetSessionId}. Buffer size: ${sessionForBuffer.stackerProcessingBuffer.length}`);

    let mainStackerWasUpdated = false;
    while (sessionForBuffer.stackerProcessingBuffer.length > STACKER_RECENCY_BUFFER_SIZE) {
        const chunkToGraduate = sessionForBuffer.stackerProcessingBuffer.shift();
        if (chunkToGraduate) {
            console.log(`[BufferMgr V2] Graduating chunk ${chunkToGraduate.chunk_id} from buffer to main Stacker for session ${targetSessionId}.`);
            if (typeof processNewLogEntryForStacker === 'function') {
                // Pass projectData, the chunk, and crucially, the targetSessionId
                const processed = processNewLogEntryForStacker(projectData, chunkToGraduate, targetSessionId);
                if (processed) {
                    mainStackerWasUpdated = true;
                }
            } else {
                console.error("[BufferMgr V2] processNewLogEntryForStacker is not defined!");
            }
        }
    }
    return mainStackerWasUpdated;
}

/**
 * Processes a new exchange chunk by adding it to the Stacker for a specific session.
 * @param {object} projectData - The entire project data object.
 * @param {object} newlyAddedExchangeChunk - The exchange chunk to add to the Stacker.
 * @param {string} targetSessionId - The ID of the session whose Stacker should be updated.
 * @returns {boolean} True if the chunk was processed, false otherwise.
 */
function processNewLogEntryForStacker(projectData, newlyAddedExchangeChunk, targetSessionId) {
    if (!targetSessionId || !projectData.sessions[targetSessionId]) {
        console.error(`[StackerManager V2] Invalid targetSessionId: ${targetSessionId} or session not found in processNewLogEntryForStacker.`);
        return false;
    }
    const sessionForStacker = projectData.sessions[targetSessionId];

    // Ensure stackerChunks is initialized (should be by initializeStackerForSession)
    if (!sessionForStacker.stackerChunks) {
        console.warn(`[StackerManager V2] stackerChunks missing for session ${targetSessionId}. Initializing.`);
        sessionForStacker.stackerChunks = [];
    }

    if (!newlyAddedExchangeChunk || !newlyAddedExchangeChunk.chunk_id) {
        console.warn("[StackerManager V2] Received an invalid or empty newlyAddedExchangeChunk. Skipping.");
        return false;
    }

    console.log(`[StackerManager V2] Processing new exchange chunk for Stacker in session ${targetSessionId}: ${newlyAddedExchangeChunk.chunk_id}`);

    const stackerItem = newlyAddedExchangeChunk;

    sessionForStacker.stackerChunks.unshift(stackerItem); // Add to the BEGINNING (most recent)
    console.log(`[StackerManager V2] New item added to Stacker for session ${targetSessionId}. Current stack size: ${sessionForStacker.stackerChunks.length}`);

    // Maintain the sliding window
    if (sessionForStacker.stackerChunks.length > MAX_STACKER_CHUNKS) {
        const removedChunk = sessionForStacker.stackerChunks.pop(); // Remove the OLDEST from the END
        console.log(`[StackerManager V2] Stacker chunk limit (${MAX_STACKER_CHUNKS}) for session ${targetSessionId} reached. Oldest item (chunk_id: ${removedChunk?.chunk_id}) removed.`);
    }

    console.log(`[StackerManager V2] Finished processing for Stacker in session ${targetSessionId}. Total items in stack: ${sessionForStacker.stackerChunks.length}`);
    return true;
}