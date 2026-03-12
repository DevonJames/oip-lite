const { create } = require('ipfs-http-client');
const fs = require('fs');

const ipfs = create();

const uploadToIPFS = async (filePath) => {
    const file = fs.readFileSync(filePath);
    const { cid } = await ipfs.add(file);
    return cid.toString();
};

module.exports = {
    uploadToIPFS,
    ipfs
};
