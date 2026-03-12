/**
 * Real-time Memory Leak Tracker
 * Tracks memory growth and identifies likely sources
 * 
 * DISABLED: This tracker has been replaced by the new memoryDiagnostics system
 * which is safer, more accurate, and doesn't contribute to logging overhead.
 */

const v8 = require('v8');

class MemoryLeakTracker {
    constructor(options = {}) {
        // DISABLED: This tracker is no longer active
        // It was potentially contributing to memory issues via logging and handle tracking
        this.enabled = false;
        console.log('🔍 [Memory Tracker] DISABLED - replaced by memoryDiagnostics system (set MEMORY_DIAGNOSTICS_ENABLED=true to use new system)');
        
        // Return early - all methods will be no-ops
        this.tracking = false;
    }

    start() {
        // NO-OP: Tracker disabled
        return;
    }

    stop() {
        // NO-OP: Tracker disabled
        return;
    }

    takeSample() {
        // NO-OP: Tracker disabled
        return;
        
        // MEMORY LEAK FIX: Circuit breaker - stop accessing handles when external memory is critically high
        // Accessing handles/requests during severe leaks may prevent GC from cleaning up
        let handleCount = 0;
        let requestCount = 0;
        let handleTypes = {};
        let requestTypes = {};
        
        if (memUsage.external > this.circuitBreakerThreshold) {
            if (!this.circuitBreakerActive) {
                this.circuitBreakerActive = true;
                console.warn(`🔴 [Memory Tracker] Circuit breaker activated - external memory at ${(memUsage.external / 1024 / 1024 / 1024).toFixed(1)}GB`);
                console.warn(`🔴 [Memory Tracker] Stopping handle/request tracking to avoid worsening leak`);
            }
            // Skip handle/request tracking during critical memory conditions
        } else {
            if (this.circuitBreakerActive) {
                this.circuitBreakerActive = false;
                console.log(`✅ [Memory Tracker] Circuit breaker deactivated - external memory normalized`);
            }
            
            // MEMORY LEAK FIX: Get counts without keeping references to objects
            // Storing handle/request objects prevents garbage collection
            const handles = process._getActiveHandles();
            const requests = process._getActiveRequests();
            
            // Count types immediately then discard the object references
            handleTypes = this._countTypes(handles);
            requestTypes = this._countTypes(requests);
            handleCount = handles.length;
            requestCount = requests.length;
            
            // CRITICAL FIX: Completely destroy references by replacing arrays
            // Setting length = 0 doesn't release object references!
            handles.splice(0, handles.length); // Actually removes elements
            requests.splice(0, requests.length);
        }

        const sample = {
            timestamp: Date.now(),
            rss: memUsage.rss,
            heapTotal: memUsage.heapTotal,
            heapUsed: memUsage.heapUsed,
            external: memUsage.external,
            arrayBuffers: memUsage.arrayBuffers,
            heapLimit: heapStats.heap_size_limit,
            activeHandles: handleCount,
            activeRequests: requestCount,
            
            // Store only counts, not object references
            handleTypes: handleTypes,
            requestTypes: requestTypes,
        };

        this.samples.push(sample);
        
        // MEMORY LEAK FIX: Keep max 30 samples instead of 60 to reduce memory footprint
        // With aggressive voice usage, even metadata can accumulate
        const MAX_SAMPLES = 30;
        if (this.samples.length > MAX_SAMPLES) {
            // Remove oldest samples
            this.samples.splice(0, this.samples.length - MAX_SAMPLES);
        }

        // Analyze for leaks
        if (this.samples.length >= 3) {
            this.analyzeGrowth();
        }
        
        // MEMORY LEAK FIX: Force GC after sample if external memory is very high
        if (memUsage.external > 10 * 1024 * 1024 * 1024 && global.gc) { // > 10GB
            setImmediate(() => {
                global.gc();
            });
        }
    }

    _countTypes(objects) {
        const counts = {};
        for (const obj of objects) {
            const type = obj.constructor.name;
            counts[type] = (counts[type] || 0) + 1;
        }
        return counts;
    }

    analyzeGrowth() {
        if (this.samples.length < 3) return;

        const recent = this.samples[this.samples.length - 1];
        const previous = this.samples[this.samples.length - 2];
        const oldest = this.samples[0];

        // Calculate growth rates
        const externalGrowthRecent = recent.external - previous.external;
        const externalGrowthTotal = recent.external - oldest.external;
        const timeSpan = (recent.timestamp - oldest.timestamp) / 1000 / 60; // minutes

        const externalGrowthRateMB = (externalGrowthTotal / 1024 / 1024) / timeSpan; // MB per minute

        // Check for suspicious growth
        if (externalGrowthRateMB > 50) { // > 50MB/min
            const externalMB = recent.external / 1024 / 1024;
            const growthMB = externalGrowthRecent / 1024 / 1024;
            
            console.warn(`\n🚨 [Memory Leak Tracker] EXTERNAL MEMORY LEAK DETECTED`);
            console.warn(`   Current: ${externalMB.toFixed(0)}MB`);
            console.warn(`   Growth: +${growthMB.toFixed(0)}MB in last ${(this.trackingInterval / 1000 / 60).toFixed(1)} minutes`);
            console.warn(`   Rate: ${externalGrowthRateMB.toFixed(1)} MB/min`);
            console.warn(`   Time to crash (if 32GB heap): ${((32768 - externalMB) / externalGrowthRateMB).toFixed(0)} minutes\n`);

            this.identifySuspects(recent, previous);
        }

        // Check handle/request growth
        const handleGrowth = recent.activeHandles - oldest.activeHandles;
        const requestGrowth = recent.activeRequests - oldest.activeRequests;

        if (handleGrowth > 100 || requestGrowth > 50) {
            console.warn(`\n⚠️  [Memory Leak Tracker] HANDLE/REQUEST LEAK DETECTED`);
            console.warn(`   Active Handles: ${recent.activeHandles} (+${handleGrowth})`);
            console.warn(`   Active Requests: ${recent.activeRequests} (+${requestGrowth})`);
            
            // Show which types are growing
            this._compareTypeCounts(oldest.handleTypes, recent.handleTypes, 'Handles');
            this._compareTypeCounts(oldest.requestTypes, recent.requestTypes, 'Requests');
        }
    }

    _compareTypeCounts(oldCounts, newCounts, label) {
        console.warn(`\n   ${label} growth by type:`);
        const allTypes = new Set([...Object.keys(oldCounts), ...Object.keys(newCounts)]);
        
        for (const type of allTypes) {
            const oldCount = oldCounts[type] || 0;
            const newCount = newCounts[type] || 0;
            const growth = newCount - oldCount;
            
            if (growth > 5) {
                console.warn(`     ${type}: ${oldCount} → ${newCount} (+${growth})`);
            }
        }
    }

    identifySuspects(recent, previous) {
        const suspects = [];

        // Check ArrayBuffers specifically
        const arrayBufferGrowth = recent.arrayBuffers - previous.arrayBuffers;
        if (arrayBufferGrowth > 10 * 1024 * 1024) { // > 10MB
            suspects.push({
                type: 'ArrayBuffer',
                growth: arrayBufferGrowth / 1024 / 1024,
                source: 'Likely: Axios responses (arraybuffer), Elasticsearch bulk operations'
            });
        }

        // Check if external is growing without heap growing
        const heapGrowth = recent.heapUsed - previous.heapUsed;
        const externalGrowth = recent.external - previous.external;
        
        if (externalGrowth > heapGrowth * 10) { // External growing 10x faster than heap
            suspects.push({
                type: 'External Memory (non-V8)',
                growth: externalGrowth / 1024 / 1024,
                source: 'Likely: Native modules, C++ addons, or leaked buffers'
            });
        }

        // Report suspects
        if (suspects.length > 0) {
            console.warn('\n   🔍 Likely culprits:');
            for (const suspect of suspects) {
                console.warn(`     • ${suspect.type}: +${suspect.growth.toFixed(1)}MB`);
                console.warn(`       ${suspect.source}`);
            }
        }
    }

    getReport() {
        if (this.samples.length === 0) {
            return { error: 'No samples collected yet' };
        }

        const latest = this.samples[this.samples.length - 1];
        const oldest = this.samples[0];
        const timeSpan = (latest.timestamp - oldest.timestamp) / 1000 / 60; // minutes

        return {
            samples: this.samples.length,
            timeSpan: timeSpan.toFixed(1),
            current: {
                rss: (latest.rss / 1024 / 1024).toFixed(0) + 'MB',
                heap: (latest.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
                external: (latest.external / 1024 / 1024).toFixed(0) + 'MB',
                handles: latest.activeHandles,
                requests: latest.activeRequests,
            },
            growth: {
                rss: ((latest.rss - oldest.rss) / 1024 / 1024).toFixed(0) + 'MB',
                heap: ((latest.heapUsed - oldest.heapUsed) / 1024 / 1024).toFixed(0) + 'MB',
                external: ((latest.external - oldest.external) / 1024 / 1024).toFixed(0) + 'MB',
                handles: latest.activeHandles - oldest.activeHandles,
                requests: latest.activeRequests - oldest.activeRequests,
            },
            growthRate: {
                externalMBPerMin: (((latest.external - oldest.external) / 1024 / 1024) / timeSpan).toFixed(1),
                heapMBPerMin: (((latest.heapUsed - oldest.heapUsed) / 1024 / 1024) / timeSpan).toFixed(1),
            }
        };
    }
}

// Singleton instance
let trackerInstance = null;

function getTracker(options) {
    if (!trackerInstance) {
        trackerInstance = new MemoryLeakTracker(options);
    }
    return trackerInstance;
}

module.exports = {
    MemoryLeakTracker,
    getTracker
};

