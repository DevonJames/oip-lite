const ongoingDialogues = new Map();

// MEMORY LEAK FIX: Add timeout-based cleanup for stale dialogues
const DIALOGUE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

// Periodically clean up stale dialogues
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [dialogueId, dialogue] of ongoingDialogues.entries()) {
        const lastActivity = dialogue.lastActivity || dialogue.startTime || now;
        const timeSinceActivity = now - lastActivity;
        
        // Remove dialogues that haven't been accessed in 30 minutes
        if (timeSinceActivity > DIALOGUE_TIMEOUT) {
            console.log(`🧹 [Memory Cleanup] Removing stale dialogue ${dialogueId} (inactive for ${Math.round(timeSinceActivity / 60000)} minutes)`);
            
            // MEMORY LEAK FIX: Aggressively clear dialogue data before deleting
            if (dialogue.data && Array.isArray(dialogue.data)) {
                // Clear any buffered audio/text data
                dialogue.data.splice(0, dialogue.data.length);
                dialogue.data = null;
            }
            if (dialogue.clients) {
                dialogue.clients.clear();
            }
            
            ongoingDialogues.delete(dialogueId);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        const remaining = ongoingDialogues.size;
        console.log(`🧹 [Memory Cleanup] Cleaned up ${cleanedCount} stale dialogues (${remaining} remaining)`);
    }
}, CLEANUP_INTERVAL);

// Shared state to store ongoing scrapes
const ongoingScrapes = new Map();

// Function to safely cleanup a scrape entry
function cleanupScrape(scrapeId) {
    if (ongoingScrapes.has(scrapeId)) {
        const streamData = ongoingScrapes.get(scrapeId);
        if (streamData && streamData.clients) {
            // Close all client connections
            streamData.clients.forEach(client => {
                try {
                    if (typeof client.end === 'function') {
                        client.end();
                    }
                } catch (err) {
                    console.error('Error closing client connection:', err);
                }
            });
        }
        ongoingScrapes.delete(scrapeId);
        console.log(`Cleaned up scrape entry for ${scrapeId}`);
    }
}

// Function to get all active scrape IDs
function getActiveScrapeIds() {
    return Array.from(ongoingScrapes.keys());
}

module.exports = {
  ongoingDialogues,
  ongoingScrapes,
  cleanupScrape,
  getActiveScrapeIds
};