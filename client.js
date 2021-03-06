const EventEmitter = require('events').EventEmitter;
const util = require('util');
const winston = require('winston');
const net = require('net');
const BER = require('./ber.js');
const ember = require('./ember.js');

const S101Codec = require('./s101.js');


function S101Socket(address, port) {
    var self = this;
    S101Socket.super_.call(this);

    self.address = address;
    self.port = port;
    self.socket = null;
    self.keepaliveInterval = 10;
    self.codec = null;
    self.status = "disconnected";

}

util.inherits(S101Socket, EventEmitter);


function S101Client(socket, server) {
    var self = this;
    S101Client.super_.call(this);

    self.request = null;
    self.server = server;
    self.socket = socket;

    self.pendingRequests = [];
    self.activeRequest = null;

    self.status = "connected";

    self.codec = new S101Codec();
    self.codec.on('keepaliveReq', () => {
        self.sendKeepaliveResponse();
    });

    self.codec.on('emberPacket', (packet) => {
        self.emit('emberPacket', packet);
        var ber = new BER.Reader(packet);
        try {
            var root = ember.Root.decode(ber);
            if (root !== undefined) {
                self.emit('emberTree', root);
            }
        } catch (e) {
            self.emit("error", e);
        }
    });

    if (socket !== undefined) {
        self.socket.on('data', (data) => {
            self.codec.dataIn(data);
        });

        self.socket.on('close', () => {
            self.emit('disconnected');
            self.status = "disconnected";
            self.socket = null;
        });

        self.socket.on('error', (e) => {
            self.emit("error", e);
        });
    }
}

util.inherits(S101Client, S101Socket);


/**********************************************
 *   SERVER
 **********************************************/

function S101Server(address, port) {
    var self = this;
    S101Server.super_.call(this);

    self.address = address;
    self.port = port;
    self.server = null;
    self.status = "disconnected";
}

util.inherits(S101Server, EventEmitter);

S101Server.prototype.listen = function () {
    var self = this;
    if (self.status !== "disconnected") {
        return;
    }

    self.server = net.createServer((socket) => {
        self.addClient(socket);
    });

    self.server.on("error", (e) => {
        self.emit("error", e);
    });

    self.server.on("listening", () => {
        self.emit("listening");
        self.status = "listening";
    });

    self.server.listen(self.port, self.address);
}


S101Server.prototype.addClient = function (socket) {
    var client = new S101Client(socket, this);
    this.emit("connection", client);
}


/*****************************************************
 * Client
 *****************************************************/

S101Client.prototype.remoteAddress = function () {
    if (this.socket === undefined) {
        return;
    }
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`
}

S101Client.prototype.queueMessage = function (node) {
    const self = this;
    this.addRequest(() => {
        self.sendBERNode(node);
    });
}

S101Client.prototype.makeRequest = function () {
    if (this.activeRequest === null && this.pendingRequests.length > 0) {
        this.activeRequest = this.pendingRequests.shift();
        this.activeRequest();
        this.activeRequest = null;
    }
};

S101Client.prototype.addRequest = function (cb) {
    this.pendingRequests.push(cb);
    this.makeRequest();
}


/*****************************************************
 * Socket
 *****************************************************/

S101Socket.prototype.connect = function (timeout = 2) {
    var self = this;
    if (self.status !== "disconnected") {
        return;
    }

    self.emit('connecting');

    self.codec = new S101Codec();

    const connectTimeoutListener = () => {
        self.socket.destroy();
        self.emit("error", new Error(`Could not connect to ${self.address}:${self.port} after a timeout of ${timeout} seconds`));
    };

    self.socket = net.createConnection({
            port: self.port,
            host: self.address,
            timeout: 1000 * timeout
        },
        () => {
            winston.debug('socket connected');

            // Disable connect timeout to hand-over to keepalive mechanism
            self.socket.removeListener("timeout", connectTimeoutListener);
            self.socket.setTimeout(0);

            self.keepaliveIntervalTimer = setInterval(() => {
                try {
                    self.sendKeepaliveRequest();
                } catch (e) {
                    self.emit("error", e);
                }
            }, 1000 * self.keepaliveInterval);

            self.codec.on('keepaliveReq', () => {
                self.sendKeepaliveResponse();
            });

            self.codec.on('emberPacket', (packet) => {
                self.emit('emberPacket', packet);

                var ber = new BER.Reader(packet);
                try {
                    var root = ember.Root.decode(ber);
                    if (root !== undefined) {
                        self.emit('emberTree', root);
                    }
                } catch (e) {
                    self.emit("error", e);
                }
            });

            self.emit('connected');
        })
        .on('error', (e) => {
            self.emit("error", e);
        })
        .once("timeout", connectTimeoutListener)
        .on('data', (data) => {
            if (self.isConnected()) {
                self.codec.dataIn(data);
            }
        })
        .on('close', () => {
            clearInterval(self.keepaliveIntervalTimer);
            self.emit('disconnected');
            self.status = "disconnected";
            self.socket = null;
        });
}

S101Socket.prototype.isConnected = function () {
    return ((this.socket !== null) && (this.socket !== undefined));
}

S101Socket.prototype.disconnect = function () {
    var self = this;

    if (!self.isConnected()) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
            self.socket.once('close', () => {
                self.codec = null;
                self.socket = null;
                resolve();
            });
            self.socket.once('error', reject);
            clearInterval(self.keepaliveIntervalTimer);
            self.socket.end();
            self.status = "disconnected";
        }
    );
};

S101Socket.prototype.sendKeepaliveRequest = function () {
    var self = this;
    if (self.isConnected()) {
        self.socket.write(self.codec.keepAliveRequest());
        winston.debug('sent keepalive request');
    }
}

S101Socket.prototype.sendKeepaliveResponse = function () {
    var self = this;
    if (self.isConnected()) {
        self.socket.write(self.codec.keepAliveResponse());
        winston.debug('sent keepalive response');
    }
}

S101Socket.prototype.sendBER = function (data) {
    var self = this;
    if (self.isConnected()) {
        var frames = self.codec.encodeBER(data);
        for (var i = 0; i < frames.length; i++) {
            self.socket.write(frames[i]);
        }
    }
}

S101Socket.prototype.sendBERNode = function (node) {
    var self = this;
    if (!node) return;
    var writer = new BER.Writer();
    node.encode(writer);
    self.sendBER(writer.buffer);
}


module.exports = { S101Socket, S101Server, S101Client };

