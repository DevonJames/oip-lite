/**
 * In-memory job tracker for async recipe publishing
 * Tracks status, progress, and results of long-running recipe publish jobs
 */

const crypto = require('crypto');

// In-memory job storage
const jobs = new Map();

// Job cleanup after 1 hour
const JOB_RETENTION_TIME = 60 * 60 * 1000; // 1 hour

/**
 * Create a new job
 * @param {string} type - Job type (e.g., 'recipe_publish')
 * @returns {string} jobId
 */
function createJob(type = 'recipe_publish') {
  const jobId = `${type}_${crypto.randomBytes(8).toString('hex')}`;
  
  jobs.set(jobId, {
    jobId,
    type,
    status: 'pending',
    progress: 0,
    message: 'Job initiated...',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: null
  });
  
  console.log(`📋 Created job: ${jobId}`);
  return jobId;
}

/**
 * Update job status and progress
 * @param {string} jobId
 * @param {Object} updates - { status, progress, message, result, error }
 */
function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  
  if (!job) {
    console.warn(`⚠️ Job not found: ${jobId}`);
    return false;
  }
  
  Object.assign(job, {
    ...updates,
    updatedAt: Date.now()
  });
  
  jobs.set(jobId, job);
  console.log(`📊 Updated job ${jobId}: status=${job.status}, progress=${job.progress}%, message="${job.message}"`);
  return true;
}

/**
 * Get job status
 * @param {string} jobId
 * @returns {Object|null} job data
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Mark job as completed
 * @param {string} jobId
 * @param {Object} result
 */
function completeJob(jobId, result) {
  updateJob(jobId, {
    status: 'completed',
    progress: 100,
    message: 'Job completed successfully',
    result
  });
  
  // Schedule cleanup
  setTimeout(() => {
    jobs.delete(jobId);
    console.log(`🗑️ Cleaned up completed job: ${jobId}`);
  }, JOB_RETENTION_TIME);
}

/**
 * Mark job as failed
 * @param {string} jobId
 * @param {Error} error
 */
function failJob(jobId, error) {
  updateJob(jobId, {
    status: 'failed',
    message: `Job failed: ${error.message}`,
    error: {
      message: error.message,
      stack: error.stack
    }
  });
  
  // Schedule cleanup
  setTimeout(() => {
    jobs.delete(jobId);
    console.log(`🗑️ Cleaned up failed job: ${jobId}`);
  }, JOB_RETENTION_TIME);
}

/**
 * Update job progress
 * @param {string} jobId
 * @param {number} progress - 0-100
 * @param {string} message
 */
function updateProgress(jobId, progress, message) {
  updateJob(jobId, {
    status: 'processing',
    progress: Math.min(100, Math.max(0, progress)),
    message
  });
}

/**
 * Cleanup old jobs (run periodically)
 */
function cleanupOldJobs() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.updatedAt > JOB_RETENTION_TIME) {
      jobs.delete(jobId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🗑️ Cleaned up ${cleaned} old jobs`);
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupOldJobs, 10 * 60 * 1000);

module.exports = {
  createJob,
  updateJob,
  getJob,
  completeJob,
  failJob,
  updateProgress
};
