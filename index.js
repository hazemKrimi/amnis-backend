require('dotenv').config();

const app = require('express')();
const cors = require('cors');

app.use(cors());

const http = require('http').createServer(app);
const io = require('socket.io')(http);
const kurento = require('kurento-client');

let candidatesQueue = {};

io.on('connection', socket => {
    socket.on('error', err => {
        console.log(`Error occured: ${err}`);
        socket.disconnect();
    });

    socket.on('streamer', message => {
        try {
            const messageData = JSON.parse(message);
            socket.join(messageData.room);
            startStream(messageData.room, socket, messageData.sdpOffer, sdpAnswer => {
                socket.emit('streamerResponse', JSON.stringify({
                    sdpAnswer
                }));
            });
        } catch(err) {
            socket.emit('error', err);
        }
    });

    socket.on('stop', message => {
        const messageData = JSON.parse(message);
        stop(messageData.room);
    });

    socket.on('viewer', message => {
        try {
            const messageData = JSON.parse(message);
            socket.join(messageData.room);
            view(messageData.room, socket, messageData.sdpOffer, sdpAnswer => {
                socket.emit('viewerResponse', JSON.stringify({
                    sdpAnswer
                }));
            });
        } catch(err) {
            socket.emit('error', err);
        }
    });

    socket.on('onIceCandidate', message => {
        const messageData = JSON.parse(message);
        iceCandidate(messageData.room, socket, messageData.candidate);
    });
});

const startStream = (room, socket, sdpOffer, callback) => {
    try {
        clearCandidatesQueue(room);
        getKurentoClient(kurentoClient => {
            kurentoClient.create('MediaPipeline', (err, pipeline) => {
                if (err) throw err;
                io.sockets.adapter.rooms[room].streamer = socket.id;
                io.sockets.adapter.rooms[room].viewers = [];
                io.sockets.adapter.rooms[room].pipeline = pipeline;
                pipeline.create('WebRtcEndpoint', (err, webRtcEndpoint) => {
                    if (err) throw err;
                    io.sockets.adapter.rooms[room].webRtcEndpoint = webRtcEndpoint;
                    if (candidatesQueue[room]) {
                        while (candidatesQueue[room].length) {
                            let candidate = candidatesQueue[room].shift();
                            webRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    webRtcEndpoint.on('OnIceCandidate', event => {
                        let candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        socket.emit('iceCandidate', JSON.stringify({
                            candidate,
                            room
                        }));
                    });

                    webRtcEndpoint.processOffer(sdpOffer, (err, sdpAnswer) => {
                        if (err) throw err;
                        callback(sdpAnswer);
                    });

                    webRtcEndpoint.gatherCandidates(err => {
                        if (err) throw err;
                    });
                });
            });
        });
    } catch(err) {
        throw err;
    }
};

const view = (room, socket, sdpOffer, callback) => {
    try {
        clearCandidatesQueue(room);
        if (io.sockets.adapter.rooms[room]) io.sockets.adapter.rooms[room].pipeline.create('WebRtcEndpoint', (err, webRtcEndpoint) => {
            if (err) throw err;
            io.sockets.adapter.rooms[room].viewers.push({ id: socket.id, webRtcEndpoint, socket });
            if (candidatesQueue[room]) {
                while (candidatesQueue[room].length) {
                    let candidate = candidatesQueue[room].shift();
                    webRtcEndpoint.addIceCandidate(candidate);
                }
            }

            webRtcEndpoint.on('OnIceCandidate', event => {
                let candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                socket.emit('iceCandidate', JSON.stringify({
                    room,
                    candidate
                }));
            });

            webRtcEndpoint.processOffer(sdpOffer, (err, sdpAnswer) => {
                if (err) throw err;
                io.sockets.adapter.rooms[room].webRtcEndpoint.connect(webRtcEndpoint, err => {
                    webRtcEndpoint.gatherCandidates(err => {
                        if (err) throw err;
                    });

                    callback(sdpAnswer);
                });
            });
        });
    } catch(err) {
        throw err;
    }
};

const getKurentoClient = (callback) => {
    try {
        kurento(process.env.KMS, (err, kurentoClient) => {
            if (err) throw err;
            callback(kurentoClient);
        });
    } catch(err) {
        throw err;
    }
};

const clearCandidatesQueue = room => {
    if (candidatesQueue[room]) {
        delete candidatesQueue[room];
    }
};

const stop = room => {
    if (io.sockets.adapter.rooms[room]) io.sockets.adapter.rooms[room].pipeline.release();
    if (io.sockets.adapter.rooms[room]) io.sockets.adapter.rooms[room].streamer = null;
    if (io.sockets.adapter.rooms[room]) io.sockets.adapter.rooms[room].viewers.forEach(viewer => {
        viewer.socket.emit('stopCommunication');
    });
    if (io.sockets.adapter.rooms[room]) io.sockets.adapter.rooms[room].viewers = [];
    clearCandidatesQueue(room);
};

const iceCandidate = (room, socket, _candidate) => {
    let candidate = kurento.getComplexType('IceCandidate')(_candidate);
    if (io.sockets.adapter.rooms[room].streamer && io.sockets.adapter.rooms[room].streamer === socket.id) io.sockets.adapter.rooms[room].webRtcEndpoint.addIceCandidate(candidate);
    else if (io.sockets.adapter.rooms[room].viewers && io.sockets.adapter.rooms[room].viewers.find(viewer => socket.id === viewer.id)) {
        io.sockets.adapter.rooms[room].viewers.find(viewer => socket.id === viewer.id).webRtcEndpoint.addIceCandidate(candidate);
    } else {
        if (!candidatesQueue[room]) {
            candidatesQueue[room] = [];
        }
        candidatesQueue[room].push(candidate);
    }
};

http.listen(5000, () => {
    console.log('Server listening on localhost:5000');
});