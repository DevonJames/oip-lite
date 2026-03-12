const { fetchNutritionalData: openaiFetchNutritionalData, findStandardUnit, convertNutritionalValues } = require('./nutritional-helper-openai');

/**
 * Legacy wrapper for backward compatibility
 * This file now uses the OpenAI-powered nutritional helper
 */
async function fetchNutritionalData(ingredientName) {
  // const { fetchNutritionalData: openaiFetchNutritionalData } = require('./nutritional-helper-openai');
  return await openaiFetchNutritionalData(ingredientName);
}

module.exports = { 
  fetchNutritionalData,
  findStandardUnit,
  convertNutritionalValues
};