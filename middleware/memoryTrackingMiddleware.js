function trackRequestMemory(req, res, next) {
    next();
}

module.exports = { trackRequestMemory };
