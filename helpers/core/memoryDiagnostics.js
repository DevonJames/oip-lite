/**
 * Safe Memory Diagnostics System
 * 
 * This module provides safe, read-only memory profiling that:
 * - Tracks memory growth by operation type
 * - Identifies memory spikes correlated with specific routes/operations
 * - Uses minimal memory overhead
 * - Can be easily enabled/disabled
 * - Provides actionable diagnostic data
 */

const v8 = require('v8');
const fs = require('fs').promises;
const path = require('path');

class MemoryDiagnostics {
    constructor() {
        this.enabled = process.env.MEMORY_DIAGNOSTICS_ENABLED === 'true';
        this.operationSnapshots = new Map(); // operation type -> array of memory deltas
        this.routeMemoryMap = new Map(); // route -> memory growth stats
        this.baselineMemory = null;
        this.lastSnapshot = null;
        this.snapshotInterval = null;
        this.logFilePath = path.join(__dirname, '../logs/memory-diagnostics.log');
        this.dumpDirectory = path.join(__dirname, '../logs/heap-dumps');
        
        // Track operation categories
        this.operationCategories = {
            'api_records': [],
            'api_voice': [],
            'api_alfred': [],
            'gun_sync': [],
            'elasticsearch_query': [],
            'graphql_query': [],
            'static_media': [],
            'gun_deletion': [],
            'keepdb_cycle': [],
            'other': []
        };
        
        // Memory thresholds for automatic heap dumps (in MB)
        // Can be disabled via DISABLE_HEAP_DUMPS=true (heap dumps are large and can impact performance)
        this.heapDumpsDisabled = process.env.DISABLE_HEAP_DUMPS === 'true';
        this.heapDumpThresholds = [2048, 4096, 6144, 8192, 10240]; // 2GB, 4GB, 6GB, 8GB, 10GB
        this.heapDumpsTaken = new Set();
        
        if (this.enabled) {
            console.log('🔬 [Memory Diagnostics] ENABLED - Safe profiling active');
            if (this.heapDumpsDisabled) {
                console.log('🔬 [Memory Diagnostics] Heap dumps DISABLED (DISABLE_HEAP_DUMPS=true)');
            }
            this.initialize();
        }
    }
    
    async initialize() {
        try {
            // Create directories if they don't exist
            try {
                await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
                await fs.mkdir(this.dumpDirectory, { recursive: true });
                console.log('📁 [Memory Diagnostics] Created log directories');
            } catch (dirError) {
                console.warn('⚠️  [Memory Diagnostics] Could not create log directories:', dirError.message);
                console.warn('⚠️  [Memory Diagnostics] Will fallback to console-only logging');
            }
            
            // Take baseline memory snapshot
            this.baselineMemory = this.captureMemorySnapshot();
            this.lastSnapshot = this.baselineMemory;
            
            // Log initial state
            await this.logDiagnostic('INIT', `Memory Diagnostics ENABLED - Baseline: ${this.formatMemory(this.baselineMemory)}`);
            
            // Start periodic monitoring (every 60 seconds)
            this.snapshotInterval = setInterval(() => {
                this.periodicCheck();
            }, 60000);
            
            console.log('🔬 [Memory Diagnostics] Initialized successfully - Monitoring every 60s');
            console.log(`📝 [Memory Diagnostics] Log file: ${this.logFilePath}`);
            console.log(`💾 [Memory Diagnostics] Heap dumps: ${this.dumpDirectory}`);
        } catch (error) {
            console.error('❌ [Memory Diagnostics] Failed to initialize:', error.message);
            console.error('❌ [Memory Diagnostics] Stack:', error.stack);
            this.enabled = false;
        }
    }
    
    captureMemorySnapshot() {
        const mem = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        
        return {
            timestamp: Date.now(),
            rss: mem.rss,
            heapTotal: mem.heapTotal,
            heapUsed: mem.heapUsed,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
            heapLimit: heapStats.heap_size_limit,
            mallocedMemory: heapStats.malloced_memory,
            peakMallocedMemory: heapStats.peak_malloced_memory
        };
    }
    
    formatMemory(snapshot) {
        if (!snapshot) return 'N/A';
        return `RSS: ${(snapshot.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(snapshot.heapUsed / 1024 / 1024).toFixed(1)}MB, External: ${(snapshot.external / 1024 / 1024).toFixed(1)}MB`;
    }
    
    categorizeOperation(operationType) {
        if (!operationType) return 'other';
        
        const type = operationType.toLowerCase();
        if (type.includes('records') || type.includes('/api/records')) return 'api_records';
        if (type.includes('voice') || type.includes('/api/voice')) return 'api_voice';
        if (type.includes('alfred') || type.includes('/api/alfred')) return 'api_alfred';
        if (type.includes('gun_sync') || type.includes('sync')) return 'gun_sync';
        if (type.includes('elasticsearch') || type.includes('es_query')) return 'elasticsearch_query';
        if (type.includes('graphql')) return 'graphql_query';
        if (type.includes('media') || type.includes('gif')) return 'static_media';
        if (type.includes('deletion') || type.includes('delete')) return 'gun_deletion';
        if (type.includes('keepdb') || type.includes('arweave_check')) return 'keepdb_cycle';
        
        return 'other';
    }
    
    /**
     * Track memory before and after an operation
     * Returns a cleanup function to call after the operation completes
     */
    trackOperation(operationType, operationDetails = '') {
        if (!this.enabled) return () => {};
        
        const startSnapshot = this.captureMemorySnapshot();
        const category = this.categorizeOperation(operationType);
        
        return async () => {
            // Small delay to allow GC to run if it wants to
            await new Promise(resolve => setImmediate(resolve));
            
            const endSnapshot = this.captureMemorySnapshot();
            const delta = {
                rss: endSnapshot.rss - startSnapshot.rss,
                heapUsed: endSnapshot.heapUsed - startSnapshot.heapUsed,
                external: endSnapshot.external - startSnapshot.external,
                duration: endSnapshot.timestamp - startSnapshot.timestamp
            };
            
            // Store in category
            this.operationCategories[category].push({
                type: operationType,
                details: operationDetails,
                delta,
                timestamp: endSnapshot.timestamp
            });
            
            // Keep only last 100 operations per category to prevent memory buildup
            if (this.operationCategories[category].length > 100) {
                this.operationCategories[category].shift();
            }
            
            // If significant growth (>10MB external or >50MB RSS), log it
            if (Math.abs(delta.external) > 10 * 1024 * 1024 || Math.abs(delta.rss) > 50 * 1024 * 1024) {
                await this.logDiagnostic('GROWTH', `${operationType} (${operationDetails}): RSS ${this.formatBytes(delta.rss)}, External ${this.formatBytes(delta.external)}`);
            }
            
            // Check if we've crossed a heap dump threshold
            this.checkHeapDumpThreshold(endSnapshot);
        };
    }
    
    formatBytes(bytes) {
        const sign = bytes >= 0 ? '+' : '';
        return `${sign}${(bytes / 1024 / 1024).toFixed(1)}MB`;
    }
    
    async periodicCheck() {
        if (!this.enabled) return;
        
        try {
            const currentSnapshot = this.captureMemorySnapshot();
            
            // Calculate growth since last snapshot
            const deltaFromLast = {
                rss: currentSnapshot.rss - this.lastSnapshot.rss,
                heapUsed: currentSnapshot.heapUsed - this.lastSnapshot.heapUsed,
                external: currentSnapshot.external - this.lastSnapshot.external,
                timeDelta: currentSnapshot.timestamp - this.lastSnapshot.timestamp
            };
            
            // Calculate growth rate (MB/min)
            const minutesElapsed = deltaFromLast.timeDelta / 60000;
            const growthRates = {
                rss: (deltaFromLast.rss / 1024 / 1024) / minutesElapsed,
                heapUsed: (deltaFromLast.heapUsed / 1024 / 1024) / minutesElapsed,
                external: (deltaFromLast.external / 1024 / 1024) / minutesElapsed
            };
            
            // Log periodic summary
            await this.logDiagnostic('PERIODIC', 
                `Current: ${this.formatMemory(currentSnapshot)} | ` +
                `Growth rate: RSS ${growthRates.rss.toFixed(1)} MB/min, External ${growthRates.external.toFixed(1)} MB/min`
            );
            
            // Generate category summary if significant growth
            if (Math.abs(growthRates.external) > 50 || Math.abs(growthRates.rss) > 100) {
                await this.generateCategorySummary();
            }
            
            this.lastSnapshot = currentSnapshot;
        } catch (error) {
            console.error('❌ [Memory Diagnostics] Periodic check failed:', error.message);
        }
    }
    
    async generateCategorySummary() {
        const summary = ['=== OPERATION CATEGORY SUMMARY (Last 60s) ==='];
        
        for (const [category, operations] of Object.entries(this.operationCategories)) {
            if (operations.length === 0) continue;
            
            // Only look at operations from the last 60 seconds
            const recentOps = operations.filter(op => Date.now() - op.timestamp < 60000);
            if (recentOps.length === 0) continue;
            
            const totalDelta = recentOps.reduce((acc, op) => ({
                rss: acc.rss + op.delta.rss,
                heapUsed: acc.heapUsed + op.delta.heapUsed,
                external: acc.external + op.delta.external
            }), { rss: 0, heapUsed: 0, external: 0 });
            
            summary.push(
                `\n[${category}] ${recentOps.length} operations:` +
                `\n  Total Growth: RSS ${this.formatBytes(totalDelta.rss)}, External ${this.formatBytes(totalDelta.external)}` +
                `\n  Avg per op: RSS ${this.formatBytes(totalDelta.rss / recentOps.length)}, External ${this.formatBytes(totalDelta.external / recentOps.length)}`
            );
            
            // Show top 3 operations by external memory growth
            const topOps = recentOps
                .sort((a, b) => b.delta.external - a.delta.external)
                .slice(0, 3);
            
            if (topOps.length > 0 && topOps[0].delta.external > 1024 * 1024) { // > 1MB
                summary.push('  Top operations:');
                topOps.forEach((op, i) => {
                    summary.push(`    ${i + 1}. ${op.type} (${op.details}): External ${this.formatBytes(op.delta.external)}`);
                });
            }
        }
        
        summary.push('===========================================\n');
        
        await this.logDiagnostic('SUMMARY', summary.join('\n'));
    }
    
    async checkHeapDumpThreshold(snapshot) {
        // Skip if heap dumps are disabled
        if (this.heapDumpsDisabled) return;
        
        const rssMB = snapshot.rss / 1024 / 1024;
        
        for (const threshold of this.heapDumpThresholds) {
            if (rssMB >= threshold && !this.heapDumpsTaken.has(threshold)) {
                this.heapDumpsTaken.add(threshold);
                await this.takeHeapDump(`threshold_${threshold}MB`);
                await this.logDiagnostic('THRESHOLD', `Crossed ${threshold}MB threshold - heap dump taken`);
                break;
            }
        }
    }
    
    async takeHeapDump(reason = 'manual') {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `heapdump_${reason}_${timestamp}.heapsnapshot`;
            const filepath = path.join(this.dumpDirectory, filename);
            
            console.log(`🔬 [Memory Diagnostics] Taking heap dump: ${filename}`);
            
            const heapSnapshot = v8.writeHeapSnapshot(filepath);
            
            await this.logDiagnostic('HEAP_DUMP', `Created: ${filename} (${heapSnapshot})`);
            
            return filepath;
        } catch (error) {
            console.error('❌ [Memory Diagnostics] Failed to take heap dump:', error.message);
            return null;
        }
    }
    
    async logDiagnostic(level, message) {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${level}] ${message}\n`;
        
        try {
            await fs.appendFile(this.logFilePath, logLine);
        } catch (error) {
            // Fallback to console if file write fails (permissions, disk full, etc.)
            console.log(`🔬 [Memory Diagnostics] ${logLine.trim()}`);
            console.error(`⚠️  [Memory Diagnostics] Failed to write to log file: ${error.message}`);
        }
    }
    
    async generateReport() {
        if (!this.enabled) return 'Memory diagnostics not enabled';
        
        const currentSnapshot = this.captureMemorySnapshot();
        const totalGrowth = {
            rss: currentSnapshot.rss - this.baselineMemory.rss,
            heapUsed: currentSnapshot.heapUsed - this.baselineMemory.heapUsed,
            external: currentSnapshot.external - this.baselineMemory.external
        };
        
        const report = [
            '╔════════════════════════════════════════════════════════════════╗',
            '║           MEMORY DIAGNOSTICS REPORT                            ║',
            '╚════════════════════════════════════════════════════════════════╝',
            '',
            `Baseline:  ${this.formatMemory(this.baselineMemory)}`,
            `Current:   ${this.formatMemory(currentSnapshot)}`,
            `Growth:    RSS ${this.formatBytes(totalGrowth.rss)}, Heap ${this.formatBytes(totalGrowth.heapUsed)}, External ${this.formatBytes(totalGrowth.external)}`,
            '',
            '─────────────────────────────────────────────────────────────────',
            'OPERATION CATEGORY ANALYSIS:',
            '─────────────────────────────────────────────────────────────────'
        ];
        
        for (const [category, operations] of Object.entries(this.operationCategories)) {
            if (operations.length === 0) continue;
            
            const totalDelta = operations.reduce((acc, op) => ({
                rss: acc.rss + op.delta.rss,
                heapUsed: acc.heapUsed + op.delta.heapUsed,
                external: acc.external + op.delta.external
            }), { rss: 0, heapUsed: 0, external: 0 });
            
            report.push(`\n[${category}] ${operations.length} operations tracked:`);
            report.push(`  Total Growth: RSS ${this.formatBytes(totalDelta.rss)}, External ${this.formatBytes(totalDelta.external)}`);
            report.push(`  Avg per op:   RSS ${this.formatBytes(totalDelta.rss / operations.length)}, External ${this.formatBytes(totalDelta.external / operations.length)}`);
        }
        
        report.push('\n─────────────────────────────────────────────────────────────────');
        report.push(`Log file: ${this.logFilePath}`);
        report.push(`Heap dumps: ${this.dumpDirectory}`);
        report.push('═════════════════════════════════════════════════════════════════\n');
        
        const reportText = report.join('\n');
        console.log(reportText);
        await this.logDiagnostic('REPORT', reportText);
        
        return reportText;
    }
    
    shutdown() {
        if (this.snapshotInterval) {
            clearInterval(this.snapshotInterval);
        }
        console.log('🔬 [Memory Diagnostics] Shutdown');
    }
}

// Singleton instance
const memoryDiagnostics = new MemoryDiagnostics();

// Graceful shutdown
process.on('SIGTERM', () => memoryDiagnostics.shutdown());
process.on('SIGINT', () => memoryDiagnostics.shutdown());

module.exports = memoryDiagnostics;

