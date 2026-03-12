/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RECIPE RESOLVER - Shared Helper
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Ingredient resolution and nutritional data processing for recipes.
 * This is a shared helper used by both:
 *   - oip-daemon-service (publish.js for recipe publishing)
 *   - alexandria-service (recipes.js for ingredient resolution)
 * 
 * Uses oipClient for data operations to maintain service separation.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const axios = require('axios');
const OIPClient = require('../oipClient');
const { fetchNutritionalData } = require('../nutritional-helper');

// Default oipClient for operations
const defaultOIPClient = new OIPClient();

/**
 * Search for existing ingredient by name via oipClient
 * Returns best match with nutritional info, or null
 * 
 * @param {string} ingredientName - Name to search for
 * @param {OIPClient} oipClient - Optional custom client instance
 * @returns {Promise<object|null>} Best matching record or null
 */
async function searchIngredientByName(ingredientName, oipClient = defaultOIPClient) {
    try {
        console.log(`🔍 Searching for ingredient: "${ingredientName}"`);
        
        // Use oipClient to search via daemon
        const results = await oipClient.getRecords({
            recordType: 'nutritionalInfo',
            limit: 10,
            sortBy: 'basic.name:asc'
        });
        
        if (!results || !results.records || results.records.length === 0) {
            console.log('   No nutritional ingredients found in database');
            return null;
        }
        
        // Filter to only records with nutritional info
        const withNutrition = results.records.filter(r => 
            r.data && r.data.nutritionalInfo && 
            r.data.nutritionalInfo.standardAmount && 
            r.data.nutritionalInfo.standardUnit
        );
        
        if (withNutrition.length === 0) {
            console.log('   No ingredients with valid nutritional info found');
            return null;
        }
        
        // Calculate similarity scores
        const scoredResults = withNutrition.map(record => {
            const recordName = (record.data.basic?.name || '').toLowerCase();
            const searchName = ingredientName.toLowerCase();
            
            // Exact match
            if (recordName === searchName) {
                return { record, score: 100 };
            }
            
            // Contains match
            if (recordName.includes(searchName)) {
                return { record, score: 80 };
            }
            
            // Reverse contains
            if (searchName.includes(recordName)) {
                return { record, score: 70 };
            }
            
            // Fuzzy match using word overlap scoring
            const words1 = recordName.split(/\s+/);
            const words2 = searchName.split(/\s+/);
            const commonWords = words1.filter(w => words2.includes(w)).length;
            const maxWords = Math.max(words1.length, words2.length);
            const wordScore = (commonWords / maxWords) * 60;
            
            return { record, score: wordScore };
        });
        
        // Sort by score
        scoredResults.sort((a, b) => b.score - a.score);
        
        const bestMatch = scoredResults[0];
        
        // Only return if score is above threshold (50%)
        if (bestMatch && bestMatch.score >= 50) {
            console.log(`   ✅ Found match: "${bestMatch.record.data.basic?.name}" (score: ${bestMatch.score})`);
            return bestMatch.record;
        }
        
        console.log(`   ⚠️ No good match found (best score: ${bestMatch?.score || 0})`);
        return null;
        
    } catch (error) {
        console.error('Error searching for ingredient:', error);
        return null;
    }
}

/**
 * Fetch nutritional data from Nutritionix and create ingredient object
 * 
 * @param {string} ingredientName - Name of ingredient to fetch
 * @returns {Promise<object|null>} Ingredient object with nutritional data or null
 */
async function fetchAndCreateIngredient(ingredientName) {
    try {
        console.log(`🌐 Fetching nutritional data from Nutritionix for: "${ingredientName}"`);
        
        const nutritionalData = await fetchNutritionalData(ingredientName);
        
        if (!nutritionalData || !nutritionalData.nutritionalInfo) {
            console.error('   ❌ Failed to fetch nutritional data');
            return null;
        }
        
        console.log(`   ✅ Fetched nutritional data:`, nutritionalData.nutritionalInfo);
        
        return {
            name: ingredientName,
            basic: nutritionalData.basic || { name: ingredientName },
            nutritionalInfo: nutritionalData.nutritionalInfo,
            image: nutritionalData.image || {},
            isNew: true // Mark as newly created
        };
        
    } catch (error) {
        console.error('Error fetching nutritional data:', error);
        return null;
    }
}

/**
 * Check if standard unit is problematic and needs AI fixing
 * 
 * @param {object} nutritionalInfo - Nutritional info object
 * @param {string} ingredientName - Name of ingredient (for logging)
 * @returns {boolean} True if unit needs fixing
 */
function needsStandardUnitFix(nutritionalInfo, ingredientName) {
    if (!nutritionalInfo || !nutritionalInfo.standardUnit) {
        return false;
    }
    
    const unit = nutritionalInfo.standardUnit.toLowerCase();
    
    // Valid weight and volume units ONLY
    const validUnits = [
        'oz', 'g', 'kg', 'lb', 'lbs', 'gram', 'grams', 'ounce', 'ounces', 'pound', 'pounds',
        'cup', 'cups', 'tbsp', 'tsp', 'ml', 'l', 'tablespoon', 'tablespoons', 'teaspoon', 'teaspoons'
    ];
    
    // Extract first word to check if unit is valid
    const firstWord = unit.trim().split(' ')[0].split('(')[0]; // Handle "cup(diced)" or "cup diced"
    
    // If first word is not a valid unit, it needs fixing
    if (!validUnits.includes(firstWord)) {
        console.log(`   ⚠️ Non-standard unit detected: "${nutritionalInfo.standardUnit}" (normalized: "${firstWord}")`);
        return true;
    }
    
    // Check for parenthetical descriptions that indicate improper formatting
    // e.g., "fillet (≈170 g)", "oz (1 medium breast)", "teaspoon (2 g)", "tsp (≈6 g)"
    if (unit.includes('(') && unit.includes(')')) {
        console.log(`   ⚠️ Parenthetical description detected: "${nutritionalInfo.standardUnit}"`);
        return true;
    }
    
    // Check for descriptive multi-word units that aren't valid
    // e.g., "lime yields", "avocado, NS as to Florida", "onion"
    if (unit.includes(',') || unit.includes('yields') || unit.includes(' as ')) {
        console.log(`   ⚠️ Descriptive unit detected: "${nutritionalInfo.standardUnit}"`);
        return true;
    }
    
    return false;
}

/**
 * Fix standard unit using AI (OpenAI GPT-4o)
 * 
 * @param {string} ingredientName - Name of ingredient
 * @param {object} nutritionalInfo - Current nutritional info
 * @returns {Promise<object>} Updated nutritional info with fixed unit
 */
async function fixStandardUnitWithAI(ingredientName, nutritionalInfo) {
    try {
        console.log(`🤖 Asking AI to fix standard unit for: "${ingredientName}"`);
        
        const weightUnits = ['lb', 'lbs', 'oz', 'g', 'kg'];
        const volumeUnits = ['cup', 'cups', 'tbsp', 'tsp', 'ml', 'l'];
        const allStandardUnits = [...weightUnits, ...volumeUnits];
        
        const prompt = `You are a nutrition expert. Fix the non-standard unit for "${ingredientName}".

Current Standard: ${nutritionalInfo.standardAmount} ${nutritionalInfo.standardUnit}

Nutritional Values:
- Calories: ${nutritionalInfo.calories}
- Protein: ${nutritionalInfo.proteinG}g
- Fat: ${nutritionalInfo.fatG}g
- Carbs: ${nutritionalInfo.carbohydratesG}g
- Sodium: ${nutritionalInfo.sodiumMg}mg

The current unit "${nutritionalInfo.standardUnit}" is non-standard and makes conversions difficult.

CRITICAL RULES:
1. standardAmount and standardUnit MUST ALWAYS be weight (oz, g, kg, lb) or volume (cup, tbsp, tsp, ml, l)
2. NEVER use descriptive units like "fillet (≈170 g)", "1 medium breast", "whole", "piece", or "item"
3. Convert descriptive units to actual weight/volume
4. Extract numbers from parenthetical descriptions like "(≈170 g)" → 170, "g" or convert to oz

Examples of CORRECT fixes:
- "1 fillet (≈170 g)" → amount: 6, unit: "oz" (convert ~170g to 6 oz)
- "1 medium breast (174g)" → amount: 174, unit: "g"  
- "1 cup diced" → amount: 1, unit: "cup"
- "piece" → amount: 4, unit: "oz" (estimate appropriate weight for this ingredient)

UNIT SELECTION RULES:
- For MEATS (beef, chicken, pork, fish, etc.): Use WEIGHT units (${weightUnits.join(', ')})
- For LIQUIDS: Use VOLUME units (${volumeUnits.join(', ')})
- For OTHER SOLIDS (vegetables, fruits, grains, etc.): Use VOLUME units (${volumeUnits.join(', ')})

Available units: ${weightUnits.join(', ')}, ${volumeUnits.join(', ')}
DO NOT use: whole, piece, item, unit, fillet, breast, or any descriptive terms

Respond ONLY with JSON (no other text):
{
  "amount": <number>,
  "unit": "<weight or volume unit only>",
  "reasoning": "<brief explanation>"
}`;

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 200
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        const aiResponse = response.data.choices[0].message.content.trim();
        
        // Parse JSON
        let suggestion;
        try {
            suggestion = JSON.parse(aiResponse);
        } catch (parseError) {
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                suggestion = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('Failed to parse AI response');
            }
        }
        
        console.log(`   ✅ AI suggestion: ${suggestion.amount} ${suggestion.unit} - ${suggestion.reasoning}`);
        
        // Update nutritional info with new standard unit
        return {
            ...nutritionalInfo,
            standardAmount: suggestion.amount,
            standardUnit: suggestion.unit
        };
        
    } catch (error) {
        console.error('Error fixing standard unit with AI:', error);
        return nutritionalInfo; // Return original if AI fails
    }
}

/**
 * Resolve all ingredients for a recipe
 * Takes ingredient names/DIDs and returns resolved ingredient objects with nutritional info
 * 
 * @param {Array} ingredientArray - Array of ingredient names or DIDs
 * @param {Array} ingredientAmounts - Array of amounts
 * @param {Array} ingredientUnits - Array of units
 * @param {string} userPublicKey - User's public key (optional, for future use)
 * @param {OIPClient} oipClient - Optional custom client instance
 * @returns {Promise<Array>} Resolved ingredients with nutritional data
 */
async function resolveRecipeIngredients(ingredientArray, ingredientAmounts, ingredientUnits, userPublicKey = null, oipClient = null) {
    const resolvedIngredients = [];
    const client = oipClient || new OIPClient(); // Create client for this operation
    
    for (let i = 0; i < ingredientArray.length; i++) {
        const ingredientRef = ingredientArray[i];
        const amount = ingredientAmounts[i];
        const unit = ingredientUnits[i];
        
        console.log(`\n📋 Processing ingredient ${i + 1}/${ingredientArray.length}: "${ingredientRef}"`);
        
        let ingredient = null;
        let ingredientDID = null;
        
        // Check if it's already a DID
        if (typeof ingredientRef === 'string' && ingredientRef.startsWith('did:')) {
            console.log('   ℹ️ Already a DID, looking up...');
            
            // Fetch the ingredient by DID via oipClient
            try {
                const response = await client.getRecords({ did: ingredientRef });
                
                if (response && response.records && response.records.length > 0) {
                    ingredient = response.records[0];
                    ingredientDID = ingredientRef;
                    console.log(`   ✅ Found ingredient by DID: ${ingredient.data?.basic?.name}`);
                }
            } catch (error) {
                console.error('   ❌ Failed to fetch ingredient by DID:', error.message);
            }
        } else if (typeof ingredientRef === 'string') {
            // It's a name, try to resolve it
            console.log('   ℹ️ Ingredient name provided, searching...');
            
            // Step 1: Search for existing ingredient
            ingredient = await searchIngredientByName(ingredientRef, client);
            
            if (ingredient) {
                ingredientDID = ingredient.oip?.didTx || ingredient.oip?.did;
                console.log(`   ✅ Using existing ingredient DID: ${ingredientDID}`);
            } else {
                // Step 2: Fetch from Nutritionix
                console.log('   ⚠️ No existing ingredient found, fetching from Nutritionix...');
                ingredient = await fetchAndCreateIngredient(ingredientRef);
                
                if (ingredient) {
                    // We'll need to publish this as a new ingredient
                    console.log('   ✅ Created new ingredient from Nutritionix data');
                } else {
                    console.error(`   ❌ Failed to resolve ingredient: ${ingredientRef}`);
                    resolvedIngredients.push({
                        name: ingredientRef,
                        amount,
                        unit,
                        error: 'Could not resolve ingredient',
                        ingredientRef: ingredientRef
                    });
                    continue;
                }
            }
        }
        
        if (!ingredient) {
            console.error(`   ❌ No ingredient data available for: ${ingredientRef}`);
            resolvedIngredients.push({
                name: ingredientRef,
                amount,
                unit,
                error: 'No ingredient data',
                ingredientRef: ingredientRef
            });
            continue;
        }
        
        // Step 3: Check if standard unit needs fixing
        if (ingredient.data && ingredient.data.nutritionalInfo) {
            if (needsStandardUnitFix(ingredient.data.nutritionalInfo, ingredient.data.basic?.name || ingredientRef)) {
                console.log('   🔧 Fixing problematic standard unit...');
                ingredient.data.nutritionalInfo = await fixStandardUnitWithAI(
                    ingredient.data.basic?.name || ingredientRef,
                    ingredient.data.nutritionalInfo
                );
            }
        }
        
        resolvedIngredients.push({
            name: ingredient.data?.basic?.name || ingredientRef,
            amount,
            unit,
            did: ingredientDID,
            data: ingredient.data,
            isNew: ingredient.isNew || false,
            ingredientRef: ingredientRef
        });
    }
    
    return resolvedIngredients;
}

module.exports = {
    searchIngredientByName,
    fetchAndCreateIngredient,
    needsStandardUnitFix,
    fixStandardUnitWithAI,
    resolveRecipeIngredients
};

