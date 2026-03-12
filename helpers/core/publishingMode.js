/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Publishing Mode Determination
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Determines publishing mode and signing strategy based on environment variables.
 * PUBLISH_TO_ARWEAVE defaults to true. PUBLISH_TO_GUN defaults to true.
 */

function isArweaveEnabled() {
    return process.env.PUBLISH_TO_ARWEAVE !== 'false';
}

function isGunEnabled() {
    return process.env.PUBLISH_TO_GUN !== 'false';
}

function isLocalNodeEnabled() {
    return process.env.PUBLISH_TO_THIS_HOST === 'true';
}

/**
 * Determine if we're in local-only mode (Arweave and GUN disabled, local node enabled)
 */
function isLocalOnlyMode() {
    return !isArweaveEnabled() && !isGunEnabled() && isLocalNodeEnabled();
}

/**
 * Determine if we're in Arweave mode (Arweave enabled)
 */
function isArweaveMode() {
    return isArweaveEnabled();
}

/**
 * Get publishing mode configuration
 * @param {object} destinations - Requested destinations
 * @returns {object} Publishing mode configuration
 */
function getPublishingMode(destinations = {}) {
    const arweaveRequested = destinations.arweave !== false;
    const gunRequested = destinations.gun !== false;
    const localRequested = destinations.thisHost === true;
    
    const arweaveEnabled = isArweaveEnabled() && arweaveRequested;
    const gunEnabled = isGunEnabled() && gunRequested;
    const localEnabled = isLocalNodeEnabled() && localRequested;
    
    // Determine mode
    const localOnly = !arweaveEnabled && !gunEnabled && localEnabled;
    const arweaveMode = arweaveEnabled;
    
    return {
        localOnly,
        arweaveMode,
        arweaveEnabled,
        gunEnabled,
        localEnabled,
        needsServerSignature: arweaveMode, // Server signs when Arweave is enabled
        needsWriterSignature: false // Will be determined by publishing method
    };
}

module.exports = {
    isArweaveEnabled,
    isGunEnabled,
    isLocalNodeEnabled,
    isLocalOnlyMode,
    isArweaveMode,
    getPublishingMode
};
