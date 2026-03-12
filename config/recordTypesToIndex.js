// Configuration for controlling which record types get indexed.
// Modes:
// - 'all': index all record types (default)
// - 'blacklist': index everything except types listed in `blacklist`
// - 'whitelist': only index types listed in `whitelist`

module.exports = {
  // One of: 'all' | 'blacklist' | 'whitelist'
  mode: process.env.RECORD_TYPE_INDEX_MODE || 'all',

  // Record types to exclude when mode === 'blacklist'
  // Example: ['podcast', 'podcastShow']
  blacklist: (process.env.RECORD_TYPE_INDEX_BLACKLIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Record types to include when mode === 'whitelist'
  // Example: ['exercise', 'workout', 'recipe', 'nutritionalInfo']
  whitelist: (process.env.RECORD_TYPE_INDEX_WHITELIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
};


