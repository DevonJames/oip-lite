/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WordPress Session Management
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Creates WordPress sessions/cookies from OIP JWT tokens.
 * This enables unified authentication: OIP login = WordPress login.
 */

const axios = require('axios');
const crypto = require('crypto');

const WORDPRESS_URL = process.env.WORDPRESS_URL || 'http://wordpress:80';
const WORDPRESS_ADMIN_USER = process.env.WORDPRESS_ADMIN_USER || 'admin';
const WORDPRESS_ADMIN_PASSWORD = process.env.WP_ADMIN_PASSWORD || process.env.WORDPRESS_ADMIN_PASSWORD || '';

/**
 * Create a WordPress application password for a user
 * This allows programmatic login via REST API
 * @param {number} userId - WordPress user ID
 * @returns {Promise<string|null>} Application password or null if failed
 */
async function createWordPressAppPassword(userId) {
    if (!WORDPRESS_ADMIN_PASSWORD) {
        return null;
    }

    try {
        // WordPress application passwords are created via REST API
        // POST /wp-json/wp/v2/users/{id}/application-passwords
        const response = await axios.post(
            `${WORDPRESS_URL}/wp-json/wp/v2/users/${userId}/application-passwords`,
            {
                name: 'OIP Integration',
                app_id: 'oip-integration'
            },
            {
                auth: {
                    username: WORDPRESS_ADMIN_USER,
                    password: WORDPRESS_ADMIN_PASSWORD
                }
            }
        );

        // Application password is returned in format: "xxxx xxxx xxxx xxxx xxxx xxxx"
        return response.data.password;
    } catch (error) {
        // If application password already exists, try to get existing ones
        try {
            const listResponse = await axios.get(
                `${WORDPRESS_URL}/wp-json/wp/v2/users/${userId}/application-passwords`,
                {
                    auth: {
                        username: WORDPRESS_ADMIN_USER,
                        password: WORDPRESS_ADMIN_PASSWORD
                    }
                }
            );

            // Return first existing application password
            if (listResponse.data && listResponse.data.length > 0) {
                // Note: WordPress doesn't return the actual password, only the hash
                // We need to create a new one or use a different method
                return null; // Can't retrieve existing password
            }
        } catch (listError) {
            console.error('[WordPress Session] Error listing app passwords:', listError.message);
        }

        console.error('[WordPress Session] Error creating app password:', error.message);
        return null;
    }
}

/**
 * Generate WordPress login URL with nonce for programmatic login
 * This creates a one-time login link that WordPress can verify
 * @param {number} userId - WordPress user ID
 * @param {string} email - User email
 * @returns {Promise<string|null>} Login URL or null if failed
 */
async function generateWordPressLoginUrl(userId, email) {
    // WordPress doesn't have a direct REST API for creating sessions
    // We need to use WordPress's built-in login mechanism
    
    // Option 1: Use WordPress application passwords (requires user to set it up)
    // Option 2: Create a temporary login token/nonce
    // Option 3: Use WordPress's XML-RPC or wp-login.php with proper nonces
    
    // For now, we'll create a login endpoint that WordPress can verify
    // The OIP daemon will proxy WordPress login requests
    
    return `${WORDPRESS_URL}/wp-login.php?action=oip_login&user_id=${userId}&email=${encodeURIComponent(email)}`;
}

/**
 * Create WordPress session cookie from OIP JWT
 * This is handled via a proxy endpoint that WordPress trusts
 * @param {object} req - Express request with OIP JWT
 * @param {object} res - Express response
 * @param {number} wordpressUserId - WordPress user ID
 * @returns {Promise<boolean>} Success status
 */
async function createWordPressSession(req, res, wordpressUserId) {
    if (!wordpressUserId) {
        return false;
    }

    try {
        // WordPress sessions are managed via cookies
        // We need to make a request to WordPress that sets the authentication cookie
        // This is typically done via wp-login.php or a custom endpoint
        
        // Since we're proxying WordPress, we can set cookies that WordPress will recognize
        // WordPress uses cookies like: wordpress_logged_in_*, wordpress_*
        
        // For now, we'll create a proxy endpoint that WordPress can call to verify the OIP JWT
        // and set WordPress cookies accordingly
        
        // The actual cookie setting will be handled by the proxy middleware
        // when requests are made to WordPress with the OIP JWT
        
        return true;
    } catch (error) {
        console.error('[WordPress Session] Error creating session:', error.message);
        return false;
    }
}

module.exports = {
    createWordPressAppPassword,
    generateWordPressLoginUrl,
    createWordPressSession
};
