const { Server } = require('socket.io');
let io;

module.exports = {
    init: (httpServer) => {
        io = new Server(httpServer, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });

        io.on('connection', (socket) => {
            console.log('Client connected');

            // Join user-specific room when they authenticate
            socket.on('authenticate', (userId) => {
                socket.join(`user:${userId}`);
                console.log(`User ${userId} joined their room`);
            });

            socket.on('disconnect', () => {
                console.log('Client disconnected');
            });
        });

        return io;
    },
    getIO: () => {
        if (!io) {
            throw new Error('Socket.io not initialized!');
        }
        return io;
    }
}; 