/**
 * Clean API Call Logger
 * Logs only API calls with timestamp and parameters
 * Timezone: configured via LOG_TIMEZONE or TZ env variables
 */

function apiLogger(req, res, next) {
    // Skip health check spam unless it's the main health endpoint
    if (req.path.includes('/health') && req.path !== '/api/health') {
        return next();
    }

    // Skip gun-relay internal sync requests (too verbose)
    if (req.path.startsWith('/gun-relay/')) {
        return next();
    }

    const timezone = process.env.LOG_TIMEZONE || process.env.TZ || 'UTC';
    
    // Simple localized timestamp
    const date = new Date();
    const timestamp = date.toLocaleString('en-US', { 
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
    });
    
    const method = req.method;
    const path = req.path;
    const query = Object.keys(req.query).length > 0 ? req.query : null;
    const body = req.body && Object.keys(req.body).length > 0 ? '(body present)' : null;
    const auth = req.headers.authorization ? '(authenticated)' : '(public)';

    // Format parameters for clean logging
    const params = [];
    if (query) {
        const cleanQuery = { ...query };
        // Truncate long values for readability
        Object.keys(cleanQuery).forEach(key => {
            if (typeof cleanQuery[key] === 'string' && cleanQuery[key].length > 100) {
                cleanQuery[key] = cleanQuery[key].substring(0, 100) + '...';
            }
        });
        params.push(`query=${JSON.stringify(cleanQuery)}`);
    }
    if (body) params.push(body);

    const paramsStr = params.length > 0 ? ` | ${params.join(' | ')}` : '';

    console.log(`[${timestamp}] ${method} ${path} ${auth}${paramsStr}`);

    next();
}

module.exports = apiLogger;

