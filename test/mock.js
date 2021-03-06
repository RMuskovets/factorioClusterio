"use strict";
const events = require("events");

const link = require("lib/link");


class MockSocket {
	constructor() {
		this.sentMessages = [];
		this.events = new Map();
	}

	send(message) {
		this.sentMessages.push(message);
	}

	on(event, fn) {
		this.events.set(event, fn);
	}

	terminate() {
		this.terminateCalled = true;
	}

	close() {
		this.closeCalled = true;
	}
}

class MockConnector extends events.EventEmitter {
	constructor() {
		super();

		this._seq = 1;
		this.sentMessages = [];
		this.events = new Map();
		this.handshake = { address: "socket.test" };

		this.connected = true;
		this.closing = false;
	}

	send(type, data) {
		let message = { seq: this._seq, type, data };
		this.sentMessages.push(message);
		setImmediate(() => this.emit("send", message));
		return this._seq++;
	}
}

class MockServer {
	constructor() {
		this.rconCommands = [];
		this.rconCommandResults = new Map();
	}

	async sendRcon(command) {
		this.rconCommands.push(command);
		return this.rconCommandResults.get(command) || "";
	}
}

class MockInstance extends link.Link {
	constructor() {
		super("instance", "slave", new MockConnector());
		this.server = new MockServer();
		this.name = "test";
		this.config = {
			get: (name) => {
				if (name === "instance.id") { return 7357; }
				if (name === "factorio.enable_save_patching") { return true; }
				throw Error("Not implemented");
			},
		};
	}
}

class MockSlave extends link.Link {
	constructor() {
		super("slave", "master", new MockConnector());
	}
}

class MockControl extends link.Link {
	constructor(connector) {
		super("control", "master", connector);
	}
}


module.exports = {
	MockSocket,
	MockConnector,
	MockInstance,
	MockSlave,
	MockControl,
};
