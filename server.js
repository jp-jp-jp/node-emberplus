const EventEmitter = require('events').EventEmitter;
const util = require('util');
const S101Server = require('./client.js').S101Server;
const ember = require('./ember.js');

function TreeServer(host, port, tree) {
    TreeServer.super_.call(this);
    var self = this;
    self._debug = false;

    self.callback = undefined;
    self.timeoutValue = 2000;
    self.server = new S101Server(host, port);
    self.tree = tree;
    self.clients = new Set();
    self.subscribers = {};

    self.server.on('listening', () => {
        if (self._debug) { console.log("listening"); }
        self.emit('listening');
        if (self.callback !== undefined) {
            self.callback();
            self.callback = undefined;
        }
    });

    self.server.on('connection', (client) => {
        if (self._debug) { console.log("ember new connection from", client.remoteAddress()); }
        self.clients.add(client);
        client.on("emberTree", (root) => {
            if (self._debug) { console.log("ember new request from", client.remoteAddress(), root); }
            // Queue the action to make sure responses are sent in order.
            client.addRequest(() => {
                try {
                    let path = self.handleRoot(client, root);
                    self.emit("request", {client: client.remoteAddress(), root: root, path: path});
                }
                catch(e) {
                    if (self._debug) { console.log(e.stack); }
                    self.emit("error", e);
                }
            });
        });
        client.on("disconnected", () => {
            self.clients.delete(client);
            self.emit('disconnect', client.remoteAddress());
        });
        client.on("error", error => {
            self.emit('clientError', { remoteAddress: client.remoteAddress(), error });
        });
        self.emit('connection', client.remoteAddress());
    });

    self.server.on('disconnected', () => {
        self.emit('disconnected', client.remoteAddress());
    });

    self.server.on("error", (e) => {
        self.emit("error", e);
        if (self.callback !== undefined) {
            self.callback(e);
        }
    });

}

util.inherits(TreeServer, EventEmitter);


TreeServer.prototype.listen = function() {
    return new Promise((resolve, reject) => {
        this.callback = (e) => {
            if (e === undefined) {
                return resolve();
            }
            return reject(e);
        };
        this.server.listen();
    });
};

TreeServer.prototype.close = function () {
    return new Promise((resolve, reject) => {
        this.callback = (e) => {
            if (e === undefined) {
                return resolve();
            }
            return reject(e);
        };
        this.server.server.close();
    });
};

TreeServer.prototype.handleRoot = function(client, root) {
    if ((root === undefined) || (root.elements === undefined) || (root.elements < 1)) {
        this.emit("error", new Error("invalid request"));
        return;
    }


    const node = root.elements[0];
    client.request = node;

    if (node.path !== undefined) {
        return this.handleQualifiedNode(client, node);
    }
    else if (node instanceof ember.Command) {
        // Command on root element
        this.handleCommand(client, this.tree, node.number);
        return "root";
    }
    else {
        return this.handleNode(client, node);
    }
}

TreeServer.prototype.handleError = function(client, node) {
    if (client !== undefined) {
        let res = node == null ? this.tree._root.getMinimal() : node;
        client.sendBERNode(res);
    }
}


TreeServer.prototype.handleQualifiedNode = function(client, node) {
    const path = node.path;
    // Find this element in our tree
    const element = this.tree.getElementByPath(path);

    if ((element === null) || (element === undefined)) {
        this.emit("error", new Error(`unknown element at path ${path}`));
        return this.handleError(client);
    }

    if ((node.children !== undefined) && (node.children.length === 1) &&
        (node.children[0] instanceof ember.Command)) {
        this.handleCommand(client, element, node.children[0].number);
    }
    else {
        if (node instanceof ember.QualifiedMatrix) {
            this.handleQualifiedMatrix(client, element, node);
        }
        else if (node instanceof ember.QualifiedParameter) {
            this.handleQualifiedParameter(client, element, node);
        }
    }
    return path;
}


TreeServer.prototype.handleNode = function(client, node) {
    // traverse the tree
    let element = node;
    let path = [];
    while(element !== undefined) {
        if (element.number === undefined) {
            this.emit("error", "invalid request");
            return;
        }
        if (element instanceof ember.Command) {
            break;
        }
        path.push(element.number);

        let children = element.getChildren();
        if ((! children) || (children.length === 0)) {
            break;
        }
        element = element.children[0];
    }
    let cmd = element;

    if (cmd === undefined) {
        this.emit("error", "invalid request");
        return this.handleError(client);
    }

    element = this.tree.getElementByPath(path.join("."));

    if (element == null) {
        this.emit("error", new Error(`unknown element at path ${path}`));
        return this.handleError(client);
    }

    if (cmd instanceof ember.Command) {
        this.handleCommand(client, element, cmd.number);
    }
    else if ((cmd instanceof ember.MatrixNode) && (cmd.connections !== undefined)) {
        this.handleMatrixConnections(client, element, cmd.connections);
    }
    else if ((cmd instanceof ember.Parameter) &&
        (cmd.contents !== undefined) && (cmd.contents.value !== undefined)) {
        if (this._debug) { console.log(`setValue for element at path ${path} with value ${cmd.contents.value}`); }
        this.setValue(element, cmd.contents.value, client);
        let res = this.getResponse(element);
        client.sendBERNode(res)
        this.updateSubscribers(element.getPath(), res, client);
    }
    else {
        this.emit("error", new Error("invalid request format"));
        if (this._debug) { console.log("invalid request format"); }
        return this.handleError(client, element.getTreeBranch());
    }
    return path;
}

TreeServer.prototype.handleQualifiedMatrix = function(client, element, matrix)
{
    this.handleMatrixConnections(client, element, matrix.connections);
}

TreeServer.prototype.handleQualifiedParameter = function(client, element, parameter)
{
    if (parameter.contents.value !== undefined) {
        this.setValue(element, parameter.contents.value, client);
        let res = this.getQualifiedResponse(element);
        client.sendBERNode(res)
        this.updateSubscribers(element.getPath(), res, client);
    }
}


TreeServer.prototype.handleMatrixConnections = function(client, matrix, connections, response = true) {
    var res;
    var root; // ember message root
    if (matrix.isQualified()) {
        root = new ember.Root();
        res = new ember.QualifiedMatrix(matrix.path);
        root.elements = [res]; // do not use addchild or the element will get removed from the tree.
    }
    else {
        res = new ember.MatrixNode(matrix.number);
        root = matrix._parent.getTreeBranch(res);
    }
    res.connections = {};
    for(let id in connections) {
        if (!connections.hasOwnProperty(id)) {
            continue;
        }
        let connection = connections[id];
        let conResult = new ember.MatrixConnection(connection.target);
        let emitType;
        res.connections[connection.target] = conResult;


        // Apply changes

        if ((connection.operation === undefined) ||
            (connection.operation.value == ember.MatrixOperation.absolute)) {
            matrix.connections[connection.target].setSources(connection.sources);
            emitType = "matrix-change";
        }
        else if (connection.operation == ember.MatrixOperation.connect) {
            matrix.connections[connection.target].connectSources(connection.sources);
            emitType = "matrix-connect";
        }
        else { // Disconnect
            matrix.connections[connection.target].disconnectSources(connection.sources);
            emitType = "matrix-disconnect";
        }

        // Send response or update subscribers.

        if (response) {
            conResult.sources = matrix.connections[connection.target].sources;
            conResult.disposition = ember.MatrixDisposition.modified;
            // We got a request so emit something.
            this.emit(emitType, {
                target: connection.target,
                sources: connection.sources,
                client: client.remoteAddress()
            });
        }
        else {
            // the action has been applied.  So we should either send the current state (absolute)
            // or send the action itself (connection.sources)
            conResult.sources = matrix.connections[connection.target].sources;
            conResult.operation = ember.MatrixOperation.absolute;
        }
    }
    if (client !== undefined) {
        client.sendBERNode(root);
    }
    if (this._debug) { console.log("Updating subscribers for matrix change"); }
    this.updateSubscribers(matrix.getPath(), root, client);
}

const validateMatrixOperation = function(matrix, target, sources) {
    if (matrix === undefined) {
        throw new Error(`matrix not found with path ${path}`);
    }
    if (matrix.contents === undefined) {
        throw new Error(`invalid matrix at ${path} : no contents`);
    }
    if (matrix.contents.targetCount === undefined) {
        throw new Error(`invalid matrix at ${path} : no targetCount`);
    }
    if ((target < 0) || (target >= matrix.contents.targetCount)) {
        throw new Error(`target id ${target} out of range 0 - ${matrix.contents.targetCount}`);
    }
    if (sources.length === undefined) {
        throw new Error("invalid sources format");
    }
}

const doMatrixOperation = function(server, path, target, sources, operation) {
    let matrix = server.tree.getElementByPath(path);

    validateMatrixOperation(matrix, target, sources);

    let connection = new ember.MatrixConnection(target);
    connection.sources = sources;
    connection.operation = operation;
    server.handleMatrixConnections(undefined, matrix, [connection], false);
}

TreeServer.prototype.matrixConnect = function(path, target, sources) {
    doMatrixOperation(this, path, target, sources, ember.MatrixOperation.connect);
}

TreeServer.prototype.matrixDisconnect = function(path, target, sources) {
    doMatrixOperation(this, path, target, sources, ember.MatrixOperation.disconnect);
}

TreeServer.prototype.matrixSet = function(path, target, sources) {
    doMatrixOperation(this, path, target, sources, ember.MatrixOperation.absolute);
}

TreeServer.prototype.handleCommand = function(client, element, cmd) {
    if (cmd === ember.GetDirectory) {
        this.handleGetDirectory(client, element);
    }
    else if (cmd === ember.Subscribe) {
        this.handleSubscribe(client, element);
    }
    else if (cmd === ember.Unsubscribe) {
        this.handleUnSubscribe(client, element);
    }
    else {
        this.emit("error", new Error(`invalid command ${cmd}`));
    }
}

TreeServer.prototype.getResponse = function(element) {
    return element.getTreeBranch(undefined, function(node) {
        node.update(element);
        let children = element.getChildren();
        if (children != null) {
            for (let i = 0; i < children.length; i++) {
                node.addChild(children[i].getDuplicate());
            }
        }
        else if (this._debug) {
            console.log("getResponse","no children");
        }
    });
}

TreeServer.prototype.getQualifiedResponse = function(element) {
    let res = new ember.Root();
    let dup = element.toQualified();
    let children = element.getChildren();
    if (children != null) {
        for (let i = 0; i < children.length; i++) {
            dup.addChild(children[i].getDuplicate());
        }
    }
    res.elements = [dup];
    return res;
}

TreeServer.prototype.handleGetDirectory = function(client, element) {

    if (client !== undefined) {
        if ((element.isMatrix() || element.isParameter()) &&
            (!element.isStream())) {
            // ember spec: parameter without streamIdentifier should
            // report their value changes automatically.
            this.subscribe(client, element);
        }
         else if (element.getChildren() !== null) {
            for (let child of element.getChildren()) {
                this.subscribe(client, child)
            }
        }
        let res;
        if (client.request.path == null) {
            res = this.getResponse(element);
        }
        else {
            res = this.getQualifiedResponse(element);
        }
        client.sendBERNode(res);
    }
}

TreeServer.prototype.handleSubscribe = function(client, element) {
    this.subscribe(client, element);
}

TreeServer.prototype.handleUnSubscribe = function(client, element) {
    this.unsubscribe(client, element);
}


TreeServer.prototype.subscribe = function(client, element) {
    const path = element.getPath();
    if (this.subscribers[path] === undefined) {
        this.subscribers[path] = new Set();
    }
    this.subscribers[path].add(client);
}

TreeServer.prototype.unsubscribe = function(client, element) {
    const path = element.getPath();
    if (this.subscribers[path] === undefined) {
        return;
    }
    this.subscribers[path].delete(client);
}

TreeServer.prototype.setValue = function(element, value, origin, key) {
    return new Promise((resolve, reject) => {
        // Change the element value if write access permitted.
        if (element.contents !== undefined) {
            if (element.isParameter()) {
                if ((element.contents.access !== undefined) &&
                    (element.contents.access.value > 1)) {
                     orginalvalue = element.contents.value;
                    element.contents.value = value;
                    this.emit("value-change", element, orginalvalue);
                }
            }
            else if (element.isMatrix()) {
                if ((key !== undefined) && (element.contents.hasOwnProperty(key))) {
                    element.contents[key] = value;
                    this.emit("value-change", element);
                }
            }
        }
    });
}

TreeServer.prototype.replaceElement = function(element) {
    let path = element.getPath();
    let parent = this.tree.getElementByPath(path);
    if ((parent === undefined)||(parent._parent === undefined)) {
        throw new Error(`Could not find element at path ${path}`);
    }
    parent = parent._parent;
    let children = parent.getChildren();
    let newList = [];
    for(let i = 0; i <= children.length; i++) {
        if (children[i] && children[i].getPath() == path) {
            element._parent = parent; // move it to new tree.
            children[i] = element;
            let res = this.getResponse(element);
            this.updateSubscribers(path,res);
            return;
        }
    }
}


TreeServer.prototype.updateSubscribers = function(path, response, origin) {
    if (this.subscribers[path] === undefined) {
        return;
    }

    for (let client of this.subscribers[path]) {
        if (client === origin) {
            continue; // already sent the response to origin
        }
        if (this.clients.has(client)) {
            client.queueMessage(response);
        }
        else {
            // clean up subscribers - client is gone
            this.subscribers[path].delete(client);
        }
    }
}

const parseMatrixContent = function(matrixContent, content) {
    if (content.labels) {
        matrixContent.labels = [];
        for(let l = 0; l < content.labels.length; l++) {
            matrixContent.labels.push(
                new ember.Label(content.labels[l])
            );
        }
        delete content.labels;
    }
    if (content.type != null) {
        if (content.type == "oneToN") {
            matrixContent.type = ember.MatrixType.oneToN;
        }
        else if (content.type == "oneToOne") {
            matrixContent.type = ember.MatrixType.oneToOne;
        }
        else if (content.type == "nToN") {
            matrixContent.type = ember.MatrixType.nToN;
        }
        else {
            throw new Error(`Invalid matrix type ${content.type}`);
        }
        delete content.type;
    }
    if (content.mode != null) {
        if (content.mode == "linear") {
            matrixContent.mode = ember.MatrixMode.linear;
        }
        else if (content.mode == "nonLinear") {
            matrixContent.mode = ember.MatrixMode.nonLinear;
        }
        else {
            throw new Error(`Invalid matrix mode ${content.mode}`);
        }
        delete content.mode;
    }
}

const parseObj = function(parent, obj) {
    let path = parent.getPath();
    for(let i = 0; i < obj.length; i++) {
        let emberElement;
        let content = obj[i];
        let number = content.number !== undefined ? content.number : i;
        delete content.number;
        if (content.value !== undefined) {
            emberElement = new ember.Parameter(number);
            emberElement.contents = new ember.ParameterContents(content.value);
            if (content.type) {
                emberElement.contents.type = ember.ParameterType.get(content.type);
                delete content.type;
            }
            else {
                emberElement.contents.type = ember.ParameterType.string;
            }
            if (content.access) {
                emberElement.contents.access = ember.ParameterAccess.get(content.access);
                delete content.access;
            }
            else {
                emberElement.contents.access = ember.ParameterAccess.read;
            }
        }
        else if (content.targetCount !== undefined) {
            emberElement = new ember.MatrixNode(number);
            emberElement.contents = new ember.MatrixContents();
            parseMatrixContent(emberElement.contents, content);
            if (content.connections) {
                emberElement.connections = {};
                for (let c in content.connections) {
                    if (! content.connections.hasOwnProperty(c)) {
                        continue;
                    }
                    let t = content.connections[c].target !== undefined ? content.connections[c].target : 0;
                    let connection = new ember.MatrixConnection(t);
                    connection.setSources(content.connections[c].sources);
                    emberElement.connections[t] = connection;
                }
                delete content.connections;
            }
            else {
                emberElement.connections = {};
                for (let t = 0; t < content.targetCount; t++) {
                    let connection = new ember.MatrixConnection(t);
                    emberElement.connections[t] = connection;
                }
            }
        }
        else {
            emberElement = new ember.Node(number);
            emberElement.contents = new ember.NodeContents();
        }
        for(let id in content) {
            if ((id !== "children") && (content.hasOwnProperty(id))) {
                emberElement.contents[id] = content[id];
            }
            else {
                parseObj(emberElement, content.children);
            }
        }
        parent.addChild(emberElement);
    }
}

TreeServer.JSONtoTree = function(obj) {
    let tree = new ember.Root();
    parseObj(tree, obj);
    return tree;
}

const toJSON = function(node) {
    let res = {};

    if (node.number) {
        res.number = node.number
    }
    if (node.path) {
        res.path = node.path;
    }
    if (node.contents) {
        for(let prop in node.contents) {
            if (node.contents.hasOwnProperty(prop)) {
                let type = typeof node.contents[prop];
                if ((type === "string") || (type === "number")) {
                    res[prop] = node.contents[prop];
                }
                else if (node.contents[prop].value !== undefined) {
                    res[prop] = node.contents[prop].value;
                }
                else {
                    res[prop] = node.contents[prop];
                }
            }
        }
    }
    if (node.isMatrix()) {
        if (node.targets) {
            res.targets = node.targets.slice(0);
        }
        if (node.sources) {
            res.sources = node.sources.slice(0);
        }
        if (node.connections) {
            res.connections = {};
            for (let target in connections) {
                if (connections.hasOwnProperty(target)) {
                    res.connections[target] = {target: target, sources: []};
                    if (connections[target].sources) {
                        res.connections[target].sources = connections[target].sources.slice(0);
                    }
                }
            }

        }
    }
    let children = node.getChildren();
    if (children) {
        res.children = [];
        for(let child of children) {
            res.children.push(toJSON(child));
        }
    }
    return res;
};

TreeServer.prototype.toJSON = function() {
    if ((!this.tree) || (!this.tree.elements) || (this.tree.elements.length == 0)) {
        return [];
    }
    return [].push(toJSON(this.tree.elements[0]));
};

module.exports = TreeServer;
