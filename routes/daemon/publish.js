const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');

const { authenticateToken, getTemplateTxidByName } = require('../../helpers/utils'); // Import the authentication middleware
const { TurboFactory, ArDriveUploadDriver } = require('@ardrive/turbo-sdk');
// Lit Protocol is optional - lazy load only if needed
let encryptContent, decryptContent, createBitcoinPaymentCondition;
try {
    const litProtocol = require('../../helpers/lit-protocol');
    encryptContent = litProtocol.encryptContent;
    decryptContent = litProtocol.decryptContent;
    createBitcoinPaymentCondition = litProtocol.createBitcoinPaymentCondition;
} catch (e) {
    const notAvailable = async () => { throw new Error('Lit Protocol not available'); };
    encryptContent = notAvailable;
    decryptContent = notAvailable;
    createBitcoinPaymentCondition = () => { throw new Error('Lit Protocol not available'); };
}
const fs = require('fs').promises;
const path = require('path');
const { getRecords, searchTemplateByTxId, addRecipeNutritionalSummary, calculateRecipeNutrition } = require('../../helpers/core/elasticsearch');
const { publishNewRecord} = require('../../helpers/core/templateHelper');
const arweaveWallet = require('../../helpers/core/arweave-wallet');
const paymentManager = require('../../helpers/payment-manager');
const publisherManager = require('../../helpers/publisher-manager');
const mediaManager = require('../../helpers/core/media-manager');
const { resolveDrefsInRecord } = require('../../helpers/core/dref-resolver');
const { fetchNutritionalData } = require('../../helpers/nutritional-helper');
// Import shared recipe resolver helper
const { resolveRecipeIngredients } = require('../../helpers/core/recipe-resolver');

// Kaggle integration for exercise data
let kaggleDataset = null;

/**
 * Initialize Kaggle dataset for exercise data
 */
async function initializeKaggleDataset() {
    if (kaggleDataset) return kaggleDataset;
    
    try {
        console.log('Initializing Kaggle fitness exercises dataset...');
        
        kaggleDataset = {
            searchExercise: async (exerciseName) => {
                return await searchKaggleExercise(exerciseName);
            }
        };
        
        console.log('Kaggle dataset initialized');
        return kaggleDataset;
    } catch (error) {
        console.error('Error initializing Kaggle dataset:', error);
        throw error;
    }
}

/**
 * Search for exercise data using Python Kaggle integration
 */
async function searchKaggleExercise(exerciseName) {
    try {
        console.log(`Searching Kaggle dataset for exercise: ${exerciseName}`);
        
        const { spawn } = require('child_process');
        const pythonScript = path.join(__dirname, '..', 'kaggle-exercise-fetcher.py');
        
        return new Promise((resolve, reject) => {
            const python = spawn('python3', [pythonScript, exerciseName, '--format', 'json']);
            
            let stdout = '';
            let stderr = '';
            
            python.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            python.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            python.on('close', (code) => {
                if (code === 0) {
                    try {
                        const exerciseData = JSON.parse(stdout);
                        console.log(`Found exercise data for ${exerciseName}:`, exerciseData);
                        resolve(exerciseData);
                    } catch (parseError) {
                        console.error('Error parsing exercise data JSON:', parseError);
                        resolve(null);
                    }
                } else {
                    console.log(`Python script exited with code ${code}`);
                    console.log('stderr:', stderr);
                    
                    // Fallback to mock data if Python script fails
                    console.log('Falling back to mock exercise data...');
                    const mockExerciseData = {
                        name: exerciseName,
                        instructions: [
                            "Set up in starting position",
                            "Perform the movement with proper form", 
                            "Return to starting position"
                        ],
                        muscle_groups: ["general"],
                        difficulty: "intermediate",
                        category: "strength",
                        equipment_required: [],
                        alternative_equipment: [],
                        is_bodyweight: true,
                        exercise_type: "compound",
                        recommended_sets: 3,
                        recommended_reps: 12,
                        duration_minutes: 0,
                        goal_tags: ["general fitness"],
                        image_url: "",
                        video_url: "",
                        source_url: "https://www.kaggle.com/datasets/edoardoba/fitness-exercises-with-animations"
                    };
                    resolve(mockExerciseData);
                }
            });
            
            python.on('error', (error) => {
                console.error('Error running Python script:', error);
                // Resolve with null to trigger fallback
                resolve(null);
            });
        });
        
    } catch (error) {
        console.error(`Error searching for exercise ${exerciseName}:`, error);
        return null;
    }
}

/**
 * Create new exercise record from Kaggle data
 */
async function createNewExerciseRecord(exerciseName, blockchain = 'arweave') {
    try {
        console.log(`Fetching exercise info for missing exercise: ${exerciseName}`);
        
        // Initialize Kaggle dataset
        const dataset = await initializeKaggleDataset();
        
        // Search for exercise in Kaggle dataset
        const exerciseData = await dataset.searchExercise(exerciseName);
        
        if (!exerciseData || !exerciseData.name) {
            console.log(`No valid exercise data found for: ${exerciseName}`);
            return null;
        }
        
        // Format the exercise data according to OIP exercise template
        const formattedExerciseInfo = {
            basic: {
                name: exerciseData.name || exerciseName, // Use exerciseName as fallback
                date: Math.floor(Date.now() / 1000),
                language: 'en',
                nsfw: false,
                webUrl: exerciseData.source_url || '',
                description: `${exerciseData.name || exerciseName} - ${exerciseData.category || 'exercise'} exercise targeting ${(exerciseData.muscle_groups || ['general']).join(', ')}`,
                tagItems: exerciseData.goal_tags || []
            },
            exercise: {
                instructions: exerciseData.instructions,
                muscleGroups: exerciseData.muscle_groups,
                difficulty: exerciseData.difficulty,
                category: exerciseData.category,
                imageUrl: exerciseData.image_url || '',
                videoUrl: exerciseData.video_url || '',
                gitUrl: '', // Not available in Kaggle dataset
                equipmentRequired: exerciseData.equipment_required || [],
                alternativeEquipment: exerciseData.alternative_equipment || [],
                isBodyweight: exerciseData.is_bodyweight || false,
                exercise_type: exerciseData.exercise_type,
                // measurement_type: 
                est_duration_minutes: exerciseData.duration_minutes || 0,
                target_duration_seconds: exerciseData.duration_minutes * 60 || 0,
                recommended_sets: exerciseData.recommended_sets || 3,
                recommended_reps: exerciseData.recommended_reps || 12,
                goalTags: exerciseData.goal_tags || []
            }
        };
        
        // Add measurement_type determination logic after creating formattedExerciseInfo
        let measurementType = 'reps'; // default

        const exerciseNameLower = (exerciseData.name || exerciseName).toLowerCase();
        const categoryLower = (exerciseData.category || '').toLowerCase();
        const exerciseTypeLower = (exerciseData.exercise_type || '').toLowerCase();

        // Check for timed exercises
        if (exerciseData.duration_minutes > 0 || 
            categoryLower.includes('cardio') || 
            exerciseTypeLower.includes('cardio') ||
            exerciseNameLower.includes('running') ||
            exerciseNameLower.includes('cycling') ||
            exerciseNameLower.includes('walking') ||
            exerciseNameLower.includes('jogging')) {
          measurementType = 'timed';
        }
        // Check for hold exercises
        else if (exerciseNameLower.includes('plank') ||
                 exerciseNameLower.includes('hold') ||
                 exerciseNameLower.includes('wall sit') ||
                 exerciseNameLower.includes('static') ||
                 exerciseNameLower.includes('isometric') ||
                 exerciseNameLower.includes('bridge') ||
                 exerciseNameLower.includes('pose')) {
          measurementType = 'hold';
        }
        // Check for max duration exercises
        else if ((exerciseNameLower.includes('max') && exerciseNameLower.includes('duration')) ||
                 exerciseNameLower.includes('as long as possible') ||
                 exerciseNameLower.includes('until failure')) {
          measurementType = 'maxdur';
        }

        // Add measurement_type to the exercise object
        formattedExerciseInfo.exercise.measurement_type = measurementType;
        
        // Publish the exercise record
        const exerciseTx = await publishNewRecord(formattedExerciseInfo, "exercise", false, false, false, null, blockchain);
        console.log(`Successfully retrieved and published exercise info for ${exerciseName}:`, formattedExerciseInfo, exerciseTx);
        return exerciseTx.recordToIndex;
    } catch (error) {
        console.error(`Error fetching exercise info for ${exerciseName}:`, error);
        return null;
    }
}

// Initialize ArDrive Turbo with wallet file
const initTurbo = async () => {
    try {
        const walletData = await fs.readFile(process.env.WALLET_FILE, 'utf8');
        const wallet = JSON.parse(walletData);
        
        const turbo = await TurboFactory.init({
            wallet,
            turboUrl: process.env.TURBO_URL || 'https://turbo.ardrive.io'
        });

        return turbo;
    } catch (error) {
        console.error('Failed to initialize Turbo with wallet file:', error);
        throw error;
    }
};

let turboInstance = null;

// Get or initialize Turbo instance
const getTurbo = async () => {
    if (!turboInstance) {
        turboInstance = await initTurbo();
    }
    return turboInstance;
};

// Add schema/example endpoints for proper JSON formatting
router.get('/newRecipe/schema', (req, res) => {
    try {
        const recipeSchema = {
            "description": "Complete JSON schema for publishing a new recipe via POST /api/publish/newRecipe",
            "example": {
                "basic": {
                    "name": "Mediterranean Grilled Chicken",
                    "language": "en",
                    "date": Math.floor(Date.now() / 1000),
                    "description": "Juicy grilled chicken thighs marinated in a bold Mediterranean-style blend of garlic, lemon, and spices.",
                    "webUrl": "https://example.com/recipe",
                    "nsfw": false,
                    "tagItems": ["grilled", "mediterranean", "chicken", "healthy"]
                },
                "recipe": {
                    "prep_time_mins": 15,
                    "cook_time_mins": 25,
                    "total_time_mins": 40,
                    "servings": 4,
                    "ingredient_amount": [4, 2, 1, 0.5, 2],
                    "ingredient_unit": ["pieces", "tbsp", "lemon", "tsp", "cloves"],
                    "ingredient": [
                        "chicken thighs, boneless skinless",
                        "olive oil, extra virgin", 
                        "lemon, juiced",
                        "oregano, dried",
                        "garlic, minced"
                    ],
                    "instructions": "1. Marinate chicken in olive oil, lemon juice, oregano, and garlic for 30 minutes.\n2. Preheat grill to medium-high heat.\n3. Grill chicken for 6-7 minutes per side until cooked through.\n4. Let rest for 5 minutes before serving.",
                    "notes": "For best results, marinate for at least 30 minutes or up to 4 hours.",
                    "cuisine": "Mediterranean",
                    "course": "Main Course",
                    "author": "Chef Example"
                },
                "image": {
                    "webUrl": "https://example.com/recipe-image.jpg",
                    "contentType": "image/jpeg"
                },
                "blockchain": "arweave"
            },
            "field_descriptions": {
                "basic.name": "Recipe title (required)",
                "basic.language": "Language code (default: 'en')",
                "basic.date": "Unix timestamp (default: current time)",
                "basic.description": "Recipe description (required)",
                "basic.webUrl": "Optional source URL",
                "basic.nsfw": "Boolean for adult content (default: false)",
                "basic.tagItems": "Array of tags for categorization",
                "recipe.prep_time_mins": "Preparation time in minutes",
                "recipe.cook_time_mins": "Cooking time in minutes", 
                "recipe.total_time_mins": "Total time in minutes",
                "recipe.servings": "Number of servings",
                "recipe.ingredient_amount": "Array of amounts (numbers)",
                "recipe.ingredient_unit": "Array of units (strings)",
                "recipe.ingredient": "Array of ingredient names with optional descriptors",
                "recipe.instructions": "Step-by-step cooking instructions",
                "recipe.notes": "Optional additional notes",
                "recipe.cuisine": "Cuisine type (e.g., 'Italian', 'Mexican')",
                "recipe.course": "Course type (e.g., 'Main Course', 'Dessert')",
                "recipe.author": "Recipe author name",
                "image.webUrl": "URL to recipe image",
                "image.contentType": "Image MIME type",
                "blockchain": "Target blockchain ('arweave' or 'turbo')"
            },
            "ingredient_parsing_notes": {
                "format": "Ingredients support automatic parsing of comments in parentheses or after commas",
                "examples": [
                    "chicken thighs, boneless skinless",
                    "flour tortillas (12-inch)",
                    "garlic cloves (minced)",
                    "olive oil, extra virgin"
                ],
                "automatic_processing": "The system will automatically separate base ingredients from descriptive comments and look up nutritional information"
            }
        };

        res.status(200).json(recipeSchema);
    } catch (error) {
        console.error('Error generating recipe schema:', error);
        res.status(500).json({ error: 'Failed to generate recipe schema' });
    }
});

// Add workout schema endpoint
router.get('/newWorkout/schema', (req, res) => {
    try {
        const workoutSchema = {
            "description": "Complete JSON schema for publishing a new workout via POST /api/publish/newWorkout",
            "example": {
                "basic": {
                    "name": "Upper Body Strength Training",
                    "language": "en", 
                    "date": Math.floor(Date.now() / 1000),
                    "description": "A comprehensive upper body workout focusing on strength and muscle building.",
                    "webUrl": "https://example.com/workout",
                    "nsfw": false,
                    "tagItems": ["strength", "upper body", "muscle building", "intermediate"]
                },
                "workout": {
                    "total_duration_minutes": 45,
                    "estimated_calories_burned": 300,
                    "includesWarmup": true,
                    "includesMain": true,
                    "includesCooldown": true,
                    "nonStandardWorkout": false,
                    "exercise_amount": [1, 3, 3, 2],
                    "exercise_unit": ["sets", "sets", "sets", "sets"],
                    "exercise": ["did:arweave:arm-circles", "did:arweave:push-ups", "did:arweave:dumbbell-bench-press", "did:arweave:stretching"],
                    "instructions": "1. Start with 5-minute warm-up\n2. Perform main exercises with proper form\n3. Rest 60-90 seconds between sets\n4. Finish with cooldown stretches",
                    "goalTags": ["muscle building", "strength", "upper body"],
                    "author": "Trainer Example",
                    "authorDRef": "did:arweave:trainer-example",
                    "notes": "Ensure proper form throughout all exercises. Adjust weights as needed."
                },
                "image": {
                    "webUrl": "https://example.com/workout-image.jpg",
                    "contentType": "image/jpeg"
                },
                "blockchain": "arweave"
            },
            "field_descriptions": {
                "basic.*": "Same structure as recipe basic fields",
                "workout.total_duration_minutes": "Total workout duration in minutes",
                "workout.estimated_calories_burned": "Estimated calories burned during workout",
                "workout.includesWarmup": "Boolean indicating if workout includes warm-up",
                "workout.includesMain": "Boolean indicating if workout includes main workout",
                "workout.includesCooldown": "Boolean indicating if workout includes cooldown",
                "workout.nonStandardWorkout": "Set to true to skip exercise database lookup",
                "workout.exercise_amount": "Array of amounts for each exercise (e.g., number of sets)",
                "workout.exercise_unit": "Array of units for each exercise (e.g., 'sets', 'minutes', 'reps')",
                "workout.exercise": "Array of exercise DID references or names (names will be looked up)",
                "workout.instructions": "Step-by-step workout instructions",
                "workout.goalTags": "Array of fitness goals and tags",
                "workout.author": "Workout creator name",
                "workout.authorDRef": "DID reference to workout author",
                "workout.notes": "Additional notes about the workout",
                "image.webUrl": "URL to workout image",
                "image.contentType": "Image MIME type",
                "blockchain": "Target blockchain ('arweave' or 'turbo')"
            },
            "exercise_lookup_notes": {
                "automatic_processing": "Exercise names in workout.exercise array are automatically looked up in the exercise database using exact name matching",
                "nonStandardWorkout_true": "If set to true: Missing exercises will be created as new exercise records (from Kaggle dataset if available)",
                "nonStandardWorkout_false": "If set to false or omitted: Missing exercises will be skipped and excluded from the workout (only existing exercises are included)",
                "did_strings": "DID strings (e.g., 'did:arweave:abc123') are always preserved as-is regardless of nonStandardWorkout setting",
                "array_alignment": "exercise_amount, exercise_unit, and exercise arrays must have the same length"
            }
        };

        res.status(200).json(workoutSchema);
    } catch (error) {
        console.error('Error generating workout schema:', error);
        res.status(500).json({ error: 'Failed to generate workout schema' });
    }
});

// Add dynamic post schema endpoint
router.get('/newPost/schema', async (req, res) => {
    try {
        const postSchema = await generateDynamicSchema('post', 'POST /api/publish/newPost', 'post record');
        res.status(200).json(postSchema);
    } catch (error) {
        console.error('Error generating dynamic post schema:', error);
        res.status(500).json({ 
            error: 'Failed to generate dynamic post schema',
            details: error.message 
        });
    }
});

// Add general schema endpoint that lists all available schemas
router.get('/schemas', (req, res) => {
    try {
        const templatesConfig = require('../../config/templates.config.js');
        const availableTemplates = Object.keys(templatesConfig.defaultTemplates);
        
        const availableSchemas = {
            "description": "Available JSON schemas for OIP publishing endpoints",
            "dynamic_schema_endpoint": {
                "url": "GET /api/publish/schema?recordType={recordType}",
                "description": "Dynamic schema generator that works with any record type from templates.config.js",
                "usage": "GET /api/publish/schema?recordType=mealPlan",
                "supported_record_types": availableTemplates
            },
            "specific_schemas": {
                "recipe": {
                    "endpoint": "POST /api/publish/newRecipe",
                    "schema_url": "GET /api/publish/newRecipe/schema",
                    "description": "Publish recipe records with automatic ingredient processing"
                },
                "workout": {
                    "endpoint": "POST /api/publish/newWorkout", 
                    "schema_url": "GET /api/publish/newWorkout/schema",
                    "description": "Publish workout records with automatic exercise lookup"
                },
                "post": {
                    "endpoint": "POST /api/publish/newPost",
                    "schema_url": "GET /api/publish/newPost/schema", 
                    "description": "Publish article/blog post records (dynamically generated schema)"
                },
                "text": {
                    "endpoint": "POST /api/publish/newText",
                    "schema_url": "GET /api/publish/newText/schema",
                    "description": "Publish text document records (dynamically generated schema)"
                },
                "nutritionalInfo": {
                    "endpoint": "POST /api/publish/newNutritionalInfo",
                    "schema_url": "GET /api/publish/newNutritionalInfo/schema",
                    "description": "Publish nutritional information records"
                },
                "video": {
                    "endpoint": "POST /api/publish/newVideo",
                    "schema_url": "GET /api/publish/newVideo/schema",
                    "description": "Publish video records with YouTube support (dynamically generated schema)"
                },
                "image": {
                    "endpoint": "POST /api/publish/newImage",
                    "schema_url": "GET /api/publish/newImage/schema",
                    "description": "Publish image records (dynamically generated schema)"
                }
            },
            "common_parameters": {
                "blockchain": "Target blockchain: 'arweave' (default) or 'turbo'",
                "publishFiles": "Boolean to enable file publishing (default: varies by endpoint)",
                "addMediaToArweave": "Boolean to store media on Arweave (default: true)",
                "addMediaToIPFS": "Boolean to store media on IPFS (default: false)",
                "addMediaToArFleet": "Boolean to store media on ArFleet (default: false)"
            },
            "examples": {
                "dynamic_schema_examples": [
                    "GET /api/publish/schema?recordType=mealPlan",
                    "GET /api/publish/schema?recordType=workoutSchedule",
                    "GET /api/publish/schema?recordType=fitnessEquipment",
                    "GET /api/publish/schema?recordType=organization",
                    "GET /api/publish/schema?recordType=conversationSession"
                ]
            }
        };

        res.status(200).json(availableSchemas);
    } catch (error) {
        console.error('Error generating schemas list:', error);
        res.status(500).json({ error: 'Failed to generate schemas list' });
    }
});


router.get('/newBasic/schema', async (req, res) => { 
    try {
        const basicSchema = await generateDynamicSchema('basic', 'POST /api/publish/newBasic', 'basic record');
        res.status(200).json(basicSchema);
    } catch (error) {
        console.error('Error generating basic schema:', error);
        res.status(500).json({ error: 'Failed to generate basic schema' });
    }
});

// Function to create new nutritional info records for missing ingredients
async function createNewNutritionalInfoRecord(ingredientName, blockchain = 'arweave', recipeUnit = '') {
  try {
    // Determine preferred unit type based on recipe unit
    const isVolumeUnit = recipeUnit && (
      recipeUnit.includes('cup') || recipeUnit.includes('tbsp') || recipeUnit.includes('tsp') ||
      recipeUnit.includes('tablespoon') || recipeUnit.includes('teaspoon') ||
      recipeUnit.includes('oz') || recipeUnit.includes('ml') || recipeUnit.includes('liter')
    );
    const preferredUnitType = isVolumeUnit ? 'volume' : 'count';
    
    console.log(`Creating nutritionalInfo for "${ingredientName}" with preferred unit type: ${preferredUnitType} (recipe unit: ${recipeUnit})`);
    
    const formattedNutritionalInfo = await fetchNutritionalData(ingredientName, preferredUnitType);
    const ingredientTx = await publishNewRecord(formattedNutritionalInfo, "nutritionalInfo", false, false, false, null, blockchain);
    console.log(`Successfully published nutritional info for ${ingredientName}:`, ingredientTx);
    return ingredientTx.recordToIndex;
  } catch (error) {
    console.error(`Error creating nutritional info for ${ingredientName}:`, error);
    return null;
  }
}

router.post('/newRecipe', async (req, res) => {
    // Import job tracker
    const { createJob, updateProgress, completeJob, failJob } = require('../../helpers/jobTracker');
    
    try {
        console.log('POST /api/publish/newRecipe', req.body);
        
        // Create job and return immediately
        const jobId = createJob('recipe_publish');
        
        // Send immediate response
        res.status(202).json({
          jobId,
          status: 'pending',
          message: 'Recipe publishing initiated. This may take a few minutes...'
        });
        
        // Process recipe asynchronously
        processRecipeAsync(jobId, req.body, req.user).catch(error => {
          console.error('Async recipe processing error:', error);
          failJob(jobId, error);
        });
        
    } catch (error) {
        console.error('Error initiating recipe publish:', error);
        res.status(500).json({ error: 'Failed to initiate recipe publish' });
    }
});

// Get job status for async publishing operations
router.get('/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const { getJob } = require('../../helpers/jobTracker');
        
        const job = getJob(jobId);
        
        if (!job) {
            return res.status(404).json({
                error: 'Job not found',
                jobId
            });
        }
        
        res.status(200).json(job);
    } catch (error) {
        console.error('Error getting job status:', error);
        res.status(500).json({ error: 'Failed to get job status' });
    }
});

/**
 * Process recipe publishing asynchronously
 * @param {string} jobId - Job tracker ID
 * @param {Object} reqBody - Request body with recipe data
 * @param {Object} user - Authenticated user info
 */
async function processRecipeAsync(jobId, reqBody, user) {
    const { updateProgress, completeJob, failJob } = require('../../helpers/jobTracker');
    
    try {
        console.log('ENV CHECK - NUTRITIONIX_APP_ID:', process.env.NUTRITIONIX_APP_ID ? 'EXISTS' : 'MISSING');
        console.log('ENV CHECK - NUTRITIONIX_API_KEY:', process.env.NUTRITIONIX_API_KEY ? 'EXISTS' : 'MISSING');
        const record = reqBody;
        const blockchain = reqBody.blockchain || 'arweave'; // Get blockchain parameter, default to arweave
        let recordType = 'recipe';
        
        updateProgress(jobId, 5, 'Starting recipe processing...');

    // Process ingredients directly from the single recipe object
    const ingredients = record.recipe.ingredient.map((name, i) => ({
        amount: parseFloat(record.recipe.ingredient_amount[i]) || null,
        unit: record.recipe.ingredient_unit[i] || '',
        name: name || '',
    }));

    console.log('Processing single recipe section with', ingredients.length, 'ingredients');

  // Since ingredient_comment is now provided explicitly, use ingredients as-is
  const parsedIngredients = ingredients.map(ing => ({
    originalString: ing.name,
    ingredient: ing.name,
    comment: ''
  }));

  // Separate ingredients that are didTx values from those that need lookup
  const ingredientNames = []; // Only names that need lookup
  const ingredientNamesForDisplay = []; // All cleaned names for display
  const ingredientComments = record.recipe.ingredient_comment || [];
  const ingredientDidTxMap = {}; // Map original ingredient string to didTx if it's already a didTx
  
  parsedIngredients.forEach((parsed, index) => {
    const originalString = parsed.originalString;
    const ingredient = parsed.ingredient;
    
    // Check if this ingredient string starts with a didTx value
    if (originalString.startsWith('did:')) {
      // Handle didTx with potential comment: "did:arweave:abc123, comment text"
      const commaIndex = originalString.indexOf(',');
      if (commaIndex !== -1) {
        const didTx = originalString.substring(0, commaIndex).trim();
        ingredientDidTxMap[originalString] = didTx;
        ingredientNamesForDisplay.push(didTx);
      } else {
        ingredientDidTxMap[originalString] = originalString;
        ingredientNamesForDisplay.push(originalString);
      }
    } else if (ingredient.startsWith('did:')) {
      ingredientDidTxMap[originalString] = ingredient;
      ingredientNamesForDisplay.push(ingredient);
    } else {
      const normalizedName = ingredient.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
      ingredientNames.push(normalizedName);
      ingredientNamesForDisplay.push(normalizedName);
    }
  });
  
  const ingredientAmounts = ingredients.map(ing => ing.amount ?? 1);
  // Don't default empty units to 'unit' - keep as empty string and handle in calculation
  // CRITICAL: Defaulting to 'unit' causes wrong count-based conversions
  const ingredientUnits = ingredients.map(ing => (ing.unit && ing.unit.trim()) || '');

  console.log(`📊 Ingredients: ${ingredientNames.length} need lookup, ${Object.keys(ingredientDidTxMap).length} already have DIDs`);
    
  // Define ingredient synonyms for better matching
  const synonymMap = {
      "garlic cloves": "minced garlic",
      "ground green cardamom": "ground cardamom",
      "chicken breast": "boneless skinless chicken breast",
      "chicken thighs": "boneless skinless chicken thighs",
      "olive oil": "extra virgin olive oil",
      "vegetable oil": "seed oil",
      "all-purpose flour": "flour",
      "green onions": "scallions",
      "cilantro": "fresh cilantro",
      "parsley": "fresh parsley",
      "basil": "fresh basil",
      "oregano": "fresh oregano",
      "thyme": "fresh thyme",
      "rosemary": "fresh rosemary",
      "sage": "fresh sage",
      "dill": "fresh dill",
      "mint": "fresh mint",
      "chives": "fresh chives",
      "tarragon": "fresh tarragon",
      "bay leaves": "dried bay leaves",
      "red pepper flakes": "crushed red pepper",
      "red pepper": "red bell pepper",
      // Add more as needed
  };

  let recordMap = {};
    
  // Helper function to check if a unit is count-based
  const isCountUnit = (unit) => {
    const countUnits = ['unit', 'units', 'piece', 'pieces', 'item', 'items', 'whole', 'clove', 'cloves', 'large', 'medium', 'small'];
    return countUnits.includes(unit?.toLowerCase()?.trim());
  };
  
  // Helper function to parse units (remove parenthetical descriptions)
  const parseUnit = (unit) => {
    if (!unit) return unit;
    return unit.replace(/\(.*?\)/g, '').trim();
  };
  
  async function fetchIngredientRecordData(cleanedIngredientNames, originalIngredientNames) {
    // CRITICAL FIX: Use the full cleaned ingredient names for search
    // This ensures "grass-fed butter" searches for "grass-fed butter" and creates "grass-fed butter"
    // Instead of searching for "butter" but creating "grass-fed butter"
    const coreIngredientTerms = cleanedIngredientNames.map(name => {
      // Clean the name completely - remove commas, extra spaces
      const cleanName = name.replace(/,/g, '').replace(/\s+/g, ' ').trim();
      
      // For consistency, use the full cleaned name for both search and record creation
      // This prevents the mismatch where we search for "butter" but create "grass-fed butter"
      return cleanName;
    });

    console.log('Core ingredient search terms (using full names):', coreIngredientTerms);
    
    // Search for each ingredient individually to avoid comma splitting issues
    recordMap = {};  // Reset before populating
    let totalRecordsFound = 0;
    
    for (const searchTerm of coreIngredientTerms) {
        try {
            const queryParams = {
                recordType: 'nutritionalInfo',
                template: 'nutritionalInfo',
                fieldName: 'basic.name',
                fieldSearch: searchTerm,
                fieldMatchMode: 'exact',
                noDuplicates: true,
                // Don't provide sortBy to enable similarity-based sorting
                limit: 20
            };
            
                    const recordsInDB = await getRecords(queryParams);
            
            // Add results to recordMap (results are now sorted by similarity)
            // Preserve the fieldSearchScore from elasticsearch for quality checking
            // ONLY include records that have nutritional information
            recordsInDB.records.forEach(record => {
                const recordName = record.data.basic.name.toLowerCase();
                const hasNutritionalInfo = record.data?.nutritionalInfo && 
                                          Object.keys(record.data.nutritionalInfo).length > 0;
                
                if (!recordMap[recordName] && hasNutritionalInfo) {
                    recordMap[recordName] = record;
                    totalRecordsFound++;
                }
            });
        } catch (error) {
            console.error(`Error searching for ingredient "${searchTerm}":`, error);
        }
    }
    
    console.log(`📋 Found ${Object.keys(recordMap).length} existing ingredient records in database`);

    const ingredientDidRefs = {};
    const nutritionalInfo = [];

    // Use cleaned names for searching, but map back to original names for keys
    for (let i = 0; i < cleanedIngredientNames.length; i++) {
        const cleanedName = cleanedIngredientNames[i];
        const originalName = originalIngredientNames[i];
        const coreSearchTerm = coreIngredientTerms[i];
        
        const bestMatch = findBestMatch(cleanedName);
        if (bestMatch) {
            // Check if the match has compatible units with the recipe
            const recipeUnit = ingredientUnits[i] || 'whole';
            const standardUnit = bestMatch.data.nutritionalInfo?.standardUnit || '';
            const isRecipeCountBased = isCountUnit(recipeUnit);
            const isStandardCountBased = isCountUnit(parseUnit(standardUnit));
            const hasQtyField = bestMatch.data.nutritionalInfo?.qtyInStandardAmount !== undefined;
            
            // CRITICAL: Check if standardUnit is invalid (not a proper weight/volume unit)
            // This catches records like standardUnit="onion" or "lime yields" that cause massive multiplier errors
            const validWeightVolumeUnits = [
                'oz', 'g', 'kg', 'lb', 'lbs', 'gram', 'grams', 'ounce', 'ounces', 'pound', 'pounds',
                'cup', 'cups', 'tbsp', 'tsp', 'ml', 'l', 'tablespoon', 'tablespoons', 'teaspoon', 'teaspoons'
            ];
            const firstWordOfUnit = standardUnit.toLowerCase().trim().split(' ')[0].split('(')[0];
            const hasInvalidUnit = !validWeightVolumeUnits.includes(firstWordOfUnit) && standardUnit.length > 0;
            
            // Also check for descriptive units that need fixing
            const hasDescriptiveUnit = standardUnit.includes(',') || standardUnit.includes('yields') || 
                                       standardUnit.includes(' as ') || standardUnit.includes('(');
            
            // Check for problematic volume↔weight mismatches that cause wrong conversions
            // Example: Recipe uses "cup", ingredient has "g" → forces liquid conversion (1 cup = 240g)
            // This is WRONG for dry goods like quinoa (1 cup = 170g), corn (1 cup = 145g)
            const recipeIsVolume = recipeUnit && (recipeUnit.includes('cup') || recipeUnit.includes('tbsp') || recipeUnit.includes('tsp'));
            const standardIsWeight = standardUnit && (standardUnit.includes('g') || standardUnit.includes('oz') || standardUnit.includes('lb'));
            const volumeWeightMismatch = recipeIsVolume && standardIsWeight;
            
            // Determine if record needs regeneration
            const unitsIncompatible = (isRecipeCountBased !== isStandardCountBased) && !hasQtyField;
            const needsRegeneration = hasInvalidUnit || hasDescriptiveUnit || unitsIncompatible || volumeWeightMismatch;
            
            if (needsRegeneration) {
                const reason = hasInvalidUnit ? 'invalid standardUnit' : 
                               hasDescriptiveUnit ? 'descriptive standardUnit' : 
                               volumeWeightMismatch ? `volume↔weight mismatch (recipe:${recipeUnit}, standard:${standardUnit})` :
                               'missing qtyInStandardAmount';
                console.log(`⚠️ "${bestMatch.data.basic.name}" needs regeneration (${reason}): standardUnit="${standardUnit}". Will regenerate.`);
                ingredientDidRefs[originalName] = null; // Force regeneration
            } else {
                ingredientDidRefs[originalName] = bestMatch.oip.did || bestMatch.oip.didTx;
                nutritionalInfo.push({
                    ingredientName: bestMatch.data.basic.name,
                    nutritionalInfo: bestMatch.data.nutritionalInfo || {},
                    ingredientSource: bestMatch.data.basic.webUrl,
                    ingredientDidRef: bestMatch.oip.did || bestMatch.oip.didTx
                });
                console.log(`  ✅ Matched: ${originalName}`);
            }
        } else {
            ingredientDidRefs[originalName] = null;
        }
    }

    return { ingredientDidRefs, nutritionalInfo };

    
  }

// } catch (error) {
// console.error('Error fetching parsed recipe data:', error);
// sendUpdate('error', { message: 'Failed to fetch recipe data.' });
// res.end();
// ongoingScrapes.delete(scrapeId);
// }



    
  // Function to calculate minimum score threshold for accepting a match
  function calculateMinimumScoreThreshold(totalTerms, matchedTerms) {
    // More lenient thresholds to avoid creating duplicate records
    // Focus on finding reasonable matches rather than perfect ones
    
    // Calculate threshold based on ingredient complexity
    if (totalTerms === 1) {
        // Single word: require exact match
        return 10; // Just the base score
    } else if (totalTerms === 2) {
        // Two words: require at least one core term match
        // Example: "grass-fed butter" should match "butter" (score = 10)
        return 8; // Allow matches with just one term
    } else if (totalTerms === 3) {
        // Three words: require at least one core term match
        // Example: "raw grass-fed butter" should match "butter" (score = 10)
        return 8; // Allow matches with just one key term
    } else {
        // More than 3 words: require at least some terms to match
        return Math.max(15, Math.ceil(totalTerms * 0.3) * 10); // 30% of terms minimum
    }
  }

  // Function to find the best match
  function findBestMatch(ingredientName) {
    if (!recordMap || Object.keys(recordMap).length === 0) {
        console.log(`No records available in recordMap for matching ${ingredientName}`);
        return null;
    }

    const searchTerms = ingredientName.split(/\s+/).filter(Boolean);
    console.log(`Searching for ingredient: ${ingredientName}, Search terms:`, searchTerms);

    // Check if the ingredient has a predefined synonym
    const synonym = synonymMap[ingredientName];
    if (synonym && recordMap[synonym]) {
        const synonymRecord = recordMap[synonym];
        const fieldSearchScore = synonymRecord.fieldSearchScore || 0;
        
        // Check if synonym match has high enough quality score
        if (fieldSearchScore >= 900) {
            console.log(`Found high-quality synonym match for ${ingredientName}: ${synonym} (fieldSearchScore: ${fieldSearchScore})`);
            return synonymRecord;
        } else {
            console.log(`Synonym match "${synonym}" has low fieldSearchScore (${fieldSearchScore} < 900), will search for better match or create new record`);
        }
    }

    // Direct exact match
    if (recordMap[ingredientName]) {
        const directMatch = recordMap[ingredientName];
        const fieldSearchScore = directMatch.fieldSearchScore || 0;
        
        // Check if direct match has high enough quality score
        if (fieldSearchScore >= 900) {
            console.log(`Direct high-quality match found for ${ingredientName} (fieldSearchScore: ${fieldSearchScore}), nutritionalInfo:`, directMatch.data.nutritionalInfo);
            return directMatch;
        } else {
            console.log(`Direct match for "${ingredientName}" has low fieldSearchScore (${fieldSearchScore} < 900), will create new record`);
            return null; // Reject low-quality matches
        }
    }

    // Define descriptor words that are less important for matching
    const descriptorWords = [
        'grass-fed', 'free-range', 'organic', 'raw', 'fresh', 'frozen', 'dried', 'canned',
        'whole', 'ground', 'chopped', 'minced', 'sliced', 'diced', 'shredded', 'grated',
        'extra', 'virgin', 'pure', 'unrefined', 'unsweetened', 'unsalted', 'salted',
        'lean', 'fat-free', 'low-fat', 'reduced-fat', 'light', 'heavy', 'thick', 'thin',
        'large', 'medium', 'small', 'baby', 'mature', 'young', 'old',
        'hot', 'mild', 'sweet', 'sour', 'bitter', 'spicy', 'bland',
        'cooked', 'raw', 'roasted', 'baked', 'fried', 'grilled', 'steamed', 'boiled',
        'boneless', 'skinless', 'trimmed', 'untrimmed', 'with', 'without',
        'pastured', 'wild', 'farm-raised', 'cage-free', 'antibiotic-free', 'hormone-free'
    ];

    // Identify core ingredient terms (non-descriptors)
    const coreTerms = searchTerms.filter(term => !descriptorWords.includes(term.toLowerCase()));
    const descriptorTermsInSearch = searchTerms.filter(term => descriptorWords.includes(term.toLowerCase()));

    console.log(`Core terms: [${coreTerms.join(', ')}], Descriptor terms: [${descriptorTermsInSearch.join(', ')}]`);

    // Look for matches and score them properly
    const scoredMatches = Object.keys(recordMap)
        .map(recordName => {
            const normalizedRecordName = recordName.toLowerCase();
            const recordTerms = normalizedRecordName.split(/\s+/).filter(Boolean);
            
            let score = 0;
            let matchedTerms = 0;
            let coreMatchedTerms = 0;
            let exactSequenceBonus = 0;
            
            searchTerms.forEach(term => {
                if (recordTerms.includes(term)) {
                    matchedTerms++;
                    const isCoreIngredient = coreTerms.includes(term);
                    if (isCoreIngredient) {
                        coreMatchedTerms++;
                        score += 15;
                    } else {
                        score += 5;
                    }
                }
            });
            
            if (searchTerms.length >= 2) {
                const searchSequence = searchTerms.join(' ');
                if (normalizedRecordName.includes(searchSequence)) {
                    exactSequenceBonus = 50;
                    score += exactSequenceBonus;
                }
            }
            
            if (matchedTerms === searchTerms.length) {
                score += 20;
            }
            
            if (coreMatchedTerms === coreTerms.length && coreTerms.length > 0) {
                score += 30;
            }
            
            const extraTerms = recordTerms.length - matchedTerms;
            score -= extraTerms * 2;
            
            if (matchedTerms === 0) {
                score = 0;
            }
            
            return {
                record: recordMap[recordName],
                recordName: normalizedRecordName,
                score: score,
                matchedTerms: matchedTerms,
                coreMatchedTerms: coreMatchedTerms,
                totalTerms: searchTerms.length,
                totalCoreTerms: coreTerms.length,
                exactSequence: exactSequenceBonus > 0
            };
        })
        .filter(match => match.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scoredMatches.length > 0) {
        const bestMatch = scoredMatches[0];
        const fieldSearchScore = bestMatch.record.fieldSearchScore || 0;
        const minScoreThreshold = calculateMinimumScoreThreshold(searchTerms.length, bestMatch.matchedTerms);
        
        if (fieldSearchScore >= 900 && bestMatch.score >= minScoreThreshold) {
            return bestMatch.record;
        }
        return null;
    }
    return null;
  }

  // Create arrays for the function call - only process names that need lookup
  const originalIngredientNames = parsedIngredients.map(parsed => parsed.originalString);
  const originalNamesNeedingLookup = [];
  const cleanedNamesNeedingLookup = [];
  
  // Create a mapping from original names to cleaned names
  const nameMapping = {};
  parsedIngredients.forEach(parsed => {
    nameMapping[parsed.originalString] = parsed.ingredient;
    
    // Only add to lookup arrays if it's not already a didTx
    if (!parsed.ingredient.startsWith('did:')) {
      originalNamesNeedingLookup.push(parsed.originalString);
      const normalizedName = parsed.ingredient.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
      cleanedNamesNeedingLookup.push(normalizedName);
    }
  });
  
  
  // Only call lookup function if there are names that need lookup
  let ingredientRecords = { ingredientDidRefs: {}, nutritionalInfo: [] };
  
  if (cleanedNamesNeedingLookup.length > 0) {
    updateProgress(jobId, 15, `Searching for ${cleanedNamesNeedingLookup.length} ingredients in database...`);
    ingredientRecords = await fetchIngredientRecordData(cleanedNamesNeedingLookup, originalNamesNeedingLookup);
  } else {
    console.log('No ingredients need lookup - all are already didTx values');
    updateProgress(jobId, 20, 'All ingredients already have DIDs, skipping lookup...');
  }
  let missingIngredientNames = Object.keys(ingredientRecords.ingredientDidRefs).filter(
    name => ingredientRecords.ingredientDidRefs[name] === null
  );
  
  console.log(`🔍 ${missingIngredientNames.length} ingredients need to be created via OpenAI`);
  
  if (missingIngredientNames.length > 0) {
    // ⚠️ BUG FIX: Removed second-pass fuzzy matching that was causing incorrect ingredient assignments
    // Previously, this code tried to find matches for missing ingredients a SECOND time,
    // which resulted in bad fuzzy matches like "mint leaves" → "flat-leaf parsley leaves" 
    // (both contain the word "leaves", so the scoring system matched them incorrectly).
    // If an ingredient is missing after the first search, it should go straight to OpenAI creation.
    
    // Create nutritional info records using CLEANED names, not original names
    updateProgress(jobId, 30, `Creating ${missingIngredientNames.length} new ingredient records via OpenAI...`);
    
    const nutritionalInfoArray = [];
    for (let i = 0; i < missingIngredientNames.length; i++) {
      const originalName = missingIngredientNames[i];
      const cleanedName = nameMapping[originalName];
      const progressPercent = 30 + Math.floor((i / missingIngredientNames.length) * 50); // 30-80%
      
      // Find the recipe unit for this ingredient
      const ingredientIndex = originalIngredientNames.findIndex(name => name === originalName);
      const recipeUnit = ingredientIndex >= 0 ? ingredientUnits[ingredientIndex] : '';
      
      updateProgress(jobId, progressPercent, `Creating ingredient ${i + 1} of ${missingIngredientNames.length}: ${cleanedName}...`);
      const result = await createNewNutritionalInfoRecord(cleanedName, blockchain, recipeUnit);
      nutritionalInfoArray.push(result);
    }
    
    console.log(`✅ Created ${nutritionalInfoArray.filter(r => r).length} new ingredient records`);

    // Update ingredientDidRefs with the newly created nutritional info records
    nutritionalInfoArray.forEach((newRecord, index) => {
      if (newRecord) {
        const originalName = missingIngredientNames[index];
        const cleanedName = nameMapping[originalName];
        ingredientRecords.ingredientDidRefs[originalName] = newRecord.oip?.did || `did:arweave:${newRecord.transactionId}`;
        ingredientRecords.nutritionalInfo.push({
          ingredientName: newRecord.data?.basic?.name || cleanedName,
          nutritionalInfo: newRecord.data?.nutritionalInfo || {},
          ingredientSource: newRecord.data?.basic?.webUrl || '',
          ingredientDidRef: newRecord.oip?.did || `did:arweave:${newRecord.transactionId}`
        });
      }
    });

    missingIngredientNames = missingIngredientNames.filter((name, index) => !nutritionalInfoArray[index]);
  }

    // console.log('Ingredient DID References:', ingredientRecords.ingredientDidRefs);
    // now we want to look up the record.oip.didTx value from the top ranked record for each ingredient and assign it to ingredientDidRef, we may need to add pagination (there are 20 records limit per page by default) to check all returned records
    
    
    


    // now filter each one by the ingredientName matching against this json structure: data: { basic: { name: ,and get the nutritional info
    // for each ingredient, if it exists
    // const nutritionalInfo = records.map(record => {
    //   const ingredientName = record.data.basic.name;
    //   const nutritionalInfo = record.data.nutritionalInfo || {}; // Ensure it's an object, not undefined
    //   const ingredientSource = record.data.basic.webUrl;
    //   const ingredientDidRef = ingredientDidRefs[ingredientName.toLowerCase()] || null; // Ensure case-insensitive lookup
    //   return {
    //     ingredientName,
    //     nutritionalInfo,
    //     ingredientSource,
    //     ingredientDidRef
    //   };
    // });

    // console.log('Nutritional info:', nutritionalInfo);


    // Extract prep time, cook time, total time, cuisine, and course directly from recipe object
    const prep_time_mins = record.recipe.prep_time_mins || null;
    const cook_time_mins = record.recipe.cook_time_mins || null;
    const total_time_mins = record.recipe.total_time_mins || null;
    const servings = record.recipe.servings || null;
    const cuisine = record.recipe.cuisine || null;
    const course = record.recipe.course || null;
    const notes = record.recipe.notes || null;

    console.log('Missing Ingredients:', missingIngredientNames);
    console.log('Original Ingredient Names:', originalIngredientNames);
    console.log('Names needing lookup:', cleanedNamesNeedingLookup);
    console.log('Units Before Assignment:', ingredientUnits);
    console.log('Amounts Before Assignment:', ingredientAmounts);
    console.log('Ingredient Did Refs:', ingredientRecords);

  // This section is now redundant since we handled the unit processing above
  // The logic has been moved to the previous section to use proper name mapping

// Build final ingredientDRefs array
let ingredientDRefs = originalIngredientNames.map(originalName => {
  return ingredientDidTxMap[originalName] || ingredientRecords.ingredientDidRefs[originalName] || null;
});

console.log(`📊 Final ingredient DIDs: ${ingredientDRefs.filter(d => d).length}/${ingredientDRefs.length} resolved`);

// Extract values from the first recipe section for the main recipe data
const recipeDate = record.basic.date || Math.floor(Date.now() / 1000);

// Assign to recipeData
const recipeData = {
  basic: {
    name: record.basic.name,
    language: record.basic.language || "En",
    date: recipeDate,
    description: record.basic.description,
    webUrl: record.basic.webUrl,
    nsfw: record.basic.nsfw || false,
    tagItems: record.basic.tagItems || [],
    avatar: record.basic.avatar || undefined  // Preserve the avatar DID (image reference)
  },
  recipe: {
    prep_time_mins: record.recipe.prep_time_mins,
    cook_time_mins: record.recipe.cook_time_mins,
    total_time_mins: record.recipe.total_time_mins,
    servings: record.recipe.servings,
    ingredient_amount: ingredientAmounts.length ? ingredientAmounts : null,
    ingredient_unit: ingredientUnits.length ? ingredientUnits : null,
    ingredient: ingredientDRefs,
    ingredient_comment: ingredientComments.length ? ingredientComments : null,
    instructions: record.recipe.instructions,
    notes: record.recipe.notes,
    cuisine: record.basic.cuisine || record.recipe.cuisine || '',
    course: record.basic.course || record.recipe.course || '',
    author: record.recipe.author || ''
  }
};

// Filter out null ingredients if any
const hasNulls = ingredientDRefs.some(ref => ref === null);
if (hasNulls) {
  const validIndices = ingredientDRefs.map((ref, index) => ref !== null ? index : null).filter(index => index !== null);
  ingredientDRefs = validIndices.map(index => ingredientDRefs[index]);
  ingredientComments = validIndices.map(index => ingredientComments[index]);
  ingredientAmounts = validIndices.map(index => ingredientAmounts[index]);
  ingredientUnits = validIndices.map(index => ingredientUnits[index]);
  console.log(`⚠️ Filtered out ${originalIngredientNames.length - ingredientDRefs.length} null ingredients`);
}

console.log(`✅ Recipe ready: ${ingredientDRefs.length} ingredients with DIDs`);

// ====== INTELLIGENT INGREDIENT RESOLUTION ======
// If recipe has ingredient names (not all DIDs) and no pre-calculated nutrition, resolve them intelligently
const hasIngredientNames = recipeData.recipe.ingredient.some(ing => 
  typeof ing === 'string' && !ing.startsWith('did:')
);
const hasNoNutrition = !record.summaryNutritionalInfoPerServing || 
  Object.keys(record.summaryNutritionalInfoPerServing).length === 0;

if (hasIngredientNames && hasNoNutrition) {
  console.log('\n🤖 Intelligent Ingredient Resolution: Detected ingredient names without nutritional summary');
  console.log('   Resolving ingredients, fixing standard units, and calculating nutrition...');
  
  try {
    // Step 1: Resolve all ingredients (search existing, fetch from Nutritionix, fix standard units)
    const resolvedIngredients = await resolveRecipeIngredients(
      recipeData.recipe.ingredient,
      recipeData.recipe.ingredient_amount,
      recipeData.recipe.ingredient_unit,
      req.user.publicKey
    );
    
    console.log(`\n✅ Resolved ${resolvedIngredients.length} ingredients`);
    
    // Step 2: Publish any new ingredients
    const newIngredientDIDs = [];
    for (const resolved of resolvedIngredients) {
      if (resolved.isNew && resolved.data) {
        console.log(`\n📝 Publishing new ingredient: ${resolved.name}`);
        
        try {
          // Publish the new nutritionalInfo record
          const publishResult = await publishNewRecord(
            'nutritionalInfo',
            resolved.data,
            req.user.publicKey,
            req.user.privateKey,
            'arweave'
          );
          
          if (publishResult && publishResult.didTx) {
            resolved.did = publishResult.didTx;
            newIngredientDIDs.push(publishResult.didTx);
            console.log(`   ✅ Published new ingredient with DID: ${publishResult.didTx}`);
          } else {
            console.error(`   ❌ Failed to get DID for new ingredient: ${resolved.name}`);
          }
        } catch (publishError) {
          console.error(`   ❌ Failed to publish new ingredient ${resolved.name}:`, publishError.message);
        }
      }
    }
    
    if (newIngredientDIDs.length > 0) {
      console.log(`\n✅ Published ${newIngredientDIDs.length} new ingredients`);
    }
    
    // Step 3: Update recipeData with resolved DIDs
    recipeData.recipe.ingredient = resolvedIngredients.map(r => r.did || r.ingredientRef);
    
    // Step 4: Calculate nutritional summary using the backend calculation function
    console.log('\n🧮 Calculating nutritional summary with resolved ingredients...');
    
    const ingredientsForCalc = resolvedIngredients.map(r => ({
      did: r.did,
      amount: r.amount,
      unit: r.unit,
      name: r.name,
      nutritionalInfo: r.data?.nutritionalInfo
    }));
    
    const servings = recipeData.recipe.servings || 1;
    const nutritionResult = await calculateRecipeNutrition(ingredientsForCalc, servings);
    
    if (nutritionResult && nutritionResult.perServing) {
      recipeData.summaryNutritionalInfoPerServing = nutritionResult.perServing;
      console.log('✅ Nutritional summary calculated via intelligent resolution:');
      console.log(`   Per serving: ${nutritionResult.perServing.calories} cal, ${nutritionResult.perServing.proteinG}g protein`);
      console.log(`   Processed ${nutritionResult.processedIngredients}/${nutritionResult.totalIngredients} ingredients`);
      
      if (nutritionResult.skippedIngredients && nutritionResult.skippedIngredients.length > 0) {
        console.warn('   ⚠️ Skipped ingredients:');
        nutritionResult.skippedIngredients.forEach(skip => {
          console.warn(`      - ${skip.name}: ${skip.reason}`);
        });
      }
    } else {
      console.log('⚠️ Unable to calculate nutritional summary (insufficient ingredient data)');
    }
    
  } catch (resolutionError) {
    console.error('❌ Error during intelligent ingredient resolution:', resolutionError);
    console.log('   Falling back to standard processing...');
    // Continue with normal processing
  }
}
// ====== END INTELLIGENT INGREDIENT RESOLUTION ======

        updateProgress(jobId, 82, 'Calculating nutritional summary...');
        
// Calculate nutritional summaries before publishing (unless already provided or calculated above)
// Check if summaryNutritionalInfoPerServing was already included in the request OR calculated via intelligent resolution
if (recipeData.summaryNutritionalInfoPerServing && Object.keys(recipeData.summaryNutritionalInfoPerServing).length > 0) {
  console.log('✅ Using summaryNutritionalInfoPerServing (already calculated)');
} else if (record.summaryNutritionalInfoPerServing && Object.keys(record.summaryNutritionalInfoPerServing).length > 0) {
  console.log('✅ Using pre-calculated summaryNutritionalInfoPerServing from request:');
  console.log(`   Per serving: ${record.summaryNutritionalInfoPerServing.calories} cal, ${record.summaryNutritionalInfoPerServing.proteinG}g protein`);
  recipeData.summaryNutritionalInfoPerServing = record.summaryNutritionalInfoPerServing;
} else {
  // Calculate nutritional summaries
  try {
    console.log('Calculating nutritional summary for recipe...');
    
    // Build ingredients array with nutritional data for calculation
    // This includes both existing records from DB and newly created ones
    const ingredientsWithNutrition = [];
    
    for (let i = 0; i < ingredientDRefs.length; i++) {
      const did = ingredientDRefs[i];
      const amount = ingredientAmounts[i];
      const unit = ingredientUnits[i];
      const comment = ingredientComments[i] || '';
      
      // Try to find nutritionalInfo from the ingredientRecords (newly created)
      let nutritionalInfo = null;
      let name = `ingredient ${i}`;
      
      const matchingInfo = ingredientRecords.nutritionalInfo.find(info => info.ingredientDidRef === did);
      if (matchingInfo) {
        nutritionalInfo = matchingInfo.nutritionalInfo;
        name = matchingInfo.ingredientName;
      }
      
      ingredientsWithNutrition.push({
        did,
        amount,
        unit,
        comment,
        name,
        nutritionalInfo // Will be null if not found in newly created list
      });
    }
    
    console.log(`🧮 Calculating nutrition for ${ingredientsWithNutrition.length} ingredients (${ingredientsWithNutrition.filter(i => i.nutritionalInfo).length} have nutritionalInfo in memory)`);
    
    // Fetch records from database for any ingredients we don't have in memory
    const recordsResult = await getRecords({ 
      recordType: 'nutritionalInfo',
      limit: 5000
    });
    const recordsInDB = (recordsResult.records || []).filter(record => {
      return record.data?.nutritionalInfo && Object.keys(record.data.nutritionalInfo).length > 0;
    });
    
    console.log(`📚 Database has ${recordsInDB.length} nutritional info records for lookup`);
    
    // Calculate using the shared function
    const servings = recipeData.recipe.servings || 1;
    const nutritionResult = await calculateRecipeNutrition(ingredientsWithNutrition, servings, recordsInDB);
    
    if (nutritionResult && nutritionResult.perServing && nutritionResult.processedIngredients > 0) {
      recipeData.summaryNutritionalInfoPerServing = nutritionResult.perServing;
      console.log(`✅ Nutritional summary calculated: ${nutritionResult.processedIngredients}/${nutritionResult.totalIngredients} ingredients → ${nutritionResult.perServing.calories} cal/serving`);
      
      if (nutritionResult.skippedIngredients && nutritionResult.skippedIngredients.length > 0) {
        console.log(`⏭️ Skipped ${nutritionResult.skippedIngredients.length}: ${nutritionResult.skippedIngredients.map(s => s.name).join(', ')}`);
      }
    } else {
      console.log('⚠️ Unable to calculate nutritional summary (insufficient ingredient data)');
    }
    
  } catch (nutritionError) {
    console.error('Error calculating nutritional summary (continuing with publish):', nutritionError);
    // Don't fail the publish if nutrition calculation fails
  }
}

        updateProgress(jobId, 90, 'Publishing recipe to blockchain...');
        
        try {
          console.log('Attempting to publish recipe...');
          recipeRecord = await publishNewRecord(recipeData, "recipe", false, false, false, null, blockchain);
          console.log('Recipe published successfully:', recipeRecord.transactionId);
        } catch (publishError) {
          console.error('Error publishing recipe:', publishError);
          console.error('Recipe data that failed to publish:', JSON.stringify(recipeData, null, 2));
          throw publishError;
        }

        const transactionId = recipeRecord.transactionId;
        const recordToIndex = recipeRecord.recordToIndex;
        
        // Mark job as completed
        completeJob(jobId, {
          transactionId,
          recordToIndex,
          blockchain
        });
        
        console.log(`✅ Recipe publish job ${jobId} completed successfully`);
        
    } catch (error) {
        console.error('Error in async recipe processing:', error);
        failJob(jobId, error);
    }
}

// Add workout publishing endpoint
router.post('/newWorkout', async (req, res) => {
    try {
        console.log('POST /api/publish/newWorkout', req.body);
        const record = req.body;
        const blockchain = req.body.blockchain || 'arweave';
        const nonStandardWorkout = req.body.workout?.nonStandardWorkout !== undefined 
            ? req.body.workout.nonStandardWorkout 
            : false; // Default to false (don't create new exercises)
        let recordType = 'workout';

        // Resolve drefs to handle nested exercise structures
        // If nonStandardWorkout is true, new exercise records will be created for missing exercises
        // If nonStandardWorkout is false (or omitted), missing exercises will be skipped
        let resolvedWorkout = await resolveDrefsInRecord(
            req.body, 
            'workout', 
            {exercise: 'exercise'}, 
            blockchain,
            { nonStandardWorkout }
        );

        if (!resolvedWorkout.workout.total_duration_minutes) {
          let total = 0;
          const exercises = Array.isArray(resolvedWorkout.workout.exercise) ? resolvedWorkout.workout.exercise : [];
          for (const exDid of exercises) {
            if (typeof exDid === 'string' && exDid.startsWith('did:')) {
              const exResults = await getRecords({ didTx: exDid, recordType: 'exercise', sortBy: 'inArweaveBlock:desc', limit: 1 });
              if (exResults.searchResults > 0) {
                const exRecord = exResults.records[0];
                total += exRecord.data.exercise.est_duration_minutes || 0;
              }
            }
          }
          // Add 2 minutes between each exercise (exercises.length - 1 transitions)
          if (exercises.length > 1) {
            total += (exercises.length - 1) * 2;
          }
          resolvedWorkout.workout.total_duration_minutes = total;
        }

        const workoutData = {
          basic: {
            name: resolvedWorkout.basic?.name || '',
            language: resolvedWorkout.basic?.language || 'en',
            date: resolvedWorkout.basic?.date || Math.floor(Date.now() / 1000),
            description: resolvedWorkout.basic?.description || '',
            webUrl: resolvedWorkout.basic?.webUrl || '',
            nsfw: resolvedWorkout.basic?.nsfw || false,
            tagItems: resolvedWorkout.workout?.goalTags || [],
          },
          workout: {
            total_duration_minutes: resolvedWorkout.workout?.total_duration_minutes || 0,
            estimated_calories_burned: resolvedWorkout.workout?.estimated_calories_burned || 0,
            includesWarmup: resolvedWorkout.workout?.includesWarmup || false,
            includesMain: resolvedWorkout.workout?.includesMain || false,
            includesCooldown: resolvedWorkout.workout?.includesCooldown || false,
            nonStandardWorkout: nonStandardWorkout,
            exercise_amount: resolvedWorkout.workout?.exercise_amount || [],
            exercise_unit: resolvedWorkout.workout?.exercise_unit || [],
            exercise: resolvedWorkout.workout?.exercise || [],
            exercise_comment: resolvedWorkout.workout?.exercise_comment || [],
            instructions: resolvedWorkout.workout?.instructions || '',
            // goalTags: resolvedWorkout.workout?.goalTags || [],
            author: resolvedWorkout.workout?.author || '',
            authorDRef: resolvedWorkout.workout?.authorDRef || null,
            notes: resolvedWorkout.workout?.notes || ''
        //   },
        //   image: {
        //     webUrl: resolvedWorkout.image?.webUrl || '',
        //     contentType: resolvedWorkout.image?.contentType || ''
          }
        };

        const workoutRecord = await publishNewRecord(workoutData, "workout", false, false, false, null, blockchain);

        const transactionId = workoutRecord.transactionId;
        const recordToIndex = workoutRecord.recordToIndex;

        res.status(200).json({ 
            transactionId, 
            recordToIndex, 
            blockchain,
            message: `Workout published successfully${!nonStandardWorkout ? ' with exercise references' : ' as non-standard workout'}`
        });

    } catch (error) {
        console.error('Error publishing workout:', error);
        res.status(500).json({ error: 'Failed to publish workout' });
    }
});

// Function to find best exercise match (similar to ingredient matching)
function findBestExerciseMatch(exerciseName, exerciseRecordMap) {
    if (!exerciseRecordMap || Object.keys(exerciseRecordMap).length === 0) {
        return null;
    }

    const searchTerms = exerciseName.split(/\s+/).filter(Boolean);
    console.log(`Searching for exercise: ${exerciseName}, Search terms:`, searchTerms);

    // Direct match
    if (exerciseRecordMap[exerciseName]) {
        console.log(`Direct match found for ${exerciseName}`);
        return exerciseRecordMap[exerciseName];
    }

    // Looser match using search terms
    const matches = Object.keys(exerciseRecordMap)
        .filter(recordName => {
            const normalizedRecordName = recordName.toLowerCase();
            return searchTerms.some(term => normalizedRecordName.includes(term));
        })
        .map(recordName => exerciseRecordMap[recordName]);

    if (matches.length > 0) {
        matches.sort((a, b) => {
            const aMatchCount = searchTerms.filter(term => a.data.basic.name.toLowerCase().includes(term)).length;
            const bMatchCount = searchTerms.filter(term => b.data.basic.name.toLowerCase().includes(term)).length;
            return bMatchCount - aMatchCount;
        });

        console.log(`Loose matches found for ${exerciseName}:`, matches.length);
        return matches[0];
    }

    console.log(`No match found for ${exerciseName}`);
    return null;
}

// Add specific video record endpoint with YouTube support
router.post('/newVideo', authenticateToken, async (req, res) => {
    try {
        const {
            youtubeUrl,
            videoUrl, // Direct video URL
            videoFile, // Base64 encoded video
            basicMetadata,
            blockchain = 'arweave',
            publishTo = { arweave: true, bittorrent: true }
        } = req.body;

        // Extract media publishing flags from query params or body
        const publishFiles = req.query.publishFiles !== 'false' && req.body.publishFiles !== false; // Default to true for video endpoint
        const addMediaToArweave = req.query.addMediaToArweave !== 'false' && publishTo.arweave !== false;
        const addMediaToIPFS = req.query.addMediaToIPFS === 'true' || publishTo.ipfs === true;
        const addMediaToArFleet = req.query.addMediaToArFleet === 'true' || publishTo.arfleet === true;

        // Create video record structure
        const videoRecord = {
            basic: {
                name: basicMetadata?.name || 'Video Record',
                description: basicMetadata?.description || '',
                language: basicMetadata?.language || 'en',
                date: Math.floor(Date.now() / 1000),
                nsfw: basicMetadata?.nsfw || false,
                tagItems: basicMetadata?.tagItems || []
            },
            video: {}
        };

        // Add video URL to record structure
        if (youtubeUrl) {
            videoRecord.video.webUrl = youtubeUrl;
            videoRecord.video.contentType = 'video/mp4';
        } else if (videoUrl) {
            videoRecord.video.webUrl = videoUrl;
            videoRecord.video.contentType = 'video/mp4';
        }

        // Publish the record with media processing
        const result = await publishNewRecord(
            videoRecord,
            'video',
            publishFiles,
            addMediaToArweave,
            addMediaToIPFS,
            youtubeUrl, // Pass YouTube URL for special processing
            blockchain,
            addMediaToArFleet
        );

        res.status(200).json({
            success: true,
            transactionId: result.transactionId,
            recordToIndex: result.recordToIndex,
            blockchain: blockchain,
            message: 'Video record published successfully'
        });

    } catch (error) {
        console.error('Error publishing video record:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to publish video record',
            details: error.message 
        });
    }
});

// Add specific image record endpoint
router.post('/newImage', authenticateToken, async (req, res) => {
    try {
        const {
            imageUrl, // Direct image URL
            imageFile, // Base64 encoded image
            basicMetadata,
            blockchain = 'arweave',
            publishTo = { arweave: true, bittorrent: true }
        } = req.body;

        // Extract media publishing flags from query params or body
        const publishFiles = req.query.publishFiles !== 'false' && req.body.publishFiles !== false; // Default to true for image endpoint
        const addMediaToArweave = req.query.addMediaToArweave !== 'false' && publishTo.arweave !== false;
        const addMediaToIPFS = req.query.addMediaToIPFS === 'true' || publishTo.ipfs === true;
        const addMediaToArFleet = req.query.addMediaToArFleet === 'true' || publishTo.arfleet === true;

        if (!imageUrl && !imageFile) {
            return res.status(400).json({
                success: false,
                error: 'Either imageUrl or imageFile must be provided'
            });
        }

        // Create image record structure
        const imageRecord = {
            basic: {
                name: basicMetadata?.name || 'Image Record',
                description: basicMetadata?.description || '',
                language: basicMetadata?.language || 'en',
                date: Math.floor(Date.now() / 1000),
                nsfw: basicMetadata?.nsfw || false,
                tagItems: basicMetadata?.tagItems || []
            },
            image: {}
        };

        // Add image URL or file to record structure
        if (imageUrl) {
            imageRecord.image.webUrl = imageUrl;
            imageRecord.image.contentType = 'image/jpeg'; // Default, will be detected from URL
        }

        // Publish the record with media processing
        const result = await publishNewRecord(
            imageRecord,
            'image',
            publishFiles,
            addMediaToArweave,
            addMediaToIPFS,
            null, // No YouTube URL for images
            blockchain,
            addMediaToArFleet
        );

        res.status(200).json({
            success: true,
            transactionId: result.transactionId,
            recordToIndex: result.recordToIndex,
            blockchain: blockchain,
            message: 'Image record published successfully'
        });

    } catch (error) {
        console.error('Error publishing image record:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to publish image record',
            details: error.message 
        });
    }
});

// // Add a new general media publishing endpoint
// router.post('/newMedia', authenticateToken, async (req, res) => {
//     try {
//         const {
//             mediaFile, // Base64 encoded file
//             mediaUrl, // Direct URL to media
//             youtubeUrl, // YouTube URL (for videos)
//             contentType, // MIME type
//             basicMetadata, // Title, description, etc.
//             blockchain = 'arweave', // Default to arweave
//             publishTo = { arweave: true, bittorrent: true } // Media publishing options
//         } = req.body;

//         let mediaConfig = {
//             publishTo: publishTo,
//             blockchain: blockchain,
//             contentType: contentType
//         };

//         // Determine media source
//         if (youtubeUrl) {
//             mediaConfig.source = 'youtube';
//             mediaConfig.data = youtubeUrl;
//             mediaConfig.contentType = 'video/mp4';
//         } else if (mediaUrl) {
//             mediaConfig.source = 'url';
//             mediaConfig.data = mediaUrl;
//         } else if (mediaFile) {
//             mediaConfig.source = 'base64';
//             mediaConfig.data = mediaFile;
//         } else {
//             return res.status(400).json({ error: 'No media source provided' });
//         }

//         // Process the media
//         const mediaDIDs = await mediaManager.processMedia(mediaConfig);

//         // Create record with media DIDs
//         const record = {
//             basic: {
//                 ...basicMetadata,
//                 createdAt: new Date().toISOString(),
//             },
//             media: {
//                 storageNetworks: mediaDIDs.storageNetworks,
//                 originalUrl: youtubeUrl || mediaUrl,
//                 contentType: contentType
//             }
//         };

//         const newRecord = await publishNewRecord(record, 'media', false, false, false, null, blockchain);
        
//         res.json({
//             status: 'success',
//             blockchain: blockchain,
//             transactionId: newRecord.transactionId,
//             data: {
//                 contentId: newRecord.didTx,
//                 mediaDIDs: mediaDIDs
//             }
//         });

//     } catch (error) {
//         console.error('Error publishing media:', error);
//         res.status(500).json({
//             error: 'Failed to publish media',
//             details: error.message
//         });
//     }
// });

// Add template publishing endpoint
router.post('/newTemplate', authenticateToken, async (req, res) => {
    try {
        const rawTemplate = req.body.template || req.body;
        const blockchain = req.body.blockchain || 'arweave'; // Default to arweave
        const sectionName = Object.keys(rawTemplate)[0];
        let currentIndex = 0;
        const processedTemplate = {};
        processedTemplate[sectionName] = {};

        // Process each field in the section
        Object.entries(rawTemplate[sectionName]).forEach(([fieldName, fieldType]) => {
            // Skip if this is a values array - we'll handle it with its enum
            if (fieldName.endsWith('Values')) return;

            // Add the field type
            processedTemplate[sectionName][fieldName] = fieldType;

            // Add index for the field
            processedTemplate[sectionName][`index_${fieldName}`] = currentIndex++;

            // If this is an enum field, add its values array if provided
            if (fieldType === 'enum') {
                const valuesKey = `${fieldName}Values`;
                if (rawTemplate[sectionName][valuesKey]) {
                    processedTemplate[sectionName][valuesKey] = rawTemplate[sectionName][valuesKey];
                }
            }
        });

        // Upload template to blockchain using publisher manager
        const templateBuffer = Buffer.from(JSON.stringify(processedTemplate));
        const uploadResult = await publisherManager.publish(
            templateBuffer,
            {
                blockchain: blockchain,
                tags: [
                    { name: 'Content-Type', value: 'application/json' },
                    { name: 'Type', value: 'Template' },
                    { name: 'App-Name', value: 'OIPArweave' }
                ]
            }
        );

        // Create the DID
        const templateDid = `did:arweave:${uploadResult.id}`;

        // Store template info in Elasticsearch
        await client.index({
            index: 'templates',
            id: templateDid,
            body: {
                templateId: templateDid,
                name: sectionName,
                type: 'template',
                txid: uploadResult.id
            }
        });

        res.json({
            status: 'success',
            blockchain: blockchain,
            data: {
                templateId: templateDid,
                txid: uploadResult.id,
                template: processedTemplate // Include processed template for verification
            }
        });

    } catch (error) {
        console.error('Error publishing template:', error);
        res.status(500).json({
            error: 'Failed to publish template',
            details: error.message
        });
    }
});

router.post('/testEncrypt', async (req, res) => {
    try {
        const { content } = req.body;
        
        // Use the test condition for simplicity
        const testCondition = createTestCondition();
        
        // Test encryption with minimal payload
        const { encryptedContent, encryptedSymmetricKey } = await encryptContent(
            content || "Test content for encryption",
            testCondition
        );
        
        res.json({
            success: true,
            encryptedContent,
            encryptedSymmetricKey,
            accessControlConditions: testCondition
        });
    } catch (error) {
        console.error('Error in test encryption:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error
        });
    }
});

// Add nutritionalInfo schema endpoint
router.get('/newNutritionalInfo/schema', (req, res) => {
    try {
        const nutritionalInfoSchema = {
            "description": "Complete JSON schema for publishing nutritional info via POST /api/publish/newNutritionalInfo",
            "example": {
                "data": {
                    "basic": {
                        "name": "raw, grass-fed sharp cheddar cheese",
                        "date": 1752015668,
                        "language": "en",
                        "nsfw": false,
                        "webUrl": "https://www.nutritionix.com/food/raw,-grass-fed-sharp-cheddar-cheese"
                    },
                    "nutritionalInfo": {
                        "standardAmount": 1,
                        "standardUnit": "slice (1 oz)",
                        "calories": 114.8,
                        "proteinG": 6.79,
                        "fatG": 9.47,
                        "saturatedFatG": 5.42,
                        "transFatG": 0,
                        "cholesterolMg": 27.72,
                        "sodiumMg": 180.32,
                        "carbohydratesG": 0.6,
                        "dietaryFiberG": 0,
                        "sugarsG": 0.08,
                        "addedSugarsG": 0,
                        "vitaminDMcg": 0,
                        "calciumMg": 0,
                        "ironMg": 0,
                        "potassiumMg": 21.28,
                        "vitaminAMcg": 0,
                        "vitaminCMg": 0,
                        "allergens": [],
                        "glutenFree": false,
                        "organic": false
                    },
                    "image": {
                        "webUrl": "https://nix-tag-images.s3.amazonaws.com/2203_thumb.jpg",
                        "contentType": "image/jpeg"
                    }
                },
                "blockchain": "arweave"
            },
            "field_descriptions": {
                "basic.name": "Food item name (required)",
                "basic.date": "Unix timestamp (default: current time)",
                "basic.language": "Language code (default: 'en')",
                "basic.nsfw": "Boolean for adult content (default: false)",
                "basic.webUrl": "Optional source URL",
                "nutritionalInfo.standardAmount": "Standard serving amount (default: 1)",
                "nutritionalInfo.standardUnit": "Standard serving unit (default: 'unit')",
                "nutritionalInfo.calories": "Calories per serving",
                "nutritionalInfo.proteinG": "Protein in grams",
                "nutritionalInfo.fatG": "Total fat in grams",
                "nutritionalInfo.saturatedFatG": "Saturated fat in grams",
                "nutritionalInfo.transFatG": "Trans fat in grams",
                "nutritionalInfo.cholesterolMg": "Cholesterol in milligrams",
                "nutritionalInfo.sodiumMg": "Sodium in milligrams",
                "nutritionalInfo.carbohydratesG": "Total carbohydrates in grams",
                "nutritionalInfo.dietaryFiberG": "Dietary fiber in grams",
                "nutritionalInfo.sugarsG": "Total sugars in grams",
                "nutritionalInfo.addedSugarsG": "Added sugars in grams",
                "nutritionalInfo.vitaminDMcg": "Vitamin D in micrograms",
                "nutritionalInfo.calciumMg": "Calcium in milligrams",
                "nutritionalInfo.ironMg": "Iron in milligrams",
                "nutritionalInfo.potassiumMg": "Potassium in milligrams",
                "nutritionalInfo.vitaminAMcg": "Vitamin A in micrograms",
                "nutritionalInfo.vitaminCMg": "Vitamin C in milligrams",
                "nutritionalInfo.allergens": "Array of allergen strings",
                "nutritionalInfo.glutenFree": "Boolean indicating if gluten-free",
                "nutritionalInfo.organic": "Boolean indicating if organic",
                "image.webUrl": "URL to food image",
                "image.contentType": "Image MIME type",
                "blockchain": "Target blockchain ('arweave' or 'turbo')"
            }
        };

        res.status(200).json(nutritionalInfoSchema);
    } catch (error) {
        console.error('Error generating nutritional info schema:', error);
        res.status(500).json({ error: 'Failed to generate nutritional info schema' });
    }
});

// Helper functions for dynamic schema generation
function generateExampleDataByType(fieldType, fieldName, enumValues = null) {
    switch (fieldType) {
        case 'string':
            // Template-specific naming
            if (fieldName === 'name') {
                // Context-aware naming based on likely template type
                return 'Sample Content';
            }
            if (fieldName === 'description') return 'A sample description demonstrating the template structure';
            if (fieldName === 'language') return 'en';
            if (fieldName === 'webUrl') return 'https://example.com/content';
            
            // Image-specific fields
            if (fieldName === 'imageUrl') return 'https://example.com/image.jpg';
            if (fieldName === 'contentType') return 'image/jpeg';
            if (fieldName === 'altText') return 'Sample image description';
            if (fieldName === 'caption') return 'Sample image caption';
            
            // Video-specific fields
            if (fieldName === 'videoUrl') return 'https://example.com/video.mp4';
            if (fieldName === 'youtubeUrl') return 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
            if (fieldName === 'duration') return '00:03:45';
            if (fieldName === 'resolution') return '1920x1080';
            
            // Post-specific fields
            if (fieldName === 'articleText') return 'This is sample article content demonstrating the post template structure...';
            if (fieldName === 'bylineWriter') return 'Sample Author';
            if (fieldName === 'bylineWritersTitle') return 'Content Creator';
            if (fieldName === 'bylineWritersLocation') return 'Sample Location';
            
            // Text-specific fields
            if (fieldName === 'textContent') return 'Sample text content for the document...';
            if (fieldName === 'textFormat') return 'markdown';
            
            // Audio/Podcast fields
            if (fieldName === 'audioUrl') return 'https://example.com/audio.mp3';
            if (fieldName === 'showName') return 'Weekly Tech Talk';
            if (fieldName === 'episodeNumber') return '42';
            if (fieldName === 'seasonNumber') return '2';
            if (fieldName === 'hostName') return 'John Smith';
            
            // Recipe fields
            if (fieldName === 'instructions') return 'Step-by-step cooking instructions...';
            if (fieldName === 'cuisine') return 'Mediterranean';
            if (fieldName === 'course') return 'Main Course';
            if (fieldName === 'author') return 'Chef Example';
            if (fieldName === 'notes') return 'Additional cooking tips and notes...';
            
            // Workout/Exercise fields
            if (fieldName === 'muscleGroups') return 'Chest, Shoulders, Triceps';
            if (fieldName === 'difficulty') return 'Intermediate';
            if (fieldName === 'category') return 'Strength Training';
            if (fieldName === 'equipment') return 'Dumbbells, Bench';
            if (fieldName === 'goalTags') return 'Muscle Building, Strength';
            
            // Fitness fields
            if (fieldName === 'fitnessLevel') return 'Intermediate';
            if (fieldName === 'primaryGoal') return 'Weight Loss';
            if (fieldName === 'preferredWorkoutTime') return 'Morning';
            if (fieldName === 'availableEquipment') return 'Home Gym Setup';
            
            // Organization fields
            if (fieldName === 'organizationName') return 'Fitness First Gym';
            if (fieldName === 'address') return '123 Main St, City, State';
            if (fieldName === 'phoneNumber') return '+1-555-0123';
            if (fieldName === 'email') return 'contact@example.com';
            if (fieldName === 'website') return 'https://example.com';
            
            // Model Provider fields
            if (fieldName === 'providerName') return 'OpenAI';
            if (fieldName === 'modelName') return 'GPT-4';
            if (fieldName === 'apiEndpoint') return 'https://api.openai.com/v1';
            if (fieldName === 'version') return '1.0.0';
            
            // Shopping List fields
            if (fieldName === 'storeName') return 'Whole Foods Market';
            if (fieldName === 'category') return 'Produce';
            if (fieldName === 'brand') return 'Organic Valley';
            
            // Document fields
            if (fieldName === 'documentType') return 'Analysis Report';
            if (fieldName === 'pageNumber') return '1';
            if (fieldName === 'classification') return 'Declassified';
            
            return `Sample ${fieldName}`;
        
        case 'long':
        case 'uint64':
            if (fieldName === 'date') return Math.floor(Date.now() / 1000);
            if (fieldName === 'fileSize') return 1024000; // 1MB
            if (fieldName === 'width') return 1920;
            if (fieldName === 'height') return 1080;
            if (fieldName === 'duration') return 225; // 3:45 in seconds
            if (fieldName === 'views') return 1000;
            if (fieldName === 'calories') return 300;
            if (fieldName === 'servings') return 4;
            if (fieldName === 'prep_time_mins') return 15;
            if (fieldName === 'cook_time_mins') return 30;
            if (fieldName === 'total_time_mins') return 45;
            if (fieldName === 'total_duration_minutes') return 45;
            if (fieldName === 'estimated_calories_burned') return 300;
            if (fieldName === 'recommended_sets') return 3;
            if (fieldName === 'recommended_reps') return 12;
            if (fieldName === 'target_duration_seconds') return 30;
            if (fieldName === 'weight_lbs') return 150;
            if (fieldName === 'height_inches') return 68;
            if (fieldName === 'age') return 30;
            if (fieldName === 'experience_years') return 2;
            if (fieldName === 'price_cents') return 1999; // $19.99
            if (fieldName === 'quantity') return 2;
            if (fieldName === 'pageCount') return 25;
            return 12345;
        
        case 'enum':
            if (enumValues && enumValues.length > 0) {
                // Handle both array of strings and array of objects with 'name' property
                if (typeof enumValues[0] === 'string') {
                    return enumValues[0];
                } else if (enumValues[0].name) {
                    return enumValues[0].name;
                } else if (enumValues[0].code) {
                    return enumValues[0].code;
                }
            }
            // Field-specific enum defaults
            if (fieldName === 'quality') return 'HD';
            if (fieldName === 'format') return 'MP4';
            if (fieldName === 'category') return 'general';
            if (fieldName === 'difficulty') return 'intermediate';
            if (fieldName === 'exercise_type') return 'main';
            if (fieldName === 'measurement_type') return 'reps';
            if (fieldName === 'gender') return 'other';
            if (fieldName === 'unit') return 'lbs';
            if (fieldName === 'access_level') return 'private';
            if (fieldName === 'status') return 'active';
            return 'option1';
        
        case 'bool':
            if (fieldName === 'nsfw') return false;
            if (fieldName === 'isPublic') return true;
            if (fieldName === 'featured') return false;
            if (fieldName === 'isBodyweight') return true;
            if (fieldName === 'includesWarmup') return true;
            if (fieldName === 'includesMain') return true;
            if (fieldName === 'includesCooldown') return true;
            if (fieldName === 'nonStandardWorkout') return false;
            if (fieldName === 'glutenFree') return false;
            if (fieldName === 'organic') return true;
            if (fieldName === 'isActive') return true;
            if (fieldName === 'isCompleted') return false;
            if (fieldName === 'isPublished') return true;
            return false;
        
        case 'float':
            if (fieldName === 'aspectRatio') return 1.777; // 16:9
            if (fieldName === 'rating') return 4.5;
            if (fieldName === 'weight') return 150.5;
            if (fieldName === 'bodyFat') return 15.2;
            if (fieldName === 'price') return 19.99;
            if (fieldName === 'standardAmount') return 1.0;
            if (fieldName === 'proteinG') return 25.5;
            if (fieldName === 'fatG') return 8.2;
            if (fieldName === 'carbohydratesG') return 12.3;
            return 0.0;
        
        case 'dref':
            if (fieldName === 'featuredImage') return 'did:arweave:img123...';
            if (fieldName === 'thumbnail') return 'did:arweave:thumb123...';
            if (fieldName === 'author') return 'did:arweave:author123...';
            if (fieldName === 'replyTo') return 'did:arweave:parent123...';
            if (fieldName === 'recipe') return 'did:arweave:recipe123...';
            if (fieldName === 'exercise') return 'did:arweave:exercise123...';
            if (fieldName === 'workout') return 'did:arweave:workout123...';
            if (fieldName === 'nutritionalInfo') return 'did:arweave:nutrition123...';
            if (fieldName === 'organization') return 'did:arweave:org123...';
            if (fieldName === 'user') return 'did:arweave:user123...';
            if (fieldName === 'parent') return 'did:arweave:parent123...';
            if (fieldName === 'equipment') return 'did:arweave:equipment123...';
            return 'did:arweave:abc123...';
        
        case 'repeated string':
            if (fieldName === 'tagItems') return ['sample', 'content', 'demo'];
            if (fieldName === 'keywords') return ['keyword1', 'keyword2', 'keyword3'];
            if (fieldName === 'categories') return ['category1', 'category2'];
            if (fieldName === 'instructions') return ['Step 1: Prepare ingredients', 'Step 2: Mix together', 'Step 3: Cook until done'];
            if (fieldName === 'muscleGroups') return ['chest', 'shoulders', 'triceps'];
            if (fieldName === 'equipmentRequired') return ['dumbbells', 'bench'];
            if (fieldName === 'alternativeEquipment') return ['resistance bands', 'bodyweight'];
            if (fieldName === 'goalTags') return ['strength', 'muscle building', 'upper body'];
            if (fieldName === 'allergens') return ['dairy', 'nuts'];
            if (fieldName === 'ingredient_unit') return ['cups', 'tbsp', 'lbs'];
            if (fieldName === 'exercise_unit') return ['sets', 'reps', 'minutes'];
            if (fieldName === 'ingredient_comment') return ['chopped', 'organic', 'room temperature'];
            if (fieldName === 'exercise_comment') return ['slow tempo', 'full range of motion', 'rest 60 seconds'];
            return [`${fieldName}1`, `${fieldName}2`];
        
        case 'repeated dref':
            if (fieldName === 'imageItems') return ['did:arweave:img1...', 'did:arweave:img2...'];
            if (fieldName === 'videoItems') return ['did:arweave:vid1...', 'did:arweave:vid2...'];
            if (fieldName === 'relatedContent') return ['did:arweave:related1...', 'did:arweave:related2...'];
            if (fieldName === 'ingredient') return ['did:arweave:chicken123...', 'did:arweave:garlic456...'];
            if (fieldName === 'exercise') return ['did:arweave:pushups123...', 'did:arweave:squats456...'];
            if (fieldName === 'meals') return ['did:arweave:breakfast123...', 'did:arweave:lunch456...'];
            if (fieldName === 'workouts') return ['did:arweave:workout1...', 'did:arweave:workout2...'];
            if (fieldName === 'equipment') return ['did:arweave:dumbbells123...', 'did:arweave:bench456...'];
            if (fieldName === 'items') return ['did:arweave:item1...', 'did:arweave:item2...'];
            if (fieldName === 'citations') return ['did:arweave:citation1...', 'did:arweave:citation2...'];
            if (fieldName === 'references') return ['did:arweave:ref1...', 'did:arweave:ref2...'];
            return ['did:arweave:ref1...', 'did:arweave:ref2...'];
        
        case 'repeated long':
            if (fieldName === 'ingredient_amount') return [2, 1, 0.5];
            if (fieldName === 'exercise_amount') return [3, 12, 45];
            if (fieldName === 'quantities') return [1, 2, 3];
            return [1, 2, 3];
        
        case 'repeated float':
            if (fieldName === 'weights') return [10.5, 15.0, 20.5];
            if (fieldName === 'measurements') return [1.5, 2.0, 0.75];
            return [1.0, 2.0, 3.0];
        
        default:
            return `Sample ${fieldName}`;
    }
}

function generateFieldDescription(fieldType, fieldName, enumValues = null) {
    const baseDescriptions = {
        'name': 'Title or name of the content',
        'description': 'Brief description of the content',
        'date': 'Unix timestamp (default: current time)',
        'language': 'Language code (default: "en")',
        'nsfw': 'Boolean for adult content (default: false)',
        'webUrl': 'Optional source URL',
        'tagItems': 'Array of tags for categorization'
    };

    // Field-specific descriptions
    const specificDescriptions = {
        // Image fields
        'imageUrl': 'URL to the image file',
        'contentType': 'MIME type of the image (e.g., image/jpeg, image/png)',
        'altText': 'Alternative text description for accessibility',
        'caption': 'Caption or title for the image',
        'width': 'Image width in pixels',
        'height': 'Image height in pixels',
        'fileSize': 'File size in bytes',
        
        // Video fields
        'videoUrl': 'URL to the video file',
        'youtubeUrl': 'YouTube video URL',
        'duration': 'Video duration in seconds or HH:MM:SS format',
        'resolution': 'Video resolution (e.g., 1920x1080)',
        'quality': 'Video quality setting',
        'format': 'Video file format',
        'thumbnail': 'DID reference to video thumbnail image',
        'views': 'Number of views',
        
        // Post fields
        'articleText': 'Main article content (required)',
        'bylineWriter': 'Author name',
        'bylineWritersTitle': 'Author title/position',
        'bylineWritersLocation': 'Author location/organization',
        'featuredImage': 'DID reference to main featured image',
        'imageItems': 'Array of DID references to additional images',
        'imageCaptionItems': 'Array of captions for images (parallel to imageItems)',
        'videoItems': 'Array of DID references to videos',
        'audioItems': 'Array of DID references to audio files',
        'audioCaptionItems': 'Array of captions for audio items',
        'replyTo': 'DID reference to post being replied to (for comments/replies)',
        
        // Text fields
        'textContent': 'Main text content of the document',
        'textFormat': 'Text format type (e.g., markdown, plain, html)',
        
        // General fields
        'author': 'DID reference to the content author',
        'category': 'Content category classification',
        'keywords': 'Array of keywords for search optimization',
        'isPublic': 'Boolean indicating if content is publicly visible',
        'featured': 'Boolean indicating if content should be featured',
        'rating': 'Content rating (0-5 scale)',
        'aspectRatio': 'Aspect ratio of media content'
    };

    if (baseDescriptions[fieldName]) {
        return baseDescriptions[fieldName];
    }

    if (specificDescriptions[fieldName]) {
        return specificDescriptions[fieldName];
    }

    switch (fieldType) {
        case 'string':
            return `Text field for ${fieldName}`;
        case 'long':
        case 'uint64':
            return `Numeric field for ${fieldName}`;
        case 'enum':
            const options = enumValues ? (
                enumValues.length > 0 && typeof enumValues[0] === 'object' ? 
                enumValues.map(v => v.name || v.code).join(', ') :
                enumValues.join(', ')
            ) : 'predefined options';
            return `Enum field for ${fieldName} (options: ${options})`;
        case 'bool':
            return `Boolean field for ${fieldName}`;
        case 'float':
            return `Floating point number for ${fieldName}`;
        case 'dref':
            return `DID reference to another record for ${fieldName}`;
        case 'repeated string':
            return `Array of strings for ${fieldName}`;
        case 'repeated dref':
            return `Array of DID references for ${fieldName}`;
        default:
            return `Field for ${fieldName}`;
    }
}

function processTemplateFields(template) {
    const fields = JSON.parse(template.data.fields);
    const fieldsInTemplate = {};
    
    // Build fieldsInTemplate object (similar to routes/templates.js processing)
    Object.keys(fields).reduce((acc, key) => {
        if (key.startsWith('index_')) {
            const fieldName = key.replace('index_', '');
            acc[fieldName] = {
                type: fields[fieldName],
                index: fields[key]
            };
            
            // Handle enum fields - look for enumValues
            if (fields[fieldName] === 'enum') {
                const enumValuesKey = `${fieldName}Values`;
                if (fields[enumValuesKey]) {
                    acc[fieldName].enumValues = fields[enumValuesKey];
                } else if (template.data[enumValuesKey]) {
                    acc[fieldName].enumValues = template.data[enumValuesKey];
                }
            }
        }
        return acc;
    }, fieldsInTemplate);
    
    return fieldsInTemplate;
}

// Generic function to generate dynamic schema for any template type
async function generateDynamicSchema(templateName, endpointPath, templateDescription) {
    // Get the template dynamically
    const templateTxid = getTemplateTxidByName(templateName);
    if (!templateTxid) {
        throw new Error(`${templateName} template not found in configuration`);
    }

    const template = await searchTemplateByTxId(templateTxid);
    if (!template) {
        throw new Error(`${templateName} template not found in database`);
    }

    // Process template fields dynamically
    const fieldsInTemplate = processTemplateFields(template);
    
    // Create field sections dynamically
    const basicFields = {};
    const templateSpecificFields = {};
    const fieldDescriptions = {};
    
    // Always include essential basic fields for developer guidance
    // Create context-aware examples based on template type
    const getContextualExample = (fieldName) => {
        const examples = {
            'name': {
                'post': 'Breaking: New Discovery in AI Research',
                'image': 'Beautiful Sunset Photography',
                'video': 'Tutorial: Getting Started with OIP',
                'text': 'Sample Text Document',
                'audio': 'Podcast Episode: The Future of AI',
                'recipe': 'Mediterranean Grilled Chicken',
                'workout': 'Upper Body Strength Training',
                'exercise': 'Push-ups',
                'nutritionalInfo': 'Organic Grass-Fed Beef',
                'podcast': 'The Tech Talk Show',
                'podcastShow': 'Weekly Tech Insights',
                'mealPlan': 'Healthy Weekly Meal Plan',
                'workoutSchedule': 'Monthly Fitness Schedule',
                'fitnessEquipment': 'Adjustable Dumbbells',
                'userFitnessProfile': 'John\'s Fitness Profile',
                'exerciseResult': 'Morning Run Results',
                'workoutCompletion': 'Upper Body Workout Completed',
                'weightEntry': 'Weekly Weight Check',
                'shoppingList': 'Grocery Shopping List',
                'userFitnessAchievment': '10K Run Achievement',
                'organization': 'Fitness First Gym',
                'creatorRegistration': 'Fitness Coach Registration',
                'modelProvider': 'OpenAI GPT-4 Provider',
                'conversationSession': 'AI Assistant Chat Session',
                'multiResolutionGif': 'Animated Exercise Demo',
                'jfkFilesDocument': 'JFK Document Analysis',
                'jfkFilesPageOfDocument': 'JFK Document Page 1',
                'associatedURLOnWeb': 'Related Web Resource',
                'accessControl': 'Private Content Access',
                'default': 'Sample Content'
            },
            'description': {
                'post': 'Scientists announce breakthrough in neural network efficiency',
                'image': 'A stunning photograph captured during golden hour',
                'video': 'Learn the basics of publishing content on the OIP network',
                'text': 'A sample text document demonstrating the text template structure',
                'audio': 'An engaging discussion about artificial intelligence and its impact on society',
                'recipe': 'Juicy grilled chicken thighs marinated in Mediterranean herbs and spices',
                'workout': 'A comprehensive upper body workout focusing on strength and muscle building',
                'exercise': 'A classic bodyweight exercise targeting chest, shoulders, and triceps',
                'nutritionalInfo': 'High-quality grass-fed beef with complete nutritional breakdown',
                'podcast': 'Weekly technology podcast covering the latest trends and innovations',
                'podcastShow': 'A show dedicated to exploring cutting-edge technology topics',
                'mealPlan': 'A balanced weekly meal plan designed for optimal nutrition and health',
                'workoutSchedule': 'A structured monthly fitness schedule for progressive training',
                'fitnessEquipment': 'Versatile adjustable dumbbells for home workouts',
                'userFitnessProfile': 'Comprehensive fitness profile tracking goals and progress',
                'exerciseResult': 'Detailed results from morning cardio session',
                'workoutCompletion': 'Summary of completed upper body strength training session',
                'weightEntry': 'Weekly body weight measurement and tracking',
                'shoppingList': 'Organized grocery list for healthy meal preparation',
                'userFitnessAchievment': 'Milestone achievement for completing first 10K run',
                'organization': 'Professional fitness organization providing training services',
                'creatorRegistration': 'Registration profile for certified fitness professionals',
                'modelProvider': 'AI model provider offering advanced language processing capabilities',
                'conversationSession': 'Interactive chat session with AI assistant for fitness guidance',
                'multiResolutionGif': 'Animated demonstration showing proper exercise form and technique',
                'jfkFilesDocument': 'Historical document analysis from JFK assassination files',
                'jfkFilesPageOfDocument': 'Individual page from JFK historical document archive',
                'associatedURLOnWeb': 'Related web resource providing additional context and information',
                'accessControl': 'Access control configuration for private content management',
                'default': 'A sample description demonstrating the template structure'
            },
            'tagItems': {
                'post': ['AI', 'research', 'technology', 'science'],
                'image': ['photography', 'sunset', 'nature', 'beautiful'],
                'video': ['tutorial', 'education', 'beginner', 'guide'],
                'text': ['document', 'text', 'sample', 'demo'],
                'audio': ['podcast', 'AI', 'technology', 'discussion'],
                'recipe': ['mediterranean', 'chicken', 'healthy', 'grilled'],
                'workout': ['strength', 'upper body', 'muscle building', 'fitness'],
                'exercise': ['bodyweight', 'chest', 'push', 'strength'],
                'nutritionalInfo': ['beef', 'protein', 'grass-fed', 'nutrition'],
                'podcast': ['technology', 'innovation', 'weekly', 'trends'],
                'podcastShow': ['tech', 'education', 'weekly', 'insights'],
                'mealPlan': ['healthy', 'nutrition', 'balanced', 'weekly'],
                'workoutSchedule': ['fitness', 'schedule', 'training', 'progressive'],
                'fitnessEquipment': ['dumbbells', 'home gym', 'adjustable', 'strength'],
                'userFitnessProfile': ['profile', 'goals', 'tracking', 'fitness'],
                'exerciseResult': ['cardio', 'running', 'results', 'performance'],
                'workoutCompletion': ['strength', 'completed', 'upper body', 'training'],
                'weightEntry': ['weight', 'tracking', 'measurement', 'health'],
                'shoppingList': ['grocery', 'healthy', 'meal prep', 'nutrition'],
                'userFitnessAchievment': ['achievement', '10K', 'running', 'milestone'],
                'organization': ['fitness', 'gym', 'training', 'professional'],
                'creatorRegistration': ['coach', 'certification', 'fitness', 'professional'],
                'modelProvider': ['AI', 'GPT-4', 'language model', 'provider'],
                'conversationSession': ['AI', 'chat', 'assistant', 'fitness'],
                'multiResolutionGif': ['animation', 'exercise', 'demo', 'technique'],
                'jfkFilesDocument': ['JFK', 'historical', 'document', 'analysis'],
                'jfkFilesPageOfDocument': ['JFK', 'document', 'page', 'historical'],
                'associatedURLOnWeb': ['web', 'resource', 'reference', 'link'],
                'accessControl': ['private', 'access', 'security', 'control'],
                'default': ['sample', 'content', 'demo']
            }
        };
        
        return examples[fieldName][templateName] || examples[fieldName]['default'];
    };

    const allBasicFields = {
        'name': {
            type: 'string',
            example: getContextualExample('name'),
            description: 'Title or name of the content'
        },
        'description': {
            type: 'string',
            example: getContextualExample('description'),
            description: 'Brief description of the content'
        },
        'date': {
            type: 'long',
            example: Math.floor(Date.now() / 1000),
            description: 'Unix timestamp (default: current time)'
        },
        'language': {
            type: 'string',
            example: 'en',
            description: 'Language code (default: "en")'
        },
        'avatar': {
            type: 'dref',
            example: 'did:arweave:avatar123...',
            description: 'DID reference to the avatar image'
        },
        'license': {
            type: 'dref',
            example: 'did:arweave:license123...',
            description: 'DID reference to License'
        },
        'nsfw': {
            type: 'bool',
            example: false,
            description: 'Boolean for adult content (default: false)'
        },
        'creatorItems': {
            type: 'repeated dref',
            example: ['did:arweave:creator123...', 'did:arweave:creator456...'],
            description: 'Array of DID references to the creators of the content'
        },
        'tagItems': {
            type: 'repeated string',
            example: getContextualExample('tagItems'),
            description: 'Array of tags for categorization'
        },
        'noteItems': {
            type: 'repeated string',
            example: ['note1', 'note2', 'note3'],
            description: 'Array of notes for the content'
        },
        'urlItems': {
            type: 'repeated dref',
            example: ['did:arweave:url123...', 'did:arweave:url456...'],
            description: 'Array of DID references to the URLs for the content'
        },
        'citations': {
            type: 'repeated dref',
            example: ['did:arweave:citation123...', 'did:arweave:citation456...'],
            description: 'Array of DID references to the citations for the content'
        },
        'webUrl': {
            type: 'string',
            example: 'https://example.com',
            description: 'Optional source URL'
        }
    }

    const essentialBasicFields = {
        'name': {
            type: 'string',
            example: getContextualExample('name'),
            description: 'Title or name of the content'
        },
        'description': {
            type: 'string', 
            example: getContextualExample('description'),
            description: 'Brief description of the content'
        },
        'date': {
            type: 'long',
            example: Math.floor(Date.now() / 1000),
            description: 'Unix timestamp (default: current time)'
        },
        'language': {
            type: 'string',
            example: 'en',
            description: 'Language code (default: "en")'
        },
        'tagItems': {
            type: 'repeated string',
            example: getContextualExample('tagItems'),
            description: 'Array of tags for categorization'
        }
    };

    // Add basic fields first - use allBasicFields for 'basic' template, essentialBasicFields for others
    const fieldsToUse = templateName === 'basic' ? allBasicFields : essentialBasicFields;
    Object.keys(fieldsToUse).forEach(fieldName => {
        const fieldInfo = fieldsToUse[fieldName];
        basicFields[fieldName] = fieldInfo.example;
        fieldDescriptions[`basic.${fieldName}`] = fieldInfo.description;
    });
    
    // Process template-defined fields
    Object.keys(fieldsInTemplate).forEach(fieldName => {
        const fieldInfo = fieldsInTemplate[fieldName];
        const exampleValue = generateExampleDataByType(fieldInfo.type, fieldName, fieldInfo.enumValues);
        const description = generateFieldDescription(fieldInfo.type, fieldName, fieldInfo.enumValues);
        
        // Common basic fields (override essentials if defined in template, or add additional ones)
        if (['name', 'description', 'date', 'language', 'nsfw', 'webUrl', 'tagItems'].includes(fieldName)) {
            basicFields[fieldName] = exampleValue; // This will override essentials with template-specific examples
            fieldDescriptions[`basic.${fieldName}`] = description;
        } else {
            // Other fields belong to the template-specific section
            templateSpecificFields[fieldName] = exampleValue;
            fieldDescriptions[`${templateName}.${fieldName}`] = description;
        }
    });

    // Build the dynamic schema
    const dynamicSchema = {
        "description": `Complete JSON schema for publishing a new ${templateDescription} via ${endpointPath} (dynamically generated)`,
        "template_info": {
            "template_name": templateName,
            "template_txid": templateTxid,
            "fields_count": Object.keys(fieldsInTemplate).length
        },
        "example": {
            "basic": basicFields,
            [templateName]: templateSpecificFields,
            "blockchain": "arweave"
        },
        "field_descriptions": {
            ...fieldDescriptions,
            "blockchain": "Target blockchain ('arweave' or 'turbo')"
        },
        "template_fields_info": fieldsInTemplate,
        "note": "This schema was generated dynamically from the blockchain template. Field sections may vary based on the actual template structure."
    };

    return dynamicSchema;
}

// Add dynamic text schema endpoint
router.get('/newText/schema', async (req, res) => {
    try {
        const textSchema = await generateDynamicSchema('text', 'POST /api/publish/newText', 'text document');
        res.status(200).json(textSchema);
    } catch (error) {
        console.error('Error generating dynamic text schema:', error);
        res.status(500).json({ 
            error: 'Failed to generate dynamic text schema',
            details: error.message 
        });
    }
});

// Add dynamic image schema endpoint
router.get('/newImage/schema', async (req, res) => {
    try {
        const imageSchema = await generateDynamicSchema('image', 'POST /api/publish/newImage', 'image record');
        res.status(200).json(imageSchema);
    } catch (error) {
        console.error('Error generating dynamic image schema:', error);
        res.status(500).json({ 
            error: 'Failed to generate dynamic image schema',
            details: error.message 
        });
    }
});

// Add dynamic video schema endpoint
router.get('/newVideo/schema', async (req, res) => {
    try {
        const videoSchema = await generateDynamicSchema('video', 'POST /api/publish/newVideo', 'video record');
        res.status(200).json(videoSchema);
    } catch (error) {
        console.error('Error generating dynamic video schema:', error);
        res.status(500).json({ 
            error: 'Failed to generate dynamic video schema',
            details: error.message 
        });
    }
});

// Lookup nutritional info without publishing (for preview)
router.post('/lookupNutritionalInfo', authenticateToken, async (req, res) => {
    try {
        const { ingredientName } = req.body;
        
        if (!ingredientName) {
            return res.status(400).json({ error: 'ingredientName is required' });
        }
        
        console.log(`Looking up nutritional info for: ${ingredientName}`);
        
        // Fetch nutritional data using the helper
        const nutritionalData = await fetchNutritionalData(ingredientName);
        
        // Return just the nutritional info part (not publishing yet)
        res.status(200).json({
            success: true,
            ingredientName,
            data: nutritionalData
        });
    } catch (error) {
        console.error('Error looking up nutritional info:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to lookup nutritional information',
            details: error.message 
        });
    }
});

// Add newNutritionalInfo endpoint for publishing nutritional info records
router.post('/newNutritionalInfo', authenticateToken, async (req, res) => {
    try {
        console.log('POST /api/publish/newNutritionalInfo', req.body);
        const inputData = req.body.data || req.body; // Handle both wrapped and unwrapped formats
        const blockchain = req.body.blockchain || 'arweave';
        let recordType = 'nutritionalInfo';

        // Map the input format to the correct template format (camelCase)
        const nutritionalInfoRecord = {
            basic: {
                name: inputData.basic?.name || 'Nutritional Info Record',
                date: inputData.basic?.date || Math.floor(Date.now() / 1000),
                language: inputData.basic?.language || 'en',
                nsfw: inputData.basic?.nsfw || false,
                webUrl: inputData.basic?.webUrl || '',
                tagItems: inputData.basic?.tagItems || []
            },
            nutritionalInfo: {
                // Use camelCase field names to match the template
                standardAmount: inputData.nutritionalInfo?.standardAmount || 1,
                standardUnit: inputData.nutritionalInfo?.standardUnit || 'unit',
                calories: inputData.nutritionalInfo?.calories || 0,
                proteinG: inputData.nutritionalInfo?.proteinG || 0,
                fatG: inputData.nutritionalInfo?.fatG || 0,
                saturatedFatG: inputData.nutritionalInfo?.saturatedFatG || 0,
                transFatG: inputData.nutritionalInfo?.transFatG || 0,
                cholesterolMg: inputData.nutritionalInfo?.cholesterolMg || 0,
                sodiumMg: inputData.nutritionalInfo?.sodiumMg || 0,
                carbohydratesG: inputData.nutritionalInfo?.carbohydratesG || 0,
                dietaryFiberG: inputData.nutritionalInfo?.dietaryFiberG || 0,
                sugarsG: inputData.nutritionalInfo?.sugarsG || 0,
                addedSugarsG: inputData.nutritionalInfo?.addedSugarsG || 0,
                vitaminDMcg: inputData.nutritionalInfo?.vitaminDMcg || 0,
                calciumMg: inputData.nutritionalInfo?.calciumMg || 0,
                ironMg: inputData.nutritionalInfo?.ironMg || 0,
                potassiumMg: inputData.nutritionalInfo?.potassiumMg || 0,
                vitaminAMcg: inputData.nutritionalInfo?.vitaminAMcg || 0,
                vitaminCMg: inputData.nutritionalInfo?.vitaminCMg || 0,
                allergens: inputData.nutritionalInfo?.allergens || [],
                glutenFree: inputData.nutritionalInfo?.glutenFree || false,
                organic: inputData.nutritionalInfo?.organic || false
            }
        };

        // Add image data if provided
        if (inputData.image?.webUrl) {
            nutritionalInfoRecord.image = {
                webUrl: inputData.image.webUrl,
                contentType: inputData.image.contentType || 'image/jpeg'
            };
        }

        console.log('Final nutritional info data:', nutritionalInfoRecord);

        // Publish the nutritional info record
        const nutritionalInfoResult = await publishNewRecord(nutritionalInfoRecord, recordType, false, false, false, null, blockchain);

        const transactionId = nutritionalInfoResult.transactionId;
        const recordToIndex = nutritionalInfoResult.recordToIndex;

        res.status(200).json({ 
            transactionId, 
            recordToIndex, 
            blockchain,
            message: 'Nutritional info published successfully'
        });

    } catch (error) {
        console.error('Error publishing nutritional info:', error);
        res.status(500).json({ error: 'Failed to publish nutritional info' });
    }
});

// Add newPost endpoint for publishing post records
router.post('/newPost', authenticateToken, async (req, res) => {
    try {
        console.log('POST /api/publish/newPost', req.body);
        const record = req.body;
        const blockchain = req.body.blockchain || 'arweave'; // Get blockchain parameter, default to arweave
        let recordType = 'post';

        // Helper function to check if an object has meaningful data
        function hasData(obj) {
            if (!obj || typeof obj !== 'object') return false;
            if (Array.isArray(obj)) return obj.length > 0;
            
            // Check if object has any non-empty, non-null values
            return Object.values(obj).some(value => {
                if (value === null || value === undefined || value === '') return false;
                if (Array.isArray(value)) return value.length > 0;
                if (typeof value === 'object') return hasData(value);
                return true;
            });
        }

        // Filter out empty arrays and objects before passing to publishNewRecord
        const cleanedRecord = { ...record };
        
        // Clean post section
        if (cleanedRecord.post) {
            // Remove empty arrays to prevent empty record creation
            if (Array.isArray(cleanedRecord.post.imageItems) && cleanedRecord.post.imageItems.length === 0) {
                delete cleanedRecord.post.imageItems;
            }
            if (Array.isArray(cleanedRecord.post.videoItems) && cleanedRecord.post.videoItems.length === 0) {
                delete cleanedRecord.post.videoItems;
            }
            if (Array.isArray(cleanedRecord.post.audioItems) && cleanedRecord.post.audioItems.length === 0) {
                delete cleanedRecord.post.audioItems;
            }
            if (Array.isArray(cleanedRecord.post.imageCaptionItems) && cleanedRecord.post.imageCaptionItems.length === 0) {
                delete cleanedRecord.post.imageCaptionItems;
            }
            if (Array.isArray(cleanedRecord.post.audioCaptionItems) && cleanedRecord.post.audioCaptionItems.length === 0) {
                delete cleanedRecord.post.audioCaptionItems;
            }
            
            // Remove empty string fields that would create empty records
            if (!cleanedRecord.post.replyTo || cleanedRecord.post.replyTo === '') {
                delete cleanedRecord.post.replyTo;
            }
        }

        console.log('Final post data:', cleanedRecord);

        // Publish the post record - let translateJSONtoOIPData handle the dref processing
        const postResult = await publishNewRecord(cleanedRecord, recordType, false, false, false, null, blockchain);

        const transactionId = postResult.transactionId;
        const recordToIndex = postResult.recordToIndex;

        res.status(200).json({ 
            transactionId, 
            recordToIndex, 
            blockchain,
            message: 'Post published successfully'
        });

    } catch (error) {
        console.error('Error publishing post:', error);
        res.status(500).json({ error: 'Failed to publish post' });
    }
});

// Dynamic schema endpoint that accepts recordType as parameter
router.get('/schema', async (req, res) => {
    try {
        const { recordType } = req.query;
        
        if (!recordType) {
            return res.status(400).json({
                error: 'Missing required parameter: recordType',
                usage: 'GET /api/publish/schema?recordType=mealPlan',
                available_record_types: Object.keys(require('../../config/templates.config.js').defaultTemplates)
            });
        }

        // Check if the recordType exists in our templates config
        const templatesConfig = require('../../config/templates.config.js');
        const availableTemplates = Object.keys(templatesConfig.defaultTemplates);
        
        if (!availableTemplates.includes(recordType)) {
            return res.status(404).json({
                error: `Record type '${recordType}' not found`,
                available_record_types: availableTemplates,
                usage: 'GET /api/publish/schema?recordType=mealPlan'
            });
        }

        // Generate the dynamic schema
        const endpointPath = `POST /api/records/newRecord?recordType=${recordType}`;
        const templateDescription = `${recordType} record`;
        
        const dynamicSchema = await generateDynamicSchema(recordType, endpointPath, templateDescription);
        
        // Add additional metadata for the dynamic endpoint
        dynamicSchema.endpoint_info = {
            publishing_endpoint: `/api/records/newRecord?recordType=${recordType}&storage=arweave`,
            publishing_endpoint_gun: `/api/records/newRecord?recordType=${recordType}&storage=gun`,
            method: 'POST',
            authentication: 'Optional for Arweave, Required for GUN storage',
            content_type: 'application/json'
        };
        
        dynamicSchema.usage_examples = {
            arweave_publishing: {
                url: `/api/records/newRecord?recordType=${recordType}&storage=arweave`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer <jwt-token> (optional)'
                },
                body: dynamicSchema.example
            },
            gun_publishing: {
                url: `/api/records/newRecord?recordType=${recordType}&storage=gun`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer <jwt-token> (required)'
                },
                body: dynamicSchema.example
            }
        };

        res.status(200).json(dynamicSchema);

    } catch (error) {
        console.error(`Error generating dynamic schema for recordType '${req.query.recordType}':`, error);
        res.status(500).json({ 
            error: 'Failed to generate dynamic schema',
            details: error.message,
            recordType: req.query.recordType
        });
    }
});

module.exports = router;