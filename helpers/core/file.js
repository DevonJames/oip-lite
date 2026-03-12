const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ProgressBar = require('progress');

const ensureFilesDirectoryExists = () => {
    const filesDir = path.join(__dirname, 'files');
    if (!fs.existsSync(filesDir)) {
        fs.mkdirSync(filesDir, { recursive: true });
        console.log('Created files directory');
    } else {
        console.log('Files directory already exists');
    }
};

const makeVideoDirectory = async (youTubeID) => {
    ensureFilesDirectoryExists();
    const dir = path.join(__dirname, 'files', youTubeID);
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(dir)) {
            console.log(`Making directory: ${dir}`);
            fs.mkdir(dir, { recursive: true }, (err) => {
                if (err) {
                    console.error(`Error creating directory ${dir}:`, err);
                    reject(err);
                } else {
                    console.log(`Directory created: ${dir}`);
                    resolve(true);
                }
            });
        } else {
            console.log(`Directory already exists: ${dir}`);
            resolve(false);
        }
    });
};

const retryDownloadVideoThumbnail = async (thumbnailUrl, thumbnailPath, maxRetries) => {
    console.log("Downloading thumbnail:", thumbnailPath);
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const thumbnail = await downloadVideoThumbnail(thumbnailUrl, thumbnailPath);
            if (thumbnail) {
                return thumbnail;
            } else {
                console.log("Retrying download...");
                retries++;
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (error) {
            console.error("Error downloading thumbnail:", error);
            retries++;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    console.log("Max retries exceeded");
    return null;
};

const downloadVideoThumbnail = async (thumbnailUrl, thumbnailPath) => {
    try {
        if (fs.existsSync(thumbnailPath)) {
            console.log("Thumbnail already exists:", thumbnailPath);
            return thumbnailPath;
        } else {
            console.log('Downloading thumbnail:', thumbnailPath);
            const response = await axios({
                method: 'get',
                url: thumbnailUrl,
                responseType: 'stream',
            });
            return new Promise((resolve, reject) => {
                const totalBytes = parseInt(response.headers['content-length'], 10);
                const progressBar = new ProgressBar('Downloading [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 20,
                    total: totalBytes,
                });
                response.data
                    .on('data', (chunk) => {
                        progressBar.tick(chunk.length);
                    })
                    .pipe(fs.createWriteStream(thumbnailPath))
                    .on('finish', () => {
                        console.log('Download complete:', thumbnailPath);
                        resolve(thumbnailPath);
                    })
                    .on('error', (e) => {
                        reject(e);
                    });
            });
        }
    } catch (error) {
        console.error("Error in thumbnail download:", error);
        return null;
    }
};

module.exports = {
    ensureFilesDirectoryExists,
    makeVideoDirectory,
    retryDownloadVideoThumbnail,
    downloadVideoThumbnail
};