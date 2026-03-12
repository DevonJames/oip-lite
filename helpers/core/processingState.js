// processingState.js
let isProcessing = false;

function getIsProcessing() {
    return isProcessing;
}

function setIsProcessing(value) {
    isProcessing = value;
}

module.exports = {
    getIsProcessing,
    setIsProcessing
};