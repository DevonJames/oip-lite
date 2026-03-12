/**
 * Check Environment
 * Validates that required environment variables are set
 */

/**
 * Check if required environment variables are set
 * @returns {Object} - Object with validation results
 */
function checkRequiredEnvVars() {
  const requiredVars = [
    'ELASTICSEARCHHOST',
    'JWT_SECRET'
  ];
  
  const recommendedVars = [
    'ELASTICCLIENTUSERNAME', 
    'ELASTICCLIENTPASSWORD'
  ];
  
  const missingRequired = [];
  const missingRecommended = [];
  
  // Check required variables
  for (const variable of requiredVars) {
    if (!process.env[variable]) {
      missingRequired.push(variable);
    }
  }
  
  // Check recommended variables
  for (const variable of recommendedVars) {
    if (!process.env[variable]) {
      missingRecommended.push(variable);
    }
  }
  
  return {
    isValid: missingRequired.length === 0,
    missingRequired,
    missingRecommended,
    summary: `${missingRequired.length > 0 ? 
      `Missing required environment variables: ${missingRequired.join(', ')}. ` : 
      'All required environment variables are set. '}${missingRecommended.length > 0 ? 
      `Missing recommended environment variables: ${missingRecommended.join(', ')}.` : 
      'All recommended environment variables are set.'}`
  };
}

/**
 * Validate environment variables and exit if required ones are missing
 */
function validateEnvironment() {
  const result = checkRequiredEnvVars();
  
  if (!result.isValid) {
    console.error('Environment validation failed:');
    console.error(result.summary);
    console.error('Please set the required environment variables and restart the server.');
    process.exit(1);
  }
  
  if (result.missingRecommended.length > 0) {
    console.warn('Environment warning:');
    console.warn(`Missing recommended environment variables: ${result.missingRecommended.join(', ')}`);
    console.warn('These are not required, but recommended for security and proper functionality.');
  }
  
  console.log('Environment validation passed.');
  return true;
}

module.exports = {
  checkRequiredEnvVars,
  validateEnvironment
}; 