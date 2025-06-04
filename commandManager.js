// commandManager.js v5.55

const commandQueue = [];
let commandIdCounter = 0;

console.log('[commandManager.js v5.55] typeof detectCommadsInText after import:', typeof getCommandsInText);

// /**
//  * Searches for and extracts the content within a (((RUNCODE)))...(((/RUNCODE))) block.
//  * @param {string} text - The full text from the user or assistant.
//  * @returns {string|null} The content inside the block, or null if no block is found.
//  */
// function getCommandsFromBlock(text, role) {
//     const runcodeRegex = /\(\(\(RUNCODE\)\)\)([\s\S]*?)\(\(\(\/RUNCODE\)\)\)/g;
//     const runcodeUserRegex = /\|\|\|RUNCODE\|\|\|([\s\S]*?)\|\|\|\/RUNCODE\|\|\|/g;
//     const match = runcodeRegex.exec(text);
//     const alsoMatch = runcodeUserRegex.exec(text);
//     if (match && match[1] && role === 'assistant') {
//         const commands = match[1].trim();
//         console.log("✅ LLM RUNCODE block found. Extracted commands:", commands);
//         return commands;
//     } else if (alsoMatch && alsoMatch[1] && rolerole === 'user') {
//         const commands = alsoMatch[1].trim();
//         console.log("✅ User RUNCODE block found. Extracted commands:", commands);
//         return commands;
//     }
//     return null;
// }

// /**
//  * Searches for and extracts the content within a role-appropriate RUNCODE block.
//  * @param {string} text - The full text from the user or assistant.
//  * @param {string} role - The role of the sender ('user' or 'assistant').
//  * @returns {string|null} The content inside the block, or null if no valid block for that role is found.
//  */
// function getCommandsFromBlock(text, role) {
//     let runcodeRegex;
//     let blockType;

//     if (role === 'assistant') {
//         runcodeRegex = /\(\(\(RUNCODE\)\)\)([\s\S]*?)\(\(\(\/RUNCODE\)\)\)/g;
//         blockType = "Assistant (((RUNCODE)))";
//     } else if (role === 'user') {
//         runcodeRegex = /\|\|\|RUNCODE\|\|\|([\s\S]*?)\|\|\|\/RUNCODE\|\|\|/g; // Note the escaped pipes
//         blockType = "User |||RUNCODE|||";
//     } else {
//         console.warn(`[getCommandsFromBlock] Unknown role: ${role}`);
//         return null; // Unknown role, no commands
//     }

//     const match = runcodeRegex.exec(text);
//     const userMatch = runcodeRegex.exec(text); // For user role, we use the same regex but with pipes

//     if (match && match[1]) {
//         const commands = match[1].trim();
//         // console.log(`✅ ${blockType} block found. Extracted commands:`, commands);
//         console.log(`✅ [getCommandsFromBlock] blockTypefound.Extractedcontent:"{commands}"`);
//         return commands; // Return the raw content OF THE BLOCK
//     } else if (userMatch && userMatch[1]) {
//         const commands = userMatch[1].trim();
//         // console.log(`✅ ${blockType} block found. Extracted commands:`, commands);
//         console.log(`✅ [getCommandsFromBlock] blockTypefound.Extractedcontent:"{commands}"`);
//         return commands; // Return the raw content OF THE BLOCK
//     } else {
//         console.warn(`[commandManager.js 5.55] [getCommandsFromBlock] No valid ${blockType} block found in text.`);
//     }

//     // No valid RUNCODE block was found for this role and syntax.
//     return null;
// }

function getCommandsFromBlock(text, role) {
    let runcodeRegex;
    let blockType;
    console.log(`[getCommandsFromBlock] Starting to get commands from block for role: ${role}`);

    if (role === 'assistant') {
        runcodeRegex = /\(\(\(RUNCODE\)\)\)([\s\S]*?)\(\(\(\/RUNCODE\)\)\)/g; // For (((RUNCODE)))
        blockType = "Assistant (((RUNCODE)))";
    } else if (role === 'user') {
        runcodeRegex = /\|\|\|RUNCODE\|\|\|([\s\S]*?)\|\|\|\/RUNCODE\|\|\|/g; // For |||RUNCODE|||
        blockType = "User |||RUNCODE|||";
    } else {
        console.warn(`[getCommandsFromBlock] Unknown role: ${role}`);
        return null;
    }

    const match = runcodeRegex.exec(text); // This uses the role-specific regex

    if (match && match[1]) {
        const commands = match[1].trim();
        console.log(`✅ [getCommandsFromBlock] blockTypefound.Extractedcontent: ${commands}`);
        return commands; // Returns the content IF the role-specific block is found
    }

    // If we reach here, it means the role-specific RUNCODE block was NOT found
    // It will implicitly return null if no match was found.
    // You could add your console.warn here:
    console.warn(`[getCommandsFromBlock] No valid ${blockType} block found in text for role '${role}'.`);
    return null;
}

/**
 * Parses actual commands from within an already validated RUNCODE block's content,
 * based on the role, and then queues them using queueDetectedCommands.
 * @param {string} blockContent - The raw string content from inside a RUNCODE block.
 * @param {string} role - 'user' or 'assistant'.
 * @param {string} sessionId - The current session ID.
 * @param {object} projectData - The project data object.
 * @returns {Promise<string|null>} Potential text to inject from processed commands (returned by queueDetectedCommands).
 */
async function processCommandBlockContent(blockContent, role, sessionId, projectData) {
    console.log(`[CommandManager] processCommandBlockContent received for role: '${role}'. Content: "${blockContent}"`);

    // This object will be populated and then passed to your existing queueDetectedCommands
    let detectedCommandsForQueueing = {
        llmCommands: [],
        userCommands: []
    };

    if (role === 'assistant') {
        // Regex to find all (((COMMAND args))) within the blockContent
        // Example: (((NOTIFY Hello there))) or (((RECALL important stuff)))
        const assistantCommandRegex = /\(\(\(([\w-]+)\s*(.*?)\)\)\)/g;
        let match;
        while ((match = assistantCommandRegex.exec(blockContent)) !== null) {
            detectedCommandsForQueueing.llmCommands.push({
                raw: match[0],                      // The full "(((COMMAND args)))"
                command: match[1].toUpperCase(),    // "COMMAND"
                args: match[2] ? match[2].trim() : "" // "args"
            });
        }
        // } else if (role === 'user') { // NO COMANDS FOR USER YET!
        //     // Regex to find all |||COMMAND args||| within the blockContent
        //     // Example: |||NOTIFY User message||| or |||STATUS Stacker|||
        //     const userCommandRegex = /\|\|\|([\w-]+)\s*(.*?)\|\|\|/g;
        //     let match;
        //     while ((match = userCommandRegex.exec(blockContent)) !== null) {
        //         detectedCommandsForQueueing.userCommands.push({
        //             raw: match[0],                      // The full "|||COMMAND args|||"
        //             command: match[1].toUpperCase(),    // "COMMAND"
        //             args: match[2] ? match[2].trim() : "" // "args"
        //         });
        //     }
    } else {
        console.warn(`[CommandManager] processCommandBlockContent: Unknown role '${role}'. No commands parsed.`);
        return null;
    }

    // Now, check if any commands were actually parsed from the block content
    if (detectedCommandsForQueueing.llmCommands.length > 0 || detectedCommandsForQueueing.userCommands.length > 0) {
        console.log('[CommandManager] Commands parsed from block content:', detectedCommandsForQueueing);

        // Call your existing queueDetectedCommands function to handle these
        // It expects the 'senderRole' which is our 'role' parameter here.
        return await queueDetectedCommands(detectedCommandsForQueueing, role, sessionId, projectData);
    } else {
        console.log('[CommandManager] No specific commands found within the RUNCODE block content using role-specific syntax.');
        return null;
    }
}

// --- Sanitization (inspired by your v5 sanitizeTextForSave) ---
function sanitizeTextForLogging(text, detectedCommands) {
    let sanitizedText = text;
    if (!detectedCommands) {
        return sanitizedText;
    }

    // Process in a specific order to avoid conflicts if markers are substrings of others
    // For MVP, we'll just strip the outermost layer of our primary command types.
    // More sophisticated stripping might be needed if commands can be nested or complex.

    const allFoundRawCommands = [];
    if (detectedCommands.llmCommands) {
        detectedCommands.llmCommands.forEach(cmd => allFoundRawCommands.push(cmd.raw));
    }
    if (detectedCommands.userCommands) {
        detectedCommands.userCommands.forEach(cmd => allFoundRawCommands.push(cmd.raw));
    }
    if (detectedCommands.semanticTokens) {
        detectedCommands.semanticTokens.forEach(cmd => allFoundRawCommands.push(cmd.raw));
    }
    if (detectedCommands.systemMessages) {
        detectedCommands.systemMessages.forEach(cmd => allFoundRawCommands.push(cmd.raw));
    }

    // Sort by length descending to replace longer matches first
    allFoundRawCommands.sort((a, b) => b.length - a.length);

    allFoundRawCommands.forEach(rawCmd => {
        let strippedCmd = '';
        if (typeof rawCmd === 'string' && rawCmd.trim() !== '') {

            if (rawCmd.startsWith('(((') && rawCmd.endsWith(')))')) {
                strippedCmd = rawCmd.substring(1, rawCmd.length - 1); // ((COMMAND))
            } else if (rawCmd.startsWith('|||') && rawCmd.endsWith('|||')) {
                strippedCmd = rawCmd.substring(1, rawCmd.length - 1); // ||COMMAND||
            } else if (rawCmd.startsWith('[[[') && rawCmd.endsWith(']]]')) {
                // strippedCmd = rawCmd.substring(1, rawCmd.length - 1); // [[TOKEN]]
                strippedCmd = rawCmd; // [[[TOKEN]]] stays as is

            } else if (rawCmd.startsWith('{{{') && rawCmd.endsWith('}}}')) { // Simplified for example
                strippedCmd = rawCmd.substring(1, rawCmd.length - 1); // {{SYSTEM}}
            } else {
                strippedCmd = rawCmd; // Should not happen if detected correctly
            }
            // Escape special characters in rawCmd for regex, then replace
            const escapedRawCmd = rawCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            sanitizedText = sanitizedText.replace(new RegExp(escapedRawCmd, 'g'), strippedCmd);
        } else {
            console.warn('[CommandManager] [sanitizeTextForLogging] Skipped an undefined, null, or empty rawCmd:', rawCmd);
        }
    });

    return sanitizedText;
}

// --- Command Handling ---
async function queueCommand(commandDetails, senderRole, sessionId, commandTypeFromDetection, projectData) {

    // commandDetails is an object like { raw: "...", command: "CMD", args: "..." }
    // commandTypeFromDetection is 'llm' or 'user' (or 'semantic', 'system')

    // Simple deduplication check: Has this exact raw command string from this source
    // in this session been queued very recently and is still pending/in_process?
    // This is a basic check; more sophisticated would involve looking at timestamps.
    const isDuplicatePending = commandQueue.some(
        cmd => cmd.rawCommandString === commandDetails.raw &&
            cmd.sessionId === sessionId &&
            cmd.source === senderRole &&
            (cmd.state === 'queued' || cmd.state === 'in_process')
    );

    if (isDuplicatePending) {
        console.warn('[CommandManager] Duplicate command detected and still pending, skipping queueing:', commandDetails.raw);
        return; // Don't queue if it looks like an immediate duplicate
    }

    const newCommand = {
        id: `cmd-${sessionId}-${Date.now()}-${commandIdCounter++}`,
        timestampDetected: new Date().toISOString(),
        rawCommandString: commandDetails.raw,
        parsedCommand: commandDetails.command.toUpperCase(),
        args: commandDetails.args,
        source: senderRole, // 'user' or 'assistant'
        commandType: commandTypeFromDetection, // 'llm', 'user', 'semantic', 'system'
        sessionId: sessionId,
        state: 'queued',
        executionAttempts: 0,
        result: null,
        error: null
    };

    commandQueue.push(newCommand);
    // console.log('[CommandManager] Queued command:', newCommand);
    console.log('[CommandManager] Queued command. Current Queue:', JSON.parse(JSON.stringify(commandQueue)));

    // // For MVP, process immediately if it's NOTIFY
    // if (newCommand.parsedCommand === 'NOTIFY') {
    //     processCommand(newCommand);
    // }

    // For MVP, let's try to process NOTIFY immediately if it's an LLM command
    // * * * * * AJG: But ONLY if it is processed AFTER the assistant has finished typing and the exchange is logged. * * * * *
    // We'll build a more robust processQueue function later for other commands.

    // if (newCommand.parsedCommand === 'NOTIFY' && newCommand.commandType === 'llm') {
    //     processCommand(newCommand.id); // Pass ID to find it in the queue
    // } else if (newCommand.commandType === 'user' && newCommand.parsedCommand === 'NOTIFY') {
    //     // As per your spec, user NOTIFY does nothing for alerts
    //     console.log(`[CommandManager] User command |||NOTIFY||| detected: "${newCommand.rawCommandString}". Not actioning alert.`);
    //     const cmdInQueue = commandQueue.find(c => c.id === newCommand.id);
    //     if (cmdInQueue) cmdInQueue.state = 'ignored_user_command';
    // } else if (newCommand.commandType === 'llm') {
    //     console.log(`[commandManager] [queueCommand] In llm check, but not NOTIFY, sending ${newCommand.id} to processCommand.`);
    //     return processCommand(newCommand.id); // processCommand now returns textToInject or null
    // } else if (newCommand.commandType === 'user') {
    //     processCommand(newCommand.id); // Process user commands (they won't inject for now)
    //     return null;
    // }
    // return null;
    // NOW REPLACED WITH THIS:
    // *
    //
    let processingResult = null;
    // We only expect 'llm' or 'user' types to be processed for now for actions/injections
    if (newCommand.commandType === 'llm' || newCommand.commandType === 'user') {
        processingResult = await processCommand(newCommand.id, projectData); // processCommand needs projectData
    }

    console.log(`[CommandManager] queueCommand: For command ID <span class="math-inline">\{newCommand\.id\} \(</span>{newCommand.parsedCommand}), processingResult is: "${processingResult}"`);
    return processingResult;
} // MAYBE THIS WILL WORK??? The else if for notify is also still in here...
// This is going to have to end up being some fancier parsing soon.

async function queueDetectedCommands(detectedCmds, senderRole, sessionId, projectData) {

    let textToInject = null;

    console.log('[commandManager.js v5.55] queueDetectedCommands called with:', detectedCmds, 'Role:', senderRole);

    if (detectedCmds && detectedCmds.llmCommands) {

        for (const cmd of detectedCmds.llmCommands) {
            const result = await queueCommand(cmd, senderRole, sessionId, 'llm', projectData); // queueCommand returns text to inject
            if (result && typeof result === 'string' && !textToInject) textToInject = result; // Take the first one for now
            // do we REALLY need to check if typeof result === 'string'? Will we pass other data?
        }
        //        detectedCmds.llmCommands.forEach(cmd => queueCommand(cmd, senderRole, sessionId, 'llm'));
    }

    // NO USER COMMANDS YET, BUT IF WE DO:
    // if (detectedCmds && detectedCmds.userCommands) {
    //     for (const cmd of detectedCmds.userCommands) {
    //         // User commands currently don't return injectable text from processCommand
    //         await queueCommand(cmd, senderRole, sessionId, 'user', projectData);
    //     }
    //     //        detectedCmds.userCommands.forEach(cmd => queueCommand(cmd, senderRole, sessionId, 'user'));
    // }

    // Add semanticTokens and systemMessages later if they become actionable
    // For now, they are detected by content.js but not added to the actionable commandQueue here.
    // background.js can decide to store them in a different part of the session data if needed.

    console.log('[CommandManager] queueDetectedCommands: final textToInject being returned:', textToInject);

    return textToInject; // Return to background.js

}

// The entry point in your content script (e.g., content.js) will need to be updated
// to pass the full, raw text to this function, not just the detectedCmds object.

// /**
//  * SHOULD recieve the full raw text from the user or assistant message but is getting just detectedCommands instead.
//  *  message.detectedCommands, 
//  *  message.role,
//  *  conversationIdForThisTurn,
//  *  projectData
//  *  
//  * @param {*} fullRawText 
//  * @param {*} senderRole 
//  * @param {*} sessionId 
//  * @param {*} projectData 
//  * @returns 
//  */
// async function queueCommandsFromText(fullRawText, senderRole, sessionId, projectData) {
//     console.log('[commandManager.js 5.55] [queueCommandsFromText] Starting command processing for text from:', senderRole);

//     // --- NEW: Step 1 - Check for a RUNCODE block ---
//     const commandBlockText = getCommandsFromBlock(fullRawText, senderRole); // Is senderRole who triggered a command or who is checking?

//     if (commandBlockText === null) {
//         // console.log('[CommandManager] No RUNCODE block found. No commands will be processed.');
//         return null; // Exit early if no block is found
//     }

//     // --- Step 2: If a block was found, detect commands ONLY within that block ---
//     // We assume you have a function, let's call it `detectAllCommandsInText`,
//     // that was previously running on the full text. Now we run it on the smaller commandBlockText.
//     // This `detectAllCommandsInText` would be the function that generates the `detectedCmds` object.

//     // For now, let's placeholder this detection step. Your existing detection logic needs to be
//     // wrapped in a function that we can call here.

//     // const detectedCmds = detectAllCommandsInText(commandBlockText); // This is a hypothetical function name
//     const detectedCmds = detectCommandsInText(commandBlockText); // This MIGHT be the function?

//     // --- Step 3: The rest of your queuing logic remains the same ---
//     let textToInject = null;
//     console.log('[CommandManager] RUNCODE block validated. Now queuing detected commands:', detectedCmds);

//     if (detectedCmds && detectedCmds.llmCommands) {
//         for (const cmd of detectedCmds.llmCommands) {
//             const result = await queueCommand(cmd, senderRole, sessionId, 'llm', projectData);
//             if (result && typeof result === 'string' && !textToInject) textToInject = result;
//         }
//     }
//     if (detectedCmds && detectedCmds.userCommands) {
//         for (const cmd of detectedCmds.userCommands) {
//             await queueCommand(cmd, senderRole, sessionId, 'user', projectData);
//         }
//     }

//     console.log('[CommandManager] Finished queuing. Final textToInject being returned:', textToInject);
//     return textToInject;
// }

async function processCommand(commandId, projectData) {
    // const command = commandQueue.find(cmd => cmd.id === commandId && cmd.state === 'queued');
    const command = commandQueue.find(cmd => (cmd.state === 'queued' || cmd.state === 'pending_processing'));

    // if (!command) { /* ... */ return null; }

    if (!command) {
        console.warn(`[CommandManager] processCommand: Command ID ${commandId} not found or not in 'queued' state.`);
        return null;
    }

    command.state = 'in_process';
    command.executionAttempts++;
    let injectionText = null;

    console.log('[background.js v5.55] [CommandManager] Processing command:', JSON.parse(JSON.stringify(command)));
    // command.state = 'in_process';
    // command.executionAttempts++;

    // Main routing logic (as per your preference for LLM NOTIFY only)
    if (command.commandType === 'llm' && command.source === 'assistant') {
        // This is an LLM command from the assistant, we can process it

        switch (command.parsedCommand) {
            case 'NOTIFY':
                handleNotifyCommand(command); // This will set final state (completed/failed)
                break;
            case 'ECHO': // NEW CASE
                injectionText = handleEchoCommand(command); // Sets its own final state
                // console.log(`ECHO's command.state is ${command.state}`);
                console.log(`[CommandManager] processCommand (ECHO): command.state is ${command.state}, injectionText: "${injectionText}"`);
                break;
            case 'RECALL':
                // handleRecallCommand just validates and sets up for background.js action
                await handleRecallCommand(command); // It updates command.state and command.result
                // No injectionText, background.js will see command.result.action
                // injectionText = await handleRecallCommand(command, projectData); // Pass projectData
                break;
            // case 'SYSTEM_COMMAND': // New command type
            //     console.log(`Did we even get in to SYSTEM_COMMAND? command.args is: "${command.args}"`);
            // if (command.args.toUpperCase() === 'ACTIVATE_COMMAND_MODE' || command.args.toUpperCase() === 'SET_PROGRAMMING_MODE ON') {
            //     isAssistantCommandModeActive = true;
            //     console.log('[CommandManager] Assistant Command Mode ACTIVATED by LLM.');
            //     command.state = 'completed';
            // } else if (command.args.toUpperCase() === 'DEACTIVATE_COMMAND_MODE' || command.args.toUpperCase() === 'SET_PROGRAMMING_MODE OFF') {
            //     isAssistantCommandModeActive = false;
            //     console.log('[CommandManager] Assistant Command Mode DEACTIVATED by LLM.');
            //     command.state = 'completed';
            // } else {
            //     console.warn('[CommandManager] Unknown SYSTEM_COMMAND args:', command.args);
            //     command.state = 'failed';
            // }
            case 'SYSTEM_COMMAND': // New command type
                console.log(`[CommandManager] Processing SYSTEM_COMMAND. Raw command.args: "${command.args}"`);

                // Trim command.args FIRST, then split, then take the first part.
                const parts = command.args.trim().toUpperCase().split(' ');
                const subCommandKey = parts[0];

                console.log(`[CommandManager] After trim().toUpperCase().split(' '): parts[0] is "${subCommandKey}"`); // Log the key
                console.log(`[CommandManager] Entire 'parts' array from split:`, parts); // Log the whole array from split

                console.log(`command.args.toUpperCase() is: ${command.args.toUpperCase()}`);

                // switch (command.args.toUpperCase()) {
                switch (subCommandKey) {
                    case 'ACTIVATE_COMMAND_MODE':
                    case 'SET_PROGRAMMING_MODE ON':
                        isAssistantCommandModeActive = true;
                        console.log('[CommandManager] Assistant Command Mode ACTIVATED by LLM.');
                        command.state = 'completed';
                        break;
                    case 'DEACTIVATE_COMMAND_MODE':
                    case 'SET_PROGRAMMING_MODE OFF':
                        isAssistantCommandModeActive = false;
                        console.log('[CommandManager] Assistant Command Mode DEACTIVATED by LLM.');
                        command.state = 'completed';
                        break;
                    case 'INIT_FURBY_MODE':
                        console.log('[CommandManager] !!! ENTERED INIT_FURBY_MODE CASE !!!');
                        // Extract the JSON part of the args.
                        // The subCommandKey "INIT_FURBY_MODE" should be parts[0].
                        // The rest of the 'parts' array joined back together should be the JSON string.
                        const jsonArgsString = parts.slice(1).join(' ').trim(); // Get everything AFTER the first word
                        console.log(`[CommandManager] INIT_FURBY_MODE: jsonArgsString to parse: "${jsonArgsString}"`);

                        // Sets isFurbyModeActive = true.
                        // Sets furbyAlphaTabId and furbyBravoTabId (we'll need to get these IDs, perhaps you can provide them from console after opening the tabs).
                        // Sets nextFurbyToSpeak = 'alpha' (or 'bravo', to decide who starts).
                        try {
                            // Args for INIT_FURBY_MODE are expected to be a JSON string like:
                            // '{"alphaTabId": 123, "bravoTabId": 456, "firstSpeaker": "alpha"}'
                            // The command from LLM would be: (((SYSTEM_COMMAND INIT_FURBY_MODE {"alphaTabId":123,"bravoTabId":456,"firstSpeaker":"alpha"})))
                            const jsonArgsString = command.args.substring('INIT_FURBY_MODE'.length).trim();
                            console.log(`[CommandManager] INIT_FURBY_MODE: jsonArgsString to parse: "${jsonArgsString}"`);

                            const furbyParams = JSON.parse(jsonArgsString);
                            console.log('[CommandManager] INIT_FURBY_MODE: furbyParams parsed:', furbyParams);

                            // const furbyArgsString = command.args.substring('INIT_FURBY_MODE'.length).trim();
                            // const furbyParams = JSON.parse(furbyArgsString);

                            console.log(`jsonArgsString: ${jsonArgsString}
                                furbyParams: ${furbyParams}`);

                            if (furbyParams && typeof furbyParams.alphaTabId !== 'undefined' && typeof furbyParams.bravoTabId !== 'undefined') {
                                // Call the function in background.js
                                const success = activateFurbyMode(
                                    furbyParams.alphaTabId,
                                    furbyParams.bravoTabId,
                                    furbyParams.firstSpeaker // Optional, defaults in activateFurbyMode
                                );
                                if (success) {
                                    command.state = 'completed';
                                    console.log('[CommandManager] INIT_FURBY_MODE successful.');
                                } else {
                                    command.state = 'failed';
                                    command.error = 'Invalid Tab IDs for INIT_FURBY_MODE.';
                                    console.error(command.error);
                                }
                            } else {
                                throw new Error("INIT_FURBY_MODE requires {alphaTabId, bravoTabId} in JSON args.");
                            }
                        } catch (e) {
                            console.error('[CommandManager] Error processing INIT_FURBY_MODE args:', e.message, "Args received:", command.args);
                            command.state = 'failed';
                            command.error = `Invalid arguments for INIT_FURBY_MODE: ${e.message}`;
                        }
                        break;
                    case 'STOP_FURBY_MODE':
                        // Sets isFurbyModeActive = false.
                        // Clears the tab IDs.
                        // Call the function in background.js
                        console.log('[CommandManager] !!! ENTERED STOP_FURBY_MODE CASE !!!'); // Canary log
                        deactivateFurbyMode();
                        command.state = 'completed';
                        console.log('[CommandManager] STOP_FURBY_MODE successful.');
                        break;
                    default:
                        console.warn('[CommandManager] Unknown SYSTEM_COMMAND args:', command.args);
                        command.state = 'failed';
                        command.error = 'Unknown SYSTEM_COMMAND arguments';
                        break;
                }
                break;
            //  etc.
            default:
                console.warn(`[CommandManager] Unknown LLM command: ${command.parsedCommand}`, command);
                command.state = 'failed';
                command.error = 'Unknown LLM command type';
        }
        // } else if (command.commandType === 'user') {
        //     console.log(`[CommandManager] User command "${command.parsedCommand}" received. Raw: "${command.rawCommandString}". No action defined for this user command yet.`);
        //     command.state = 'ignored_user_command'; // Or 'completed_no_action'
        // } else {
        //     console.error("[CommandManager] Command with unknown type/source during processing:", command);
        //     command.state = 'failed';
        // }

        // } else if (command.commandType === 'user') {

        //     // if (command.parsedCommand === 'NOTIFY') { // Example for user NOTIFY
        //     //     console.log(`[CommandManager] User command |||NOTIFY||| detected with args: "${command.args}". Not actioning alert.`);
        //     //     command.state = 'ignored_user_notify';
        //     // } else {
        //     //     console.log(`[CommandManager] User command "<span class="math-inline">\{command\.parsedCommand\}" received\. Raw\: "</span>{command.rawCommandString}". No specific action defined.`);
        //     //     command.state = 'ignored_user_command';
        //     // }

        //     switch (command.parsedCommand) {
        //         case 'NOTIFY':
        //             console.log(`[CommandManager] User command |||NOTIFY||| detected with args: "${command.args}". Not actioning alert.`);
        //             command.state = 'ignored_user_notify';
        //             break;
        //         case 'STATUS':
        //             console.log(`[CommandManager] User command |||STATUS||| detected. No action defined for user status command.`);
        //             command.state = 'ignored_user_command'; // Or 'completed_no_action'
        //             break;
        //         // Add other user command handlers here if any become actionable
        //         default:
        //             console.log(`[CommandManager] User command "${command.parsedCommand}" received. Raw: "${command.rawCommandString}". No specific action defined.`);
        //             command.state = 'ignored_user_command';
        //     }

    } else {
        console.error("[CommandManager] Command with unknown type during processing:", command);
        command.state = 'failed';
    }

    // After switch and command state is final:
    if (command && ['completed', 'failed', 'ignored_user_command', 'completed_popup_unconfirmed'].includes(command.state)) {
        const index = commandQueue.findIndex(cmd => cmd.id === commandId);
        if (index > -1) {
            commandQueue.splice(index, 1);
            console.log(`[CommandManager] Command ${commandId} processed and removed. State: ${command.state}. New queue size: ${commandQueue.length}`);
        }
    }

    console.log('[CommandManager] Post-processing. Current Queue:', JSON.parse(JSON.stringify(commandQueue)));
    return injectionText; // Return text that needs to be injected by background.js

}

function handleNotifyCommand(command) { // command is the full command object
    const messageArg = command.args;
    let notificationMessage = '';

    // Only proceed if it's an LLM command (already filtered by processCommand, but good check)
    if (command.commandType !== 'llm' && command.source !== 'assistant') {
        console.warn('[CommandManager] handleNotifyCommand called for non-LLM command. Ignoring.', command);
        command.state = 'failed';
        command.error = 'Notify is only for LLM commands';
        return;
    }

    if (!messageArg) {
        console.warn(`[CommandManager] LLM command (((${command.parsedCommand}))) issued without arguments. Showing default notification.`);
        notificationMessage = `[ASSISTANT] ${command.parsedCommand}: Received command with no message.`;
    } else {
        notificationMessage = `[ASSISTANT] ${command.parsedCommand}: ${messageArg}`;
    }

    console.log(`[CommandManager] handleNotifyCommand: Attempting to send show_popup_notification with message: "${notificationMessage}" for command ID: ${command.id}`);
    chrome.runtime.sendMessage({
        type: 'show_popup_notification',
        message: notificationMessage
    })
        //   .then(response => {
        //     if (response && response.status === "Notification shown in popup") {
        //         console.log("[CommandManager] Popup confirmed notification shown for:", command.id);
        //         command.state = 'completed';
        //     } else {
        //         console.warn("[CommandManager] Popup did not confirm notification or sent unexpected response for:", command.id, response);
        //         command.state = 'completed_popup_unconfirmed';
        //     }

        .then(response => {
            // Check if popup explicitly confirmed. The key is that the sendMessage itself didn't error.
            if (response && response.status && response.status.includes("Notification shown")) {
                console.log("[CommandManager] Popup confirmed notification shown for:", command.id);
                command.state = 'completed';
            } else {
                console.warn("[CommandManager] Popup send for notification was successful but response was not as expected (or no response handler called sendResponse). Marking command complete. Response:", response, "for command ID:", command.id);
                command.state = 'completed_popup_unconfirmed';
            }

        }).catch(e => {
            console.error("Error sending show_popup_notification from commandManager or popup response error for command ID:", command.id, e);
            command.state = 'failed';
            command.error = `Popup notification send/confirm error: ${e.message}`;
        });
    // Note: command.state might be updated asynchronously in the .then() or .catch()
}

function handleEchoCommand(command) {
    if (!command.args) {
        console.warn("[CommandManager] ECHO command missing arguments.");
        command.state = 'failed';
        command.error = 'ECHO command missing arguments';
        return null; // Indicate no text to inject
    }
    console.log(`[CommandManager] handleEchoCommand: Preparing to echo args: "${command.args}"`);
    command.state = 'completed';
    return command.args; // Return the text to be injected
}

async function handleRecallCommand(command) { // command object from the queue
    console.log('[CommandManager] handleRecallCommand invoked with command:', command);
    if (!command.args || command.args.trim() === "") {
        command.state = 'failed';
        command.error = 'RECALL command requires search terms as arguments.';
        console.warn(command.error);
        return `{{{SYSTEM}}} RECALL command failed: Please provide search terms. {{{/SYSTEM}}}`;
    }

    let rawSearchTerm = command.args.trim(); // This might be "\"extension\"" or "extension"

    // Strip leading/trailing double or single quotes
    if ((rawSearchTerm.startsWith('"') && rawSearchTerm.endsWith('"')) ||
        (rawSearchTerm.startsWith("'") && rawSearchTerm.endsWith("'"))) {
        rawSearchTerm = rawSearchTerm.substring(1, rawSearchTerm.length - 1);
    }

    const searchTerm = rawSearchTerm.toLowerCase(); // Now it's just "extension"

    command.state = 'completed_requires_background_action';
    command.result = {
        action: 'perform_recall',
        searchTerm: searchTerm, // Use the cleaned searchTerm
        originalCommandId: command.id
    };
    console.log('[CommandManager] RECALL command processed, deferring to background.js for Stacker search:', command.result);
    return null;

    // const searchTerm = command.args.trim().toLowerCase();

    // We need projectData here to access the session's stackerChunks
    // This implies processCommand needs to fetch it and pass it, or handleRecallCommand fetches it.
    // Let's assume processCommand will fetch and pass projectData if a command type needs it.
    // For now, let's redesign processCommand slightly.

    // Retrieve current projectData to access stackerChunks
    // This is not ideal for handleRecallCommand to fetch data directly,
    // but for MVP it simplifies the processCommand signature for now.
    // Background.js should ideally pass the relevant session's stackerChunks.
    // Let's refine this: background.js, when calling processCommand, will pass projectData.
    // For now, this is a placeholder, RECALL processing will be in background.js after commandManager identifies it.

    // SIMPLIFIED FOR NOW: Let's assume the actual recall logic will be orchestrated by background.js
    // after commandManager identifies a RECALL command.
    // commandManager just validates and prepares it.

    // command.state = 'completed_requires_background_action'; // New state
    // command.result = {
    //     action: 'perform_recall',
    //     searchTerm: searchTerm,
    //     originalCommandId: command.id
    // };
    // console.log('[CommandManager] RECALL command processed, deferring to background.js for Stacker search:', command.result);
    // return null; // No direct injection text from here; background.js will orchestrate
}

// * LATEST JUST COMMENTED FOR LATER IMPLEMENTATION 05/19/25
// *
// We'll need a periodic `processFullQueue` later for non-instant commands.
// function processFullQueue() {
//     const commandToProcess = commandQueue.find(cmd => cmd.state === 'queued');
//     if (commandToProcess) {
//         processCommand(commandToProcess.id);
//     }
// }
// setInterval(processFullQueue, 3000); // Example: process one queued command every 3s
// *
// * AJG:
// * I'd rather not do it with an interval though and just wait to check it every time an exchange completes or something.
// * Or maybe have it be a state machine?
// * Eventually though, the Eddie server and Looper and Stacker apps are going to handle it anyway
// *
// * 05/19/25 to be done later *


// // This function will be called by background.js periodically
// function processQueue() {
//     const commandToProcess = commandQueue.find(cmd => cmd.state === 'pending' || cmd.state === 'queued');
//     if (commandToProcess) {
//         // For now, we're processing NOTIFY immediately.
//         // This function would be more relevant for commands that shouldn't run instantly.
//     }
// }

// Export functions that background.js will use
// Note: For service workers, direct exports like ES6 modules might not work as expected
// without a bundler. We'll handle this by ensuring background.js can call these
// if commandManager.js is imported via importScripts() or by message passing if it were a separate worker.
// For simplicity now, background.js will directly include/call these if not using importScripts.
// If we make this a true module later, the structure will change slightly.
// For now, these functions will be available if this script is loaded by background.js.