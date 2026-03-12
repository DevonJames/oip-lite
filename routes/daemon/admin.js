const express = require('express');
const { elasticClient } = require('../../helpers/core/elasticsearch');
const { authenticateToken } = require('../../helpers/utils');
const router = express.Router();

/**
 * Validate that the requesting user is an admin of the organization hosting this node
 * Uses the approach: PUBLIC_API_BASE_URL → organization.webUrl → organization.adminPublicKeys
 */
async function validateNodeAdmin(req, res, next) {
    try {
        const user = req.user;
        
        if (!user || !user.publicKey) {
            return res.status(401).json({ 
                error: 'Authentication required',
                message: 'Please provide a valid JWT token'
            });
        }
        
        // Get the node's public API base URL from environment
        const nodeBaseUrl = process.env.PUBLIC_API_BASE_URL;
        
        if (!nodeBaseUrl) {
            console.warn('⚠️ PUBLIC_API_BASE_URL not configured - falling back to isAdmin check');
            // Fallback to traditional isAdmin check if PUBLIC_API_BASE_URL not configured
            if (user.isAdmin) {
                req.isNodeAdmin = true;
                return next();
            }
            return res.status(403).json({ 
                error: 'Unauthorized',
                message: 'PUBLIC_API_BASE_URL not configured on this node'
            });
        }
        
        // Extract domain from PUBLIC_API_BASE_URL
        const nodeDomain = extractDomain(nodeBaseUrl);
        console.log('🔍 Node domain from PUBLIC_API_BASE_URL:', nodeDomain);
        console.log('🔍 Base domain:', extractBaseDomain(nodeDomain));
        
        // Get ALL organizations and filter by domain matching
        const orgSearchResult = await elasticClient.search({
            index: 'organizations',
            body: {
                query: { match_all: {} },
                size: 1000
            }
        });
        
        console.log(`🔍 Found ${orgSearchResult.hits.hits.length} total organizations in database`);
        
        // Filter organizations by domain matching
        const matchingOrgs = orgSearchResult.hits.hits.filter(hit => {
            const orgWebUrl = hit._source.data?.webUrl;
            const matches = doesOrgMatchDomain(orgWebUrl, nodeDomain);
            if (matches) {
                console.log(`✅ Organization "${hit._source.data?.name}" (${orgWebUrl}) matches node domain ${nodeDomain}`);
            }
            return matches;
        });
        
        if (matchingOrgs.length === 0) {
            console.warn('⚠️ No organization found matching node domain:', nodeDomain);
            console.warn('💡 Available organization webUrls:', 
                orgSearchResult.hits.hits.map(h => h._source.data?.webUrl).join(', '));
            
            // Fallback to traditional isAdmin check
            if (user.isAdmin) {
                console.log('✅ Falling back to isAdmin check - user is admin');
                req.isNodeAdmin = true;
                req.nodeOrganization = null;
                return next();
            }
            return res.status(403).json({ 
                error: 'Unauthorized',
                message: `No organization registered for this node domain "${nodeDomain}". Please create an organization record with matching webUrl.`,
                availableOrganizations: orgSearchResult.hits.hits.map(h => ({
                    name: h._source.data?.name,
                    webUrl: h._source.data?.webUrl
                }))
            });
        }
        
        // Sort matching organizations by date (most recent first)
        matchingOrgs.sort((a, b) => {
            const dateA = a._source.data?.date || a._source.oip?.indexedAt || a._source.oip?.inArweaveBlock || 0;
            const dateB = b._source.data?.date || b._source.oip?.indexedAt || b._source.oip?.inArweaveBlock || 0;
            const numA = typeof dateA === 'string' ? new Date(dateA).getTime() : Number(dateA);
            const numB = typeof dateB === 'string' ? new Date(dateB).getTime() : Number(dateB);
            return numB - numA;
        });
        
        const organization = matchingOrgs[0]._source;
        
        if (matchingOrgs.length > 1) {
            console.log(`ℹ️ Found ${matchingOrgs.length} matching organizations, using most recent one`);
            console.log(`ℹ️ Selected organization: ${organization.data?.name} (${organization.data?.orgHandle})`);
        }
        console.log('✅ Found organization for node:', organization.data?.name || organization.data?.orgHandle);
        
        // Extract admin public keys
        let adminPublicKeys = organization.data?.adminPublicKeys || 
                              organization.oip?.organization?.adminPublicKeys ||
                              organization.adminPublicKeys;
        
        if (!adminPublicKeys) {
            console.error('❌ No adminPublicKeys found in organization');
            return res.status(500).json({
                error: 'Configuration error',
                message: 'Organization record is missing adminPublicKeys field'
            });
        }
        
        // Handle both array and string formats
        if (typeof adminPublicKeys === 'string') {
            try {
                const parsed = JSON.parse(adminPublicKeys);
                adminPublicKeys = Array.isArray(parsed) ? parsed : [adminPublicKeys];
            } catch (e) {
                adminPublicKeys = [adminPublicKeys];
            }
        }
        
        if (!Array.isArray(adminPublicKeys)) {
            adminPublicKeys = adminPublicKeys ? [adminPublicKeys] : [];
        }
        
        adminPublicKeys = adminPublicKeys.filter(key => key);
        
        console.log('🔑 Organization admin public keys:', adminPublicKeys.length, 'key(s)');
        
        const isAdmin = adminPublicKeys.some(adminKey => {
            const normalizedAdminKey = String(adminKey).trim();
            const normalizedUserKey = String(user.publicKey).trim();
            return normalizedAdminKey === normalizedUserKey;
        });
        
        if (!isAdmin) {
            console.warn('❌ User is not an admin of the organization');
            return res.status(403).json({ 
                error: 'Unauthorized',
                message: 'You are not an admin of the organization hosting this node',
                organizationName: organization.data?.name,
                organizationHandle: organization.data?.orgHandle
            });
        }
        
        console.log('✅ User validated as node admin');
        
        req.isNodeAdmin = true;
        req.nodeOrganization = organization;
        
        next();
        
    } catch (error) {
        console.error('❌ Error validating node admin:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: 'Failed to validate admin permissions'
        });
    }
}

function extractDomain(url) {
    try {
        let domain = url.replace(/^https?:\/\//, '');
        domain = domain.replace(/:\d+.*$/, '');
        domain = domain.replace(/\/.*$/, '');
        return domain;
    } catch (error) {
        return url;
    }
}

function extractBaseDomain(domain) {
    const parts = domain.split('.');
    if (parts.length > 2) {
        return parts.slice(-2).join('.');
    }
    return domain;
}

function doesOrgMatchDomain(orgWebUrl, nodeDomain) {
    if (!orgWebUrl || !nodeDomain) return false;
    
    const normalizedOrgUrl = extractDomain(orgWebUrl.toLowerCase());
    const normalizedNodeDomain = nodeDomain.toLowerCase();
    
    if (normalizedOrgUrl === normalizedNodeDomain) return true;
    
    const orgBaseDomain = extractBaseDomain(normalizedOrgUrl);
    const nodeBaseDomain = extractBaseDomain(normalizedNodeDomain);
    
    return orgBaseDomain === nodeBaseDomain;
}

/**
 * GET /api/admin/node-analytics
 * 
 * Get comprehensive analytics for the OIP node including FitnessAlly funnel tracking
 * 
 * Query params:
 * - timeRange: 24h, 7d, 30d, 90d, all (default: 30d)
 * - userId: Filter by specific user ID
 * - includeDetails: true/false - include detailed logs (default: false)
 */
router.get('/node-analytics', authenticateToken, validateNodeAdmin, async (req, res) => {
    try {
        const { timeRange = '30d', userId, includeDetails = 'false' } = req.query;
        
        console.log('📊 Node analytics request from admin:', req.user.email);
        console.log('📊 Time range:', timeRange);
        
        const timeFilter = calculateTimeFilter(timeRange);
        console.log('📊 Time filter:', timeFilter || 'none (all time)');
        
        // Build base query for activity logs
        const baseQuery = { bool: { must: [] } };
        if (timeFilter) {
            baseQuery.bool.must.push({ range: { timestamp: { gte: timeFilter } } });
        }
        if (userId) {
            baseQuery.bool.must.push({ term: { userId: userId } });
        }
        
        // ==========================================
        // 1. Get registered users with their publicKeys
        // ==========================================
        // Only show users created after this date (filters out old test accounts)
        const userCreatedAfter = '2026-01-03T01:41:01.174Z';
        
        const usersResult = await elasticClient.search({
            index: 'users',
            body: {
                query: {
                    bool: {
                        must: [
                            { match: { waitlistStatus: 'registered' } },
                            { range: { createdAt: { gte: userCreatedAfter } } }
                        ]
                    }
                },
                size: 1000,
                _source: ['email', 'publicKey', 'createdAt', 'subscriptionStatus', 'isAdmin', 'importedWallet']
            }
        });
        
        const registeredUsers = usersResult.hits.hits.map(hit => ({
            id: hit._id,
            email: hit._source.email,
            publicKey: hit._source.publicKey,
            createdAt: hit._source.createdAt,
            subscriptionStatus: hit._source.subscriptionStatus,
            isAdmin: hit._source.isAdmin || false,
            importedWallet: hit._source.importedWallet || false
        }));
        
        // Create publicKey -> user mapping for later use
        const publicKeyToUser = {};
        registeredUsers.forEach(user => {
            if (user.publicKey) {
                publicKeyToUser[user.publicKey] = user;
            }
        });
        
        // ==========================================
        // 2. Get FitnessAlly funnel data from GUN records
        // ==========================================
        const funnelData = await getFitnessAllyFunnelData(timeFilter, publicKeyToUser);
        
        // ==========================================
        // 3. Get activity stats (existing functionality)
        // ==========================================
        const totalActivityResult = await elasticClient.count({
            index: 'user_activity',
            body: { query: baseQuery }
        });
        
        // Activity breakdown by request type
        const activityByTypeResult = await elasticClient.search({
            index: 'user_activity',
            body: {
                query: baseQuery,
                size: 0,
                aggs: {
                    by_request_type: { terms: { field: 'requestType', size: 50 } }
                }
            }
        });
        
        // Activity by user - try both keyword and direct field
        let activityByUserResult;
        try {
            activityByUserResult = await elasticClient.search({
                index: 'user_activity',
                body: {
                    query: {
                        bool: {
                            must: [
                                ...baseQuery.bool.must,
                                { exists: { field: 'userEmail' } }
                            ]
                        }
                    },
                    size: 0,
                    aggs: {
                        by_user: {
                            terms: {
                                field: 'userEmail',
                                size: 1000,
                                order: { _count: 'desc' },
                                min_doc_count: 1
                            },
                            aggs: {
                                by_request_type: { terms: { field: 'requestType', size: 20 } },
                                by_record_type: { terms: { field: 'recordType', size: 20 } },
                                avg_duration: { avg: { field: 'duration' } },
                                success_rate: { avg: { field: 'success' } }
                            }
                        }
                    }
                }
            });
        } catch (err) {
            console.log('⚠️ userEmail aggregation failed, trying userPublicKey:', err.message);
            activityByUserResult = await elasticClient.search({
                index: 'user_activity',
                body: {
                    query: {
                        bool: {
                            must: [
                                ...baseQuery.bool.must,
                                { exists: { field: 'userPublicKey' } }
                            ]
                        }
                    },
                    size: 0,
                    aggs: {
                        by_user: {
                            terms: {
                                field: 'userPublicKey',
                                size: 1000,
                                order: { _count: 'desc' },
                                min_doc_count: 1
                            },
                            aggs: {
                                by_request_type: { terms: { field: 'requestType', size: 20 } },
                                by_record_type: { terms: { field: 'recordType', size: 20 } },
                                avg_duration: { avg: { field: 'duration' } },
                                success_rate: { avg: { field: 'success' } }
                            }
                        }
                    }
                }
            });
        }
        
        // Recent logins
        const loginQuery = {
            bool: {
                must: [
                    { term: { requestType: 'user_login' } },
                    { term: { success: true } }
                ]
            }
        };
        if (timeFilter) {
            loginQuery.bool.must.push({ range: { timestamp: { gte: timeFilter } } });
        }
        
        const recentLoginsResult = await elasticClient.search({
            index: 'user_activity',
            body: {
                query: loginQuery,
                size: 100,
                sort: [{ timestamp: 'desc' }],
                _source: ['timestamp', 'userEmail', 'ip', 'userAgent']
            }
        });
        
        // Top endpoints
        const topEndpointsResult = await elasticClient.search({
            index: 'user_activity',
            body: {
                query: baseQuery,
                size: 0,
                aggs: {
                    top_endpoints: {
                        terms: { field: 'endpoint', size: 20, order: { _count: 'desc' } },
                        aggs: {
                            avg_duration: { avg: { field: 'duration' } },
                            success_rate: { avg: { field: 'success' } }
                        }
                    }
                }
            }
        });
        
        // Auth breakdown
        const authBreakdownResult = await elasticClient.search({
            index: 'user_activity',
            body: {
                query: baseQuery,
                size: 0,
                aggs: {
                    authenticated: { filter: { exists: { field: 'userEmail' } } },
                    unauthenticated: { filter: { bool: { must_not: { exists: { field: 'userEmail' } } } } }
                }
            }
        });
        
        // Error rate over time
        const errorRateResult = await elasticClient.search({
            index: 'user_activity',
            body: {
                query: baseQuery,
                size: 0,
                aggs: {
                    errors_over_time: {
                        date_histogram: {
                            field: 'timestamp',
                            calendar_interval: timeRange === '24h' ? 'hour' : 'day'
                        },
                        aggs: {
                            error_rate: { avg: { script: { source: "doc['success'].value ? 0 : 1" } } }
                        }
                    }
                }
            }
        });
        
        // ==========================================
        // 4. Process user activity data
        // ==========================================
        const userBuckets = activityByUserResult.aggregations?.by_user?.buckets || [];
        const byUserData = userBuckets.map(bucket => {
            const isPublicKey = bucket.key.length === 66 && /^[0-9a-f]+$/i.test(bucket.key);
            const userInfo = isPublicKey ? publicKeyToUser[bucket.key] : null;
            
            return {
                email: isPublicKey ? (userInfo?.email || 'unknown') : bucket.key,
                publicKey: isPublicKey ? bucket.key : (userInfo?.publicKey || null),
                totalRequests: bucket.doc_count,
                avgDuration: Math.round(bucket.avg_duration?.value || 0),
                successRate: ((bucket.success_rate?.value || 0) * 100).toFixed(2) + '%',
                requestBreakdown: (bucket.by_request_type?.buckets || []).map(tb => ({
                    type: tb.key,
                    count: tb.doc_count
                })),
                recordTypeBreakdown: (bucket.by_record_type?.buckets || []).map(tb => ({
                    type: tb.key,
                    count: tb.doc_count
                }))
            };
        });
        
        // Log analytics summary
        console.log('📊 Analytics Summary:');
        console.log(`   - Total requests: ${totalActivityResult.count}`);
        console.log(`   - Authenticated: ${authBreakdownResult.aggregations.authenticated.doc_count}`);
        console.log(`   - Unauthenticated: ${authBreakdownResult.aggregations.unauthenticated.doc_count}`);
        console.log(`   - Active users from activity logs: ${byUserData.length}`);
        console.log(`   - Active users from funnel: ${funnelData.userFunnel.length}`);
        console.log(`   - Recent logins: ${recentLoginsResult.hits.hits.length}`);
        
        // ==========================================
        // 5. Compile final response
        // ==========================================
        const response = {
            nodeInfo: {
                baseUrl: process.env.PUBLIC_API_BASE_URL,
                organization: req.nodeOrganization ? {
                    name: req.nodeOrganization.data?.name,
                    handle: req.nodeOrganization.data?.orgHandle,
                    did: req.nodeOrganization.oip?.did
                } : null
            },
            
            timeRange: timeRange,
            generatedAt: new Date().toISOString(),
            
            users: {
                totalRegistered: registeredUsers.length,
                activeUsers: funnelData.userFunnel.length,
                users: registeredUsers.map(u => ({
                    userId: u.id,
                    email: u.email,
                    publicKey: u.publicKey,
                    createdAt: u.createdAt,
                    subscriptionStatus: u.subscriptionStatus,
                    isAdmin: u.isAdmin,
                    importedWallet: u.importedWallet
                }))
            },
            
            // NEW: FitnessAlly-specific funnel analytics
            fitnessAllyFunnel: {
                summary: funnelData.summary,
                funnelStages: funnelData.funnelStages,
                userFunnel: funnelData.userFunnel
            },
            
            activity: {
                totalRequests: totalActivityResult.count,
                authenticatedRequests: authBreakdownResult.aggregations.authenticated.doc_count,
                unauthenticatedRequests: authBreakdownResult.aggregations.unauthenticated.doc_count,
                
                byRequestType: activityByTypeResult.aggregations.by_request_type.buckets.map(bucket => ({
                    type: bucket.key,
                    count: bucket.doc_count,
                    percentage: ((bucket.doc_count / totalActivityResult.count) * 100).toFixed(1) + '%'
                })),
                
                byUser: byUserData,
                
                topEndpoints: topEndpointsResult.aggregations.top_endpoints.buckets.map(bucket => ({
                    endpoint: bucket.key,
                    count: bucket.doc_count,
                    avgDuration: Math.round(bucket.avg_duration?.value || 0),
                    successRate: ((bucket.success_rate?.value || 0) * 100).toFixed(2) + '%'
                })),
                
                errorRateOverTime: errorRateResult.aggregations.errors_over_time.buckets.map(bucket => ({
                    timestamp: bucket.key_as_string,
                    errorRate: ((bucket.error_rate?.value || 0) * 100).toFixed(2) + '%'
                }))
            },
            
            recentLogins: recentLoginsResult.hits.hits.map(hit => ({
                timestamp: hit._source.timestamp,
                email: hit._source.userEmail,
                ip: hit._source.ip,
                userAgent: hit._source.userAgent
            }))
        };
        
        // Include detailed logs if requested
        if (includeDetails === 'true') {
            const detailedLogsResult = await elasticClient.search({
                index: 'user_activity',
                body: {
                    query: baseQuery,
                    size: 1000,
                    sort: [{ timestamp: 'desc' }]
                }
            });
            response.detailedLogs = detailedLogsResult.hits.hits.map(hit => hit._source);
        }
        
        res.status(200).json(response);
        
    } catch (error) {
        console.error('❌ Error generating node analytics:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * Get FitnessAlly-specific funnel data by analyzing GUN records
 * 
 * FitnessAlly Funnel:
 * 1. Registered - User created an account
 * 2. Profile Started - Created userFitnessProfile record
 * 3. Questions Answered - userFitnessProfile has fitness_goals
 * 4. Meals Selected - userFitnessProfile has selected_meals  
 * 5. Equipment Selected - userFitnessProfile has selected_equipment
 * 6. Plan Generated - Has workoutSchedule and mealPlanDaily records
 * 7. Plan Regenerated - Has multiple sets of workout/meal records
 */
async function getFitnessAllyFunnelData(timeFilter, publicKeyToUser) {
    try {
        const recordTypesToCheck = ['userFitnessProfile', 'workoutSchedule', 'mealPlanDaily'];
        
        const query = {
            bool: {
                must: [
                    { prefix: { 'oip.did.keyword': 'did:gun:' } },
                    { terms: { 'oip.recordType': recordTypesToCheck } }
                ]
            }
        };
        
        if (timeFilter) {
            query.bool.must.push({
                range: { 'oip.indexedAt': { gte: timeFilter } }
            });
        }
        
        const gunRecordsResult = await elasticClient.search({
            index: 'records',
            body: {
                query: query,
                size: 5000,
                _source: ['oip.did', 'oip.recordType', 'oip.indexedAt', 'data']
            }
        });
        
        console.log(`📊 [Funnel] Found ${gunRecordsResult.hits.hits.length} GUN records for funnel analysis`);
        
        // Group records by user (extract user identifier from GUN soul)
        const userRecords = {};
        
        gunRecordsResult.hits.hits.forEach(hit => {
            const did = hit._source.oip?.did || '';
            const recordType = hit._source.oip?.recordType;
            const data = hit._source.data || {};
            
            const match = did.match(/did:gun:([a-f0-9]+):/i);
            if (!match) return;
            
            const pubKeyHash = match[1];
            
            if (!userRecords[pubKeyHash]) {
                userRecords[pubKeyHash] = {
                    pubKeyHash: pubKeyHash,
                    records: [],
                    userFitnessProfile: null,
                    workoutSchedules: [],
                    mealPlanDailies: []
                };
            }
            
            userRecords[pubKeyHash].records.push({
                did: did,
                recordType: recordType,
                indexedAt: hit._source.oip?.indexedAt,
                data: data
            });
            
            if (recordType === 'userFitnessProfile') {
                if (!userRecords[pubKeyHash].userFitnessProfile || 
                    hit._source.oip?.indexedAt > userRecords[pubKeyHash].userFitnessProfile.indexedAt) {
                    userRecords[pubKeyHash].userFitnessProfile = {
                        did: did,
                        indexedAt: hit._source.oip?.indexedAt,
                        data: data
                    };
                }
            } else if (recordType === 'workoutSchedule') {
                userRecords[pubKeyHash].workoutSchedules.push({
                    did: did,
                    indexedAt: hit._source.oip?.indexedAt,
                    scheduledDate: data.workoutSchedule?.scheduled_date
                });
            } else if (recordType === 'mealPlanDaily') {
                userRecords[pubKeyHash].mealPlanDailies.push({
                    did: did,
                    indexedAt: hit._source.oip?.indexedAt,
                    mealDate: data.mealPlanDaily?.meal_date
                });
            }
        });
        
        // Calculate funnel stage for each user
        const userFunnel = [];
        const funnelCounts = {
            registered: 0,
            profileStarted: 0,
            questionsAnswered: 0,
            mealsSelected: 0,
            equipmentSelected: 0,
            planGenerated: 0,
            planRegenerated: 0
        };
        
        Object.values(userRecords).forEach(userData => {
            const profile = userData.userFitnessProfile?.data?.userFitnessProfile || {};
            
            let funnelStage = 'profileStarted';
            let stageDetails = {};
            
            const hasGoals = profile.fitness_goals && 
                            (Array.isArray(profile.fitness_goals) ? profile.fitness_goals.length > 0 : profile.fitness_goals);
            
            const hasSelectedMeals = profile.selected_meals && 
                                     (Array.isArray(profile.selected_meals) ? profile.selected_meals.length > 0 : profile.selected_meals);
            
            const hasEquipment = profile.selected_equipment && 
                                 (Array.isArray(profile.selected_equipment) ? profile.selected_equipment.length > 0 : profile.selected_equipment);
            
            const hasWorkouts = userData.workoutSchedules.length > 0;
            const hasMeals = userData.mealPlanDailies.length > 0;
            const hasPlan = hasWorkouts || hasMeals;
            
            // Count unique generation batches
            const allRecordTimes = [
                ...userData.workoutSchedules.map(r => r.indexedAt),
                ...userData.mealPlanDailies.map(r => r.indexedAt)
            ].filter(t => t).sort();
            
            let generationCount = 0;
            if (allRecordTimes.length > 0) {
                generationCount = 1;
                let lastTime = new Date(allRecordTimes[0]).getTime();
                for (let i = 1; i < allRecordTimes.length; i++) {
                    const thisTime = new Date(allRecordTimes[i]).getTime();
                    if (thisTime - lastTime > 5 * 60 * 1000) {
                        generationCount++;
                    }
                    lastTime = thisTime;
                }
            }
            
            // Set funnel stage based on progress
            if (generationCount > 1) {
                funnelStage = 'planRegenerated';
                funnelCounts.planRegenerated++;
            } else if (hasPlan) {
                funnelStage = 'planGenerated';
                funnelCounts.planGenerated++;
            } else if (hasEquipment) {
                funnelStage = 'equipmentSelected';
                funnelCounts.equipmentSelected++;
            } else if (hasSelectedMeals) {
                funnelStage = 'mealsSelected';
                funnelCounts.mealsSelected++;
            } else if (hasGoals) {
                funnelStage = 'questionsAnswered';
                funnelCounts.questionsAnswered++;
            } else {
                funnelCounts.profileStarted++;
            }
            
            stageDetails = {
                hasGoals: hasGoals,
                hasSelectedMeals: hasSelectedMeals,
                hasEquipment: hasEquipment,
                workoutCount: userData.workoutSchedules.length,
                mealPlanCount: userData.mealPlanDailies.length,
                generationCount: generationCount
            };
            
            userFunnel.push({
                pubKeyHash: userData.pubKeyHash,
                funnelStage: funnelStage,
                stageDetails: stageDetails,
                profileCreated: userData.userFitnessProfile?.indexedAt,
                lastActivity: allRecordTimes.length > 0 ? allRecordTimes[allRecordTimes.length - 1] : userData.userFitnessProfile?.indexedAt
            });
        });
        
        // Sort by last activity (most recent first)
        userFunnel.sort((a, b) => {
            const dateA = new Date(a.lastActivity || 0).getTime();
            const dateB = new Date(b.lastActivity || 0).getTime();
            return dateB - dateA;
        });
        
        const summary = {
            totalUsersWithProfiles: userFunnel.length,
            completedFunnel: funnelCounts.planGenerated + funnelCounts.planRegenerated,
            completionRate: userFunnel.length > 0 
                ? ((funnelCounts.planGenerated + funnelCounts.planRegenerated) / userFunnel.length * 100).toFixed(1) + '%'
                : '0%'
        };
        
        const funnelStages = [
            { stage: 'profileStarted', label: '📝 Profile Started', count: funnelCounts.profileStarted },
            { stage: 'questionsAnswered', label: '❓ Questions Answered', count: funnelCounts.questionsAnswered },
            { stage: 'mealsSelected', label: '🍽️ Meals Selected', count: funnelCounts.mealsSelected },
            { stage: 'equipmentSelected', label: '🏋️ Equipment Selected', count: funnelCounts.equipmentSelected },
            { stage: 'planGenerated', label: '✅ Plan Generated', count: funnelCounts.planGenerated },
            { stage: 'planRegenerated', label: '🔄 Plan Regenerated', count: funnelCounts.planRegenerated }
        ];
        
        return {
            summary: summary,
            funnelStages: funnelStages,
            userFunnel: userFunnel
        };
        
    } catch (error) {
        console.error('❌ Error getting funnel data:', error);
        return {
            summary: { totalUsersWithProfiles: 0, completedFunnel: 0, completionRate: '0%' },
            funnelStages: [],
            userFunnel: [],
            error: error.message
        };
    }
}

function calculateTimeFilter(timeRange) {
    const now = new Date();
    
    switch (timeRange) {
        case '24h':
            return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        case '7d':
            return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        case '30d':
            return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        case '90d':
            return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
        case 'all':
            return null;
        default:
            return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }
}

/**
 * GET /api/admin/user-sessions/:userId
 * 
 * Get detailed session history for a specific user
 */
router.get('/user-sessions/:userId', authenticateToken, validateNodeAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 100, offset = 0 } = req.query;
        
        const userResult = await elasticClient.get({
            index: 'users',
            id: userId
        });
        
        const user = userResult._source;
        
        const loginsResult = await elasticClient.search({
            index: 'user_activity',
            body: {
                query: {
                    bool: {
                        must: [
                            { term: { userId: userId } },
                            { term: { requestType: 'user_login' } }
                        ]
                    }
                },
                size: parseInt(limit),
                from: parseInt(offset),
                sort: [{ timestamp: 'desc' }]
            }
        });
        
        const activityResult = await elasticClient.search({
            index: 'user_activity',
            body: {
                query: { term: { userId: userId } },
                size: 0,
                aggs: {
                    by_date: {
                        date_histogram: { field: 'timestamp', calendar_interval: 'day' }
                    },
                    by_request_type: {
                        terms: { field: 'requestType', size: 50 }
                    }
                }
            }
        });
        
        res.status(200).json({
            user: {
                userId: userId,
                email: user.email,
                publicKey: user.publicKey,
                createdAt: user.createdAt,
                subscriptionStatus: user.subscriptionStatus
            },
            sessions: {
                totalLogins: loginsResult.hits.total.value,
                recentLogins: loginsResult.hits.hits.map(hit => ({
                    timestamp: hit._source.timestamp,
                    ip: hit._source.ip,
                    userAgent: hit._source.userAgent,
                    success: hit._source.success
                }))
            },
            activity: {
                activityByDate: activityResult.aggregations.by_date.buckets.map(bucket => ({
                    date: bucket.key_as_string,
                    count: bucket.doc_count
                })),
                activityByType: activityResult.aggregations.by_request_type.buckets.map(bucket => ({
                    type: bucket.key,
                    count: bucket.doc_count
                }))
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching user sessions:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * GET /api/admin/user-funnel/:pubKeyHash
 * 
 * Get detailed funnel data for a specific user by their pubKeyHash
 */
router.get('/user-funnel/:pubKeyHash', authenticateToken, validateNodeAdmin, async (req, res) => {
    try {
        const { pubKeyHash } = req.params;
        
        const userRecordsResult = await elasticClient.search({
            index: 'records',
            body: {
                query: {
                    bool: {
                        must: [
                            { prefix: { 'oip.did.keyword': `did:gun:${pubKeyHash}:` } }
                        ]
                    }
                },
                size: 1000,
                sort: [{ 'oip.indexedAt': 'asc' }],
                _source: ['oip.did', 'oip.recordType', 'oip.indexedAt', 'data']
            }
        });
        
        const records = userRecordsResult.hits.hits.map(hit => ({
            did: hit._source.oip?.did,
            recordType: hit._source.oip?.recordType,
            indexedAt: hit._source.oip?.indexedAt,
            data: hit._source.data
        }));
        
        const byType = {};
        records.forEach(r => {
            if (!byType[r.recordType]) byType[r.recordType] = [];
            byType[r.recordType].push(r);
        });
        
        const timeline = records.map(r => ({
            time: r.indexedAt,
            event: r.recordType,
            did: r.did,
            details: summarizeRecordData(r.recordType, r.data)
        })).sort((a, b) => new Date(a.time) - new Date(b.time));
        
        res.status(200).json({
            pubKeyHash: pubKeyHash,
            totalRecords: records.length,
            recordsByType: Object.keys(byType).reduce((acc, type) => {
                acc[type] = byType[type].length;
                return acc;
            }, {}),
            timeline: timeline,
            records: records
        });
        
    } catch (error) {
        console.error('❌ Error fetching user funnel:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message
        });
    }
});

function summarizeRecordData(recordType, data) {
    if (!data) return {};
    
    switch (recordType) {
        case 'userFitnessProfile':
            const profile = data.userFitnessProfile || {};
            return {
                hasGoals: Boolean(profile.fitness_goals),
                hasMeals: Boolean(profile.selected_meals),
                hasEquipment: Boolean(profile.selected_equipment),
                goalCount: Array.isArray(profile.fitness_goals) ? profile.fitness_goals.length : 0,
                mealCount: Array.isArray(profile.selected_meals) ? profile.selected_meals.length : 0
            };
        case 'workoutSchedule':
            const workout = data.workoutSchedule || {};
            return {
                scheduledDate: workout.scheduled_date,
                hasWorkoutRef: Boolean(workout.workout_reference)
            };
        case 'mealPlanDaily':
            const meal = data.mealPlanDaily || {};
            return {
                mealDate: meal.meal_date,
                hasMealRef: Boolean(meal.meal_reference)
            };
        default:
            return {};
    }
}

module.exports = router;
