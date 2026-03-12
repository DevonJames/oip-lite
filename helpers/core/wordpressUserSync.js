/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WordPress User Synchronization
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Creates/updates WordPress users when OIP users log in.
 * This enables unified authentication between OIP and WordPress.
 */

const axios = require('axios');

const WORDPRESS_URL = process.env.WORDPRESS_URL || 'http://wordpress:80';
const WORDPRESS_ADMIN_USER = process.env.WORDPRESS_ADMIN_USER || 'admin';
const WORDPRESS_ADMIN_PASSWORD = process.env.WP_ADMIN_PASSWORD || process.env.WORDPRESS_ADMIN_PASSWORD || '';

/**
 * Get WordPress Application Password for REST API authentication
 * Falls back to regular password if Application Password not available
 */
async function getWordPressAuth() {
    // Check if Application Password is provided via env var
    if (process.env.WP_APP_PASSWORD) {
        // WordPress Application Passwords MUST be used WITH SPACES for Basic Auth
        // WordPress displays them as "xxxx xxxx xxxx xxxx xxxx xxxx" and expects that exact format
        const appPassword = process.env.WP_APP_PASSWORD; // Keep spaces!
        
        // Application Passwords are user-specific - try to find which user it belongs to
        // Try common usernames: "devon" (most common), then env var, then defaults
        const possibleUsernames = [
            'devon',  // Most common WordPress username
            WORDPRESS_ADMIN_USER,  // From env var
            'admin',  // Default admin username
        ];
        
        // Remove duplicates
        const uniqueUsernames = [...new Set(possibleUsernames)];
        
        // Try each username to see which one works
        // Also try multiple endpoint formats in case WordPress permalinks are misconfigured
        const testEndpoints = [
            `${WORDPRESS_URL}/wp-json/wp/v2/users/me`,
            `${WORDPRESS_URL}/wp-json/wp/v2/users/me/`,
            `${WORDPRESS_URL}/index.php?rest_route=/wp/v2/users/me`
        ];
        
        // Try Application Password WITH spaces (WordPress requires this format)
        for (const testUsername of uniqueUsernames) {
            for (const endpoint of testEndpoints) {
                try {
                    console.log(`🔍 [WordPress Sync] Testing ${testUsername} @ ${endpoint} (Application Password with spaces)`);
                    const verifyResponse = await axios.get(
                        endpoint,
                        {
                            auth: {
                                username: testUsername,
                                password: appPassword // Use WITH spaces
                            },
                            validateStatus: () => true,
                            timeout: 5000,
                            maxRedirects: 5,
                            transformResponse: [(data) => {
                                // Keep response as-is to detect HTML
                                return data;
                            }]
                        }
                    );
                    
                    // Check if we got HTML instead of JSON (WordPress redirect to login)
                    const isHtml = typeof verifyResponse.data === 'string' && (
                        verifyResponse.data.trim().startsWith('<!DOCTYPE') ||
                        verifyResponse.data.trim().startsWith('<html') ||
                        verifyResponse.data.includes('<body') ||
                        (verifyResponse.headers['content-type'] && verifyResponse.headers['content-type'].includes('text/html'))
                    );
                    
                    if (isHtml) {
                        console.warn(`⚠️ [WordPress Sync] ${testUsername} @ ${endpoint} returned HTML (likely login page or redirect)`);
                        continue; // Try next endpoint
                    }
                    
                    if (verifyResponse.status === 200) {
                        // Try to parse as JSON to confirm it's valid
                        let userData = verifyResponse.data;
                        if (typeof userData === 'string') {
                            try {
                                userData = JSON.parse(userData);
                            } catch (parseError) {
                                console.warn(`⚠️ [WordPress Sync] ${testUsername} @ ${endpoint} response not valid JSON`);
                                continue; // Try next endpoint
                            }
                        }
                        
                        // Verify it's actually user data
                        if (userData && typeof userData === 'object' && userData.id) {
                            console.log(`✅ [WordPress Sync] Application Password authenticated as: ${testUsername}`);
                            console.log(`✅ [WordPress Sync] Authenticated user ID: ${userData.id}, email: ${userData.email}`);
                            console.log(`✅ [WordPress Sync] Working endpoint: ${endpoint}`);
                            return {
                                username: testUsername,
                                password: appPassword, // Use WITH spaces (as WordPress requires)
                                method: 'Application Password'
                            };
                        } else {
                            console.warn(`⚠️ [WordPress Sync] ${testUsername} @ ${endpoint} returned invalid user data`);
                            continue; // Try next endpoint
                        }
                    } else if (verifyResponse.status === 401) {
                        // 401 means wrong username/password, try next username
                        console.warn(`⚠️ [WordPress Sync] ${testUsername} @ ${endpoint} returned 401 (authentication failed)`);
                        break; // Don't try other endpoints for this username, try next username
                    } else {
                        console.warn(`⚠️ [WordPress Sync] ${testUsername} @ ${endpoint} returned status ${verifyResponse.status}`);
                        // Continue to next endpoint
                    }
                } catch (error) {
                    console.warn(`⚠️ [WordPress Sync] Error testing ${testUsername} @ ${endpoint}:`, error.message);
                    // Try next endpoint
                    continue;
                }
            }
        }
        
        // If none worked, log detailed error and fall back to WORDPRESS_ADMIN_USER
        console.error(`❌ [WordPress Sync] Application Password authentication failed for all usernames:`);
        console.error(`   Tried usernames: ${uniqueUsernames.join(', ')}`);
        console.error(`   Tried endpoints: ${testEndpoints.join(', ')}`);
        console.error(`   This usually means:`);
        console.error(`   1. WP_APP_PASSWORD is incorrect or expired`);
        console.error(`   2. The Application Password is for a different username`);
        console.error(`   3. WordPress REST API is returning HTML instead of JSON (permalink issue)`);
        console.warn(`⚠️ [WordPress Sync] Falling back to ${WORDPRESS_ADMIN_USER} - this may not work`);
        return {
            username: WORDPRESS_ADMIN_USER,
            password: appPassword,
            method: 'Application Password (fallback - may fail)'
        };
    }
    
    // Fallback to regular password
    if (WORDPRESS_ADMIN_PASSWORD) {
        return {
            username: WORDPRESS_ADMIN_USER,
            password: WORDPRESS_ADMIN_PASSWORD,
            method: 'Regular Password'
        };
    }
    
    throw new Error('WordPress admin password not configured');
}

/**
 * Create or update a WordPress user from an OIP user account
 * @param {string} email - User email
 * @param {string} username - WordPress username (defaults to email)
 * @param {string} displayName - Display name for WordPress
 * @returns {Promise<object>} WordPress user object or null if failed
 */
async function syncWordPressUser(email, username = null, displayName = null) {
    // Check if we have any authentication method available
    if (!WORDPRESS_ADMIN_PASSWORD && !process.env.WP_APP_PASSWORD) {
        console.warn('[WordPress Sync] WordPress admin password not configured, skipping user sync');
        return null;
    }

    try {
        const wpUsername = username || email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        const wpDisplayName = displayName || email.split('@')[0];

        // Get authentication credentials (prefer Application Password)
        const auth = await getWordPressAuth();
        
        // Check if user already exists
        const searchResponse = await axios.get(
            `${WORDPRESS_URL}/wp-json/wp/v2/users`,
            {
                params: { search: email },
                auth: {
                    username: auth.username,
                    password: auth.password
                },
                validateStatus: () => true // Don't throw on 401
            }
        );

        // Check if authentication failed
        if (searchResponse.status === 401) {
            console.error(`[WordPress Sync] Authentication failed (401) when searching for user ${email}`);
            console.error(`[WordPress Sync] Auth username: ${auth.username}, method: ${auth.method}`);
            console.error(`[WordPress Sync] Response:`, JSON.stringify(searchResponse.data, null, 2));
            throw new Error(`WordPress authentication failed: Invalid credentials. Username: ${auth.username}, Method: ${auth.method}`);
        }

        if (searchResponse.status !== 200) {
            console.error(`[WordPress Sync] Unexpected status ${searchResponse.status} when searching for user ${email}`);
            throw new Error(`WordPress API returned status ${searchResponse.status}`);
        }

        // Check if response is HTML (WordPress might redirect to login)
        if (typeof searchResponse.data === 'string' && (
            searchResponse.data.trim().startsWith('<!DOCTYPE') ||
            searchResponse.data.trim().startsWith('<html')
        )) {
            console.error(`[WordPress Sync] WordPress returned HTML instead of JSON (likely login page)`);
            throw new Error(`WordPress authentication failed: Received HTML instead of JSON. This usually means the Application Password is incorrect or expired.`);
        }

        const existingUser = Array.isArray(searchResponse.data) 
            ? searchResponse.data.find(u => u.email === email)
            : null;

        if (existingUser) {
            // Update existing user
            console.log(`[WordPress Sync] Updating existing WordPress user: ${email}`);
            const updateResponse = await axios.post(
                `${WORDPRESS_URL}/wp-json/wp/v2/users/${existingUser.id}`,
                {
                    name: wpDisplayName,
                    slug: wpUsername
                },
                {
                    auth: {
                        username: auth.username,
                        password: auth.password
                    },
                    validateStatus: () => true // Don't throw on 401
                }
            );

            // Check if authentication failed
            if (updateResponse.status === 401) {
                console.error(`[WordPress Sync] Authentication failed (401) when updating user ${email}`);
                console.error(`[WordPress Sync] Auth username: ${auth.username}, method: ${auth.method}`);
                console.error(`[WordPress Sync] Response:`, JSON.stringify(updateResponse.data, null, 2));
                throw new Error(`WordPress authentication failed: Invalid credentials. Username: ${auth.username}, Method: ${auth.method}. Cannot update WordPress user.`);
            }

            if (updateResponse.status !== 200) {
                console.error(`[WordPress Sync] Unexpected status ${updateResponse.status} when updating user ${email}`);
                console.error(`[WordPress Sync] Response:`, JSON.stringify(updateResponse.data, null, 2));
                throw new Error(`WordPress API returned status ${updateResponse.status}: ${JSON.stringify(updateResponse.data)}`);
            }

            return updateResponse.data;
        } else {
            // User not found by email - try to find by username before creating
            console.log(`[WordPress Sync] User not found by email, checking if username "${wpUsername}" exists...`);
            const usernameSearchResponse = await axios.get(
                `${WORDPRESS_URL}/wp-json/wp/v2/users`,
                {
                    params: { search: wpUsername },
                    auth: {
                        username: auth.username,
                        password: auth.password
                    },
                    validateStatus: () => true
                }
            );
            
            if (usernameSearchResponse.status === 200 && Array.isArray(usernameSearchResponse.data)) {
                const existingByUsername = usernameSearchResponse.data.find(u => u.slug === wpUsername || u.name === wpUsername);
                if (existingByUsername) {
                    console.log(`[WordPress Sync] Found existing WordPress user by username "${wpUsername}": ID ${existingByUsername.id}`);
                    // Update email if it's different
                    if (existingByUsername.email !== email) {
                        console.log(`[WordPress Sync] Updating email for user ${existingByUsername.id} from ${existingByUsername.email} to ${email}`);
                        try {
                            const updateResponse = await axios.post(
                                `${WORDPRESS_URL}/wp-json/wp/v2/users/${existingByUsername.id}`,
                                { email: email },
                                {
                                    auth: { username: auth.username, password: auth.password },
                                    validateStatus: () => true
                                }
                            );
                            if (updateResponse.status === 200) {
                                console.log(`[WordPress Sync] Updated email for user ${existingByUsername.id}`);
                            }
                        } catch (updateError) {
                            console.warn(`[WordPress Sync] Failed to update email:`, updateError.message);
                        }
                    }
                    return existingByUsername;
                }
            }
            
            // Create new user
            console.log(`[WordPress Sync] Creating new WordPress user: ${email} (username: ${wpUsername})`);
            // Generate a random password (user will use OIP login, not WordPress login)
            const randomPassword = require('crypto').randomBytes(16).toString('hex');
            
            const createResponse = await axios.post(
                `${WORDPRESS_URL}/wp-json/wp/v2/users`,
                {
                    username: wpUsername,
                    email: email,
                    name: wpDisplayName,
                    password: randomPassword,
                    roles: ['author'] // Give author permissions
                },
                {
                    auth: {
                        username: auth.username,
                        password: auth.password
                    },
                    validateStatus: () => true // Don't throw on 401
                }
            );

            // Check if authentication failed
            if (createResponse.status === 401) {
                console.error(`[WordPress Sync] Authentication failed (401) when creating user ${email}`);
                console.error(`[WordPress Sync] Auth username: ${auth.username}, method: ${auth.method}`);
                console.error(`[WordPress Sync] Response:`, JSON.stringify(createResponse.data, null, 2));
                throw new Error(`WordPress authentication failed: Invalid credentials. Username: ${auth.username}, Method: ${auth.method}. Cannot create WordPress user.`);
            }

            // Handle "username already exists" error - try to find the user
            if (createResponse.status === 500 || createResponse.status === 400) {
                const errorData = typeof createResponse.data === 'object' ? createResponse.data : {};
                if (errorData.code === 'existing_user_login' || errorData.message?.includes('username already exists')) {
                    console.warn(`[WordPress Sync] Username "${wpUsername}" already exists, trying to find user...`);
                    // Try to find by username
                    try {
                        const findResponse = await axios.get(
                            `${WORDPRESS_URL}/wp-json/wp/v2/users`,
                            {
                                params: { search: wpUsername },
                                auth: { username: auth.username, password: auth.password },
                                validateStatus: () => true
                            }
                        );
                        if (findResponse.status === 200 && Array.isArray(findResponse.data)) {
                            const foundUser = findResponse.data.find(u => u.slug === wpUsername || u.name === wpUsername);
                            if (foundUser) {
                                console.log(`[WordPress Sync] Found existing WordPress user by username "${wpUsername}": ID ${foundUser.id}`);
                                return foundUser;
                            }
                        }
                    } catch (findError) {
                        console.warn(`[WordPress Sync] Failed to find user by username:`, findError.message);
                    }
                }
            }

            // Handle "username already exists" error - try to find the existing user
            if (createResponse.status === 500 || createResponse.status === 400) {
                const errorData = typeof createResponse.data === 'object' ? createResponse.data : {};
                if (errorData.code === 'existing_user_login' || errorData.message?.includes('username already exists')) {
                    console.warn(`[WordPress Sync] Username "${wpUsername}" already exists, trying to find existing user...`);
                    // Try to find by username
                    try {
                        const findResponse = await axios.get(
                            `${WORDPRESS_URL}/wp-json/wp/v2/users`,
                            {
                                params: { search: wpUsername },
                                auth: { username: auth.username, password: auth.password },
                                validateStatus: () => true
                            }
                        );
                        if (findResponse.status === 200 && Array.isArray(findResponse.data)) {
                            const foundUser = findResponse.data.find(u => u.slug === wpUsername || u.name === wpUsername || u.login === wpUsername);
                            if (foundUser) {
                                console.log(`✅ [WordPress Sync] Found existing WordPress user by username "${wpUsername}": ID ${foundUser.id}`);
                                // Update email if it's different
                                if (foundUser.email !== email) {
                                    console.log(`[WordPress Sync] Updating email for user ${foundUser.id} from ${foundUser.email} to ${email}`);
                                    try {
                                        const updateResponse = await axios.post(
                                            `${WORDPRESS_URL}/wp-json/wp/v2/users/${foundUser.id}`,
                                            { email: email },
                                            {
                                                auth: { username: auth.username, password: auth.password },
                                                validateStatus: () => true
                                            }
                                        );
                                        if (updateResponse.status === 200) {
                                            console.log(`✅ [WordPress Sync] Updated email for user ${foundUser.id}`);
                                        }
                                    } catch (updateError) {
                                        console.warn(`[WordPress Sync] Failed to update email:`, updateError.message);
                                    }
                                }
                                return foundUser;
                            }
                        }
                    } catch (findError) {
                        console.warn(`[WordPress Sync] Failed to find user by username:`, findError.message);
                    }
                }
            }
            
            if (createResponse.status !== 201 && createResponse.status !== 200) {
                console.error(`[WordPress Sync] Unexpected status ${createResponse.status} when creating user ${email}`);
                console.error(`[WordPress Sync] Response:`, JSON.stringify(createResponse.data, null, 2));
                throw new Error(`WordPress API returned status ${createResponse.status}: ${JSON.stringify(createResponse.data)}`);
            }

            return createResponse.data;
        }
    } catch (error) {
        console.error('[WordPress Sync] Error syncing WordPress user:', error.message);
        if (error.response) {
            console.error('[WordPress Sync] Response status:', error.response.status);
            console.error('[WordPress Sync] Response data:', JSON.stringify(error.response.data, null, 2));
            console.error('[WordPress Sync] Auth username used:', auth.username);
        }
        // If it's a 401, the authentication failed - try to find user anyway
        if (error.response?.status === 401) {
            console.warn('[WordPress Sync] Authentication failed (401). This might mean Application Password is incorrect or for wrong user.');
            // Try to find user by email anyway (might work if user already exists)
            try {
                const foundUserId = await getWordPressUserId(email);
                if (foundUserId) {
                    console.log(`[WordPress Sync] Found existing WordPress user despite auth failure: ${foundUserId}`);
                    return { id: foundUserId, email: email };
                }
            } catch (findError) {
                console.warn('[WordPress Sync] Could not find user by email:', findError.message);
            }
        }
        return null;
    }
}

/**
 * Get WordPress user ID by email
 * @param {string} email - User email
 * @returns {Promise<number|null>} WordPress user ID or null
 */
async function getWordPressUserId(email) {
    if (!WORDPRESS_ADMIN_PASSWORD && !process.env.WP_APP_PASSWORD) {
        console.warn(`[WordPress Sync] No WordPress authentication configured, cannot search for user ${email}`);
        return null;
    }

    try {
        const auth = await getWordPressAuth();
        console.log(`🔍 [WordPress Sync] Searching for user with email: ${email}, using auth username: ${auth.username}, method: ${auth.method}`);
        
        // Try multiple endpoint formats in case WordPress permalinks are misconfigured
        const endpoints = [
            `${WORDPRESS_URL}/wp-json/wp/v2/users`,
            `${WORDPRESS_URL}/index.php?rest_route=/wp/v2/users`
        ];
        
        let response = null;
        let lastError = null;
        
        for (const endpoint of endpoints) {
            try {
                response = await axios.get(
                    endpoint,
                    {
                        params: { search: email },
                        auth: {
                            username: auth.username,
                            password: auth.password
                        },
                        validateStatus: () => true, // Don't throw on 401
                        timeout: 5000
                    }
                );
                
                // Check if we got HTML instead of JSON
                const isHtml = typeof response.data === 'string' && (
                    response.data.trim().startsWith('<!DOCTYPE') ||
                    response.data.trim().startsWith('<html')
                );
                
                if (isHtml) {
                    console.warn(`⚠️ [WordPress Sync] ${endpoint} returned HTML instead of JSON`);
                    continue; // Try next endpoint
                }
                
                if (response.status === 200) {
                    break; // Success, use this response
                }
            } catch (error) {
                lastError = error;
                continue; // Try next endpoint
            }
        }
        
        if (!response) {
            console.error(`❌ [WordPress Sync] All endpoints failed for user search`);
            if (lastError) {
                console.error(`❌ [WordPress Sync] Last error:`, lastError.message);
            }
            return null;
        }

        if (response.status === 401) {
            console.error(`❌ [WordPress Sync] Authentication failed (401) when searching for user ${email}`);
            console.error(`❌ [WordPress Sync] Auth username: ${auth.username}, method: ${auth.method}`);
            console.error(`❌ [WordPress Sync] This means WordPress authentication is not working`);
            return null;
        }

        if (response.status !== 200) {
            console.warn(`⚠️ [WordPress Sync] Unexpected status ${response.status} when searching for user ${email}`);
            return null;
        }

        // Ensure response.data is an array
        const users = Array.isArray(response.data) ? response.data : [];
        const user = users.find(u => u.email === email);
        
        if (user) {
            console.log(`✅ [WordPress Sync] Found WordPress user: ${email} -> ID: ${user.id}`);
        } else {
            console.log(`ℹ️ [WordPress Sync] WordPress user not found: ${email} (searched ${users.length} users)`);
        }
        return user ? user.id : null;
    } catch (error) {
        console.error(`❌ [WordPress Sync] Error getting WordPress user ID:`, error.message);
        if (error.response) {
            console.error(`❌ [WordPress Sync] Response status: ${error.response.status}`);
            console.error(`❌ [WordPress Sync] Response data:`, JSON.stringify(error.response.data, null, 2));
        }
        return null;
    }
}

/**
 * Check if a WordPress user is an admin
 * @param {number} wordpressUserId - WordPress user ID
 * @returns {Promise<boolean>} True if user is WordPress admin
 */
async function isWordPressAdmin(wordpressUserId) {
    if (!WORDPRESS_ADMIN_PASSWORD || !wordpressUserId) {
        return false;
    }

    try {
        const auth = await getWordPressAuth();
        const response = await axios.get(
            `${WORDPRESS_URL}/wp-json/wp/v2/users/${wordpressUserId}`,
            {
                auth: {
                    username: auth.username,
                    password: auth.password
                }
            }
        );

        // WordPress admin role is 'administrator'
        const roles = response.data.roles || [];
        return roles.includes('administrator');
    } catch (error) {
        console.error('[WordPress Sync] Error checking WordPress admin status:', error.message);
        return false;
    }
}

/**
 * Get or create an "Anonymous" WordPress user for anonymous posts
 * @returns {Promise<number|null>} WordPress user ID for Anonymous user or null if failed
 */
async function getAnonymousWordPressUser() {
    if (!WORDPRESS_ADMIN_PASSWORD) {
        return null;
    }

    try {
        const auth = await getWordPressAuth();
        
        // Search for existing "Anonymous" user
        const searchResponse = await axios.get(
            `${WORDPRESS_URL}/wp-json/wp/v2/users`,
            {
                params: { search: 'anonymous' },
                auth: {
                    username: auth.username,
                    password: auth.password
                }
            }
        );

        // Look for user with username "anonymous" or display name "Anonymous"
        const anonymousUser = searchResponse.data.find(u => 
            u.slug === 'anonymous' || 
            u.name.toLowerCase() === 'anonymous' ||
            u.username.toLowerCase() === 'anonymous'
        );

        if (anonymousUser) {
            console.log(`[WordPress Sync] Found existing Anonymous user (ID: ${anonymousUser.id})`);
            return anonymousUser.id;
        }

        // Create Anonymous user if it doesn't exist
        console.log(`[WordPress Sync] Creating Anonymous WordPress user`);
        const randomPassword = require('crypto').randomBytes(16).toString('hex');
        
        const createResponse = await axios.post(
            `${WORDPRESS_URL}/wp-json/wp/v2/users`,
            {
                username: 'anonymous',
                email: 'anonymous@localhost.invalid',
                name: 'Anonymous',
                password: randomPassword,
                roles: ['author'] // Give author permissions
            },
            {
                auth: {
                    username: auth.username,
                    password: auth.password
                }
            }
        );
        
        console.log(`[WordPress Sync] Created Anonymous WordPress user (ID: ${createResponse.data.id})`);
        return createResponse.data.id;
    } catch (error) {
        console.error('[WordPress Sync] Error getting Anonymous user:', error.message);
        if (error.response) {
            console.error('[WordPress Sync] Response:', error.response.data);
        }
        return null;
    }
}

module.exports = {
    syncWordPressUser,
    getWordPressUserId,
    isWordPressAdmin,
    getAnonymousWordPressUser
};
