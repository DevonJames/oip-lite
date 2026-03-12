/**
 * Authentication Middleware
 * Verifies JWT tokens for protected routes
 */
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'; // Should be in .env file

/**
 * Middleware to authenticate JWT token (supports both full and scoped tokens)
 */
function authenticateToken(req, res, next) {
  // Get auth header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Split 'Bearer TOKEN'
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication token required' });
  }
  
  // Verify token
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Forbidden', message: 'Invalid or expired token' });
    }
    
    // If verified, set user in request
    // Include scope information (defaults to 'full' for standard tokens)
    req.user = {
      ...user,
      scope: user.scope || 'full',
      tokenType: user.tokenType || 'standard'
    };
    
    next();
  });
}

/**
 * Middleware to check if user is an admin
 */
function isAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }
  
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin privileges required' });
  }
  
  next();
}

/**
 * Optional authentication - populate user if token exists, but don't require it
 */
function optionalAuth(req, res, next) {
  // Get auth header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Split 'Bearer TOKEN'
  
  if (!token) {
    return next(); // Continue without authentication
  }
  
  // Verify token
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err) {
      // If verified, set user in request with scope info
      req.user = {
        ...user,
        scope: user.scope || 'full',
        tokenType: user.tokenType || 'standard'
      };
    }
    next();
  });
}

/**
 * Middleware to enforce calendar token scope restrictions
 * Call this AFTER authenticateToken or optionalAuth
 */
function enforceCalendarScope(req, res, next) {
  // Only enforce if user has calendar scope
  if (!req.user || req.user.scope !== 'calendar-read-only') {
    return next(); // Not a calendar token, skip enforcement
  }
  
  console.log('🔒 [Calendar Scope] Enforcing restrictions for calendar token');
  
  // RESTRICTION 1: Read-only access (GET requests only)
  if (req.method !== 'GET') {
    console.warn('⚠️ [Calendar Scope] Blocked non-GET request:', req.method);
    return res.status(403).json({ 
      success: false,
      error: 'Forbidden', 
      message: 'Calendar tokens are read-only. Only GET requests are allowed.' 
    });
  }
  
  // RESTRICTION 2: Limited record types (workoutSchedule, mealPlan only)
  const recordType = req.query.recordType || req.params.recordType;
  const allowedTypes = req.user.allowedRecordTypes || ['workoutSchedule', 'mealPlan', 'mealPlanDaily'];
  
  if (recordType && !allowedTypes.includes(recordType)) {
    console.warn('⚠️ [Calendar Scope] Blocked access to record type:', recordType);
    return res.status(403).json({ 
      success: false,
      error: 'Forbidden', 
      message: `Calendar tokens can only access: ${allowedTypes.join(', ')}. Requested: ${recordType}` 
    });
  }
  
  console.log('✅ [Calendar Scope] Request passed scope restrictions');
  next();
}

/**
 * Helper function to check if request has calendar scope
 */
function hasCalendarScope(req) {
  return req.user && req.user.scope === 'calendar-read-only';
}

/**
 * Helper function to check if request has full scope
 */
function hasFullScope(req) {
  return req.user && (req.user.scope === 'full' || !req.user.scope);
}

module.exports = {
  authenticateToken,
  isAdmin,
  optionalAuth,
  enforceCalendarScope,
  hasCalendarScope,
  hasFullScope
}; 