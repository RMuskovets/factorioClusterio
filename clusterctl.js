/**
 * Command line interface for controlling a Clusterio cluster
 * @module
 */
"use strict";
const jwt = require("jsonwebtoken");
const fs = require("fs-extra");
const yargs = require("yargs");
const version = require("./package").version;
const asTable = require("as-table").configure({ delimiter: " | " });
const chalk = require("chalk");
const events = require("events");

const link = require("lib/link");
const errors = require("lib/errors");
const config = require("lib/config");
const plugin = require("lib/plugin");
const command = require("lib/command");


/**
 * Format a parsed Factorio output message with colors
 *
 * Formats a parsed Factorio output from lib/factorio into a readable
 * colorized output using terminal escape codes that can be printed.
 *
 * @param {Object} output - Factorio server output.
 * @returns {string} terminal colorized message.
 * @private
 */
function formatOutputColored(output) {
	let time = "";
	if (output.format === "seconds") {
		time = chalk.yellow(output.time.padStart(8)) + " ";
	} else if (output.format === "date") {
		time = chalk.yellow(output.time) + " ";
	}

	let info = "";
	if (output.type === "log") {
		let level = output.level;
		if (level === "Info") {
			level = chalk.bold.blueBright(level);
		} else if (output.level === "Warning") {
			level = chalk.bold.yellowBright(level);
		} else if (output.level === "Error") {
			level = chalk.bold.redBright(level);
		}

		info = level + " " + chalk.gray(output.file) + ": ";

	} else if (output.type === "action") {
		info = "[" + chalk.yellow(output.action) + "] ";
	}

	return time + info + output.message;
}

const slaveCommands = new command.CommandTree({ name: "slave", description: "Slave management" });
slaveCommands.add(new command.Command({
	definition: [["list", "l"], "List slaves connected to the master"],
	handler: async function(args, control) {
		let response = await link.messages.listSlaves.send(control);
		console.log(asTable(response.list));
	},
}));

slaveCommands.add(new command.Command({
	definition: ["generate-token", "Generate token for a slave", (yargs) => {
		yargs.option("id", { type: "number", nargs: 1, describe: "Slave id", demandOption: true });
	}],
	handler: async function(args, control) {
		let response = await link.messages.generateSlaveToken.send(control, { slave_id: args.id });
		console.log(response.token);
	},
}));

slaveCommands.add(new command.Command({
	definition: ["create-config", "Create slave config", (yargs) => {
		yargs.option("id", { type: "number", nargs: 1, describe: "Slave id", default: null });
		yargs.option("name", { type: "string", nargs: 1, describe: "Slave name", default: null });
		yargs.option("generate-token", {
			type: "boolean", nargs: 0, describe: "Generate authentication token", default: false,
		});
		yargs.option("output", {
			type: "string", nargs: 1, describe: "Path to output config (- for stdout)", default: "config-slave.json",
		});
	}],
	handler: async function(args, control) {
		let response = await link.messages.createSlaveConfig.send(control, {
			id: args.id, name: args.name, generate_token: args.generateToken,
		});

		let content = JSON.stringify(response.serialized_config, null, 4);
		if (args.output === "-") {
			console.log(content);
		} else {
			console.log(`Writing ${args.output}`);
			try {
				await fs.outputFile(args.output, content, { flag: "wx" });
			} catch (err) {
				if (err.code === "EEXIST") {
					throw new errors.CommandError(`File ${args.output} already exists`);
				}
				throw err;
			}
		}
	},
}));


const instanceCommands = new command.CommandTree({
	name: "instance", alias: ["i"], description: "Instance management",
});
instanceCommands.add(new command.Command({
	definition: [["list", "l"], "List instances known to the master"],
	handler: async function(args, control) {
		let response = await link.messages.listInstances.send(control);
		console.log(asTable(response.list));
	},
}));

instanceCommands.add(new command.Command({
	definition: ["create <name>", "Create an instance", (yargs) => {
		// XXX TODO: set any specific options?
		yargs.positional("name", { describe: "Instance name", type: "string" });
		yargs.options({
			"id": { type: "number", nargs: 1, describe: "Instance id" },
		});
	}],
	handler: async function(args, control) {
		let instanceConfig = new config.InstanceConfig();
		await instanceConfig.init();
		if (args.id) {
			instanceConfig.set("instance.id", args.id);
		}
		instanceConfig.set("instance.name", args.name);
		let serialized_config = instanceConfig.serialize();
		let response = await link.messages.createInstance.send(control, { serialized_config });
	},
}));

const instanceConfigCommands = new command.CommandTree({
	name: "config", alias: ["c"], description: "Instance config management",
});
instanceConfigCommands.add(new command.Command({
	definition: ["list <instance>", "List configuration for an instance", (yargs) => {
		yargs.positional("instance", { describe: "Instance to list config for", type: "string" });
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		let response = await link.messages.getInstanceConfig.send(control, { instance_id: instanceId });

		for (let group of response.serialized_config.groups) {
			for (let [name, value] of Object.entries(group.fields)) {
				console.log(`${group.name}.${name} ${JSON.stringify(value)}`);
			}
		}
	},
}));

instanceConfigCommands.add(new command.Command({
	definition: ["set <instance> <field> <value>", "Set field in instance config", (yargs) => {
		yargs.positional("instance", { describe: "Instance to set config on", type: "string" });
		yargs.positional("field", { describe: "Field to set", type: "string" });
		yargs.positional("value", { describe: "Value to set", type: "string" });
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		await link.messages.setInstanceConfigField.send(control, {
			instance_id: instanceId,
			field: args.field,
			value: args.value,
		});
	},
}));

instanceConfigCommands.add(new command.Command({
	definition: ["set-prop <instance> <field> <prop> <value>", "Set property of field in instance config", (yargs) => {
		yargs.positional("instance", { describe: "Instance to set config on", type: "string" });
		yargs.positional("field", { describe: "Field to set", type: "string" });
		yargs.positional("prop", { describe: "Property to set", type: "string" });
		yargs.positional("value", { describe: "JSON parsed value to set", type: "string" });
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		await link.messages.setInstanceConfigProp.send(control, {
			instance_id: instanceId,
			field: args.field,
			prop: args.prop,
			value: JSON.parse(args.value),
		});
	},
}));
instanceCommands.add(instanceConfigCommands);

instanceCommands.add(new command.Command({
	definition: ["assign <instance> <slave>", "Assign instance to a slave", (yargs) => {
		yargs.positional("instance", { describe: "Instance to assign", type: "string" });
		yargs.positional("slave", { describe: "Slave to assign to", type: "string" });
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		let slaveId = await command.resolveSlave(control, args.slave);
		await link.messages.assignInstanceCommand.send(control, {
			instance_id: instanceId,
			slave_id: slaveId,
		});
	},
}));

instanceCommands.add(new command.Command({
	definition: ["create-save <instance>", "Create a new save on an instance", (yargs) => {
		yargs.positional("instance", { describe: "Instance to create on", type: "string" });
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		await link.messages.setInstanceOutputSubscriptions.send(control, { instance_ids: [instanceId] });
		let response = await link.messages.createSave.send(control, {
			instance_id: instanceId,
		});
	},
}));

instanceCommands.add(new command.Command({
	definition: ["export-data <instance>", "Export item icons and locale from instance", (yargs) => {
		yargs.positional("instance", { describe: "Instance to export from", type: "string" });
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		await link.messages.setInstanceOutputSubscriptions.send(control, { instance_ids: [instanceId] });
		let response = await link.messages.exportData.send(control, {
			instance_id: instanceId,
		});
	},
}));

instanceCommands.add(new command.Command({
	definition: ["start <instance>", "Start instance", (yargs) => {
		yargs.positional("instance", { describe: "Instance to start", type: "string" });
		yargs.options({
			"save": { describe: "Save load, defaults to latest", nargs: 1, type: "string" },
			"keep-open": { describe: "Keep console open", nargs: 0, type: "boolean", default: false },
		});
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		await link.messages.setInstanceOutputSubscriptions.send(control, { instance_ids: [instanceId] });
		let response = await link.messages.startInstance.send(control, {
			instance_id: instanceId,
			save: args.save || null,
		});
	},
}));

instanceCommands.add(new command.Command({
	definition: ["load-scenario <instance> <scenario>", "Start instance by loading a scenario", (yargs) => {
		yargs.positional("instance", { describe: "Instance to start", type: "string" });
		yargs.positional("scenario", { describe: "Scenario to load", type: "string" });
		yargs.options({
			"keep-open": { describe: "Keep console open", nargs: 0, type: "boolean", default: false },
		});
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		await link.messages.setInstanceOutputSubscriptions.send(control, { instance_ids: [instanceId] });
		let response = await link.messages.loadScenario.send(control, {
			instance_id: instanceId,
			scenario: args.scenario || null,
		});
	},
}));

instanceCommands.add(new command.Command({
	definition: ["stop <instance>", "Stop instance", (yargs) => {
		yargs.positional("instance", { describe: "Instance to stop", type: "string" });
	}],
	handler: async function(args, control) {
		let instanceId = await command.resolveInstance(control, args.instance);
		await link.messages.setInstanceOutputSubscriptions.send(control, { instance_ids: [instanceId] });
		let response = await link.messages.stopInstance.send(control, {
			instance_id: instanceId,
		});
	},
}));

instanceCommands.add(new command.Command({
	definition: ["delete <instance>", "Delete instance", (yargs) => {
		yargs.positional("instance", { describe: "Instance to delete", type: "string" });
	}],
	handler: async function(args, control) {
		let response = await link.messages.deleteInstance.send(control, {
			instance_id: await command.resolveInstance(control, args.instance),
		});
	},
}));

instanceCommands.add(new command.Command({
	definition: ["send-rcon <instance> <command>", "Send RCON command", (yargs) => {
		yargs.positional("instance", { describe: "Instance to send to", type: "string" });
		yargs.positional("command", { describe: "command to send", type: "string" });
	}],
	handler: async function(args, control) {
		let response = await link.messages.sendRcon.send(control, {
			instance_id: await command.resolveInstance(control, args.instance),
			command: args.command,
		});

		// Factorio includes a newline in it's response output.
		process.stdout.write(response.result);
	},
}));

const permissionCommands = new command.CommandTree({ name: "permission", description: "Permission inspection" });
permissionCommands.add(new command.Command({
	definition: [["list", "l"], "List permissions in the cluster"],
	handler: async function(args, control) {
		let response = await link.messages.listPermissions.send(control);
		console.log(asTable(response.list));
	},
}));


const roleCommands = new command.CommandTree({ name: "role", description: "Role management" });
roleCommands.add(new command.Command({
	definition: [["list", "l"], "List roles in the cluster"],
	handler: async function(args, control) {
		let response = await link.messages.listRoles.send(control);
		console.log(asTable(response.list));
	},
}));

roleCommands.add(new command.Command({
	definition: ["create <name>", "Create a new role", (yargs) => {
		yargs.positional("name", { describe: "Name of role to create", type: "string" });
		yargs.options({
			"description": { describe: "Description for role", nargs: 1, type: "string", default: "" },
			"permissions": { describe: "Permissions role grants", nargs: 1, array: true, type: "string", default: [] },
		});
	}],
	handler: async function(args, control) {
		let response = await link.messages.createRole.send(control, {
			name: args.name,
			description: args.description,
			permissions: args.permissions,
		});
		console.log(`Created role ID ${response.id}`);
	},
}));

roleCommands.add(new command.Command({
	definition: ["edit <role>", "Edit existing role", (yargs) => {
		yargs.positional("role", { describe: "Role to edit", type: "string" });
		yargs.options({
			"name": { describe: "New name for role", nargs: 1, type: "string" },
			"description": { describe: "New description for role", nargs: 1, type: "string" },
			"permissions": { describe: "New permissions for role", array: true, type: "string" },
			"grant-default": { describe: "Add default permissions to role", nargs: 0, type: "boolean" },
		});
	}],
	handler: async function(args, control) {
		let role = await command.retrieveRole(control, args.role);

		if (args.name !== undefined) {
			role.name = args.name;
		}
		if (args.description !== undefined) {
			role.description = args.description;
		}
		if (args.permissions !== undefined) {
			role.permissions = args.permissions;
		}
		await link.messages.updateRole.send(control, role);

		if (args.grantDefault) {
			await link.messages.grantDefaultRolePermissions.send(control, { id: role.id });
		}
	},
}));

roleCommands.add(new command.Command({
	definition: ["delete <role>", "Delete role", (yargs) => {
		yargs.positional("role", { describe: "Role to delete", type: "string" });
	}],
	handler: async function(args, control) {
		let role = await command.retrieveRole(control, args.role);
		await link.messages.deleteRole.send(control, { id: role.id });
	},
}));


const userCommands = new command.CommandTree({ name: "user", alias: ["u"], description: "User management" });
userCommands.add(new command.Command({
	definition: [["list", "l"], "List user in the cluster"],
	handler: async function(args, control) {
		let response = await link.messages.listUsers.send(control);
		console.log(asTable(response.list));
	},
}));

userCommands.add(new command.Command({
	definition: ["create <name>", "Create a user", (yargs) => {
		yargs.positional("name", { describe: "Name of user to create", type: "string" });
	}],
	handler: async function(args, control) {
		await link.messages.createUser.send(control, { name: args.name });
	},
}));

userCommands.add(new command.Command({
	definition: ["set-roles <user> [roles...]", "Replace user roles", (yargs) => {
		yargs.positional("user", { describe: "Name of user to change roles for", type: "string" });
		yargs.positional("roles", { describe: "roles to assign", type: "string" });
	}],
	handler: async function(args, control) {
		let response = await link.messages.listRoles.send(control);

		let resolvedRoles = [];
		for (let roleName of args.roles) {
			if (/^-?\d+$/.test(roleName)) {
				let roleId = parseInt(roleName, 10);
				resolvedRoles.push(roleId);

			} else {
				let found = false;
				for (let role of response.list) {
					if (role.name === roleName) {
						resolvedRoles.push(role.id);
						found = true;
						break;
					}
				}

				if (!found) {
					throw new errors.CommandError(`No role named ${roleName}`);
				}
			}
		}

		await link.messages.updateUserRoles.send(control, { name: args.user, roles: resolvedRoles });
	},
}));

userCommands.add(new command.Command({
	definition: ["delete <user>", "Delete user", (yargs) => {
		yargs.positional("user", { describe: "Name of user to delete", type: "string" });
	}],
	handler: async function(args, control) {
		await link.messages.deleteUser.send(control, { name: args.user });
	},
}));

const debugCommands = new command.CommandTree({ name: "debug", description: "Debugging utilities" });
debugCommands.add(new command.Command({
	definition: ["dump-ws", "Dump WebSocket messages sent and received by master", (yargs) => { }],
	handler: async function(args, control) {
		await link.messages.debugDumpWs.send(control);
		return new Promise(() => {});
	},
}));


/**
 * Connector for control connection to master server
 * @private
 */
class ControlConnector extends link.WebSocketClientConnector {
	constructor(url, reconnectDelay, token) {
		super(url, reconnectDelay);
		this._token = token;
	}

	register() {
		console.log("SOCKET | registering control");
		this.sendHandshake("register_control", {
			token: this._token,
			agent: "clusterctl",
			version: version,
		});
	}
}

/**
 * Handles running the control
 *
 * Connects to the master server over WebSocket and sends commands to it.
 * @static
 */
class Control extends link.Link {

	constructor(connector, controlPlugins) {
		super("control", "master", connector);
		link.attachAllMessages(this);

		/**
		 * Mapping of plugin names to their instance for loaded plugins.
		 * @type {Map<string, module:lib/plugin.BaseControlPlugin>}
		 */
		this.plugins = controlPlugins;
		for (let controlPlugin of controlPlugins.values()) {
			plugin.attachPluginMessages(this, controlPlugin.info, controlPlugin);
		}
	}

	async instanceOutputEventHandler(message) {
		let { instance_id, output } = message.data;
		console.log(formatOutputColored(output));
	}

	async debugWsMessageEventHandler(message) {
		console.log("WS", message.data.direction, message.data.content);
	}

	async shutdown() {
		this.connector.setTimeout(30);

		try {
			await link.messages.prepareDisconnect.send(this);
		} catch (err) {
			if (!(err instanceof errors.SessionLost)) {
				throw err;
			}
		}

		await this.connector.close(1001, "Control Quit");
	}
}


async function startControl() {
	yargs
		.scriptName("clusterctl")
		.usage("$0 <command> [options]")
		.option("config", {
			nargs: 1,
			describe: "config file to get credentails from",
			default: "config-control.json",
			defaultDescription: "auto",
			type: "string",
		})
		.command("control-config", "Manage Control config", config.configCommand)
		.wrap(yargs.terminalWidth())
		.strict()
	;

	const rootCommands = new command.CommandTree({ name: "clusterctl", description: "Manage cluster" });
	rootCommands.add(slaveCommands);
	rootCommands.add(instanceCommands);
	rootCommands.add(permissionCommands);
	rootCommands.add(roleCommands);
	rootCommands.add(userCommands);
	rootCommands.add(debugCommands);

	console.log("Loading Plugin info");
	let pluginInfos = await plugin.loadPluginInfos("plugins");
	config.registerPluginConfigGroups(pluginInfos);
	config.finalizeConfigs();

	let controlPlugins = new Map();
	for (let pluginInfo of pluginInfos) {
		if (!pluginInfo.controlEntrypoint) {
			continue;
		}

		let { ControlPlugin } = require(`./plugins/${pluginInfo.name}/${pluginInfo.controlEntrypoint}`);
		let controlPlugin = new ControlPlugin(pluginInfo);
		controlPlugins.set(pluginInfo.name, controlPlugin);
		await controlPlugin.init();
		await controlPlugin.addCommands(rootCommands);
	}

	for (let [name, command] of rootCommands.subCommands) {
		if (name === command.name) {
			command.register(yargs);
		}
	}

	const args = yargs.argv;

	console.log(`Loading config from ${args.config}`);
	let controlConfig = new config.ControlConfig();
	try {
		await controlConfig.load(JSON.parse(await fs.readFile(args.config)));

	} catch (err) {
		if (err.code === "ENOENT") {
			console.log("Config not found, initializing new config");
			await controlConfig.init();

		} else {
			throw err;
		}
	}

	if (args._.length === 0) {
		yargs.showHelp();
		yargs.exit();
	}

	// Handle the control-config command before trying to connect.
	if (args._[0] === "control-config") {
		await config.handleConfigCommand(args, controlConfig, args.config);
		return;
	}

	// Determine which command is being executed.
	let commandPath = [...args._];
	let targetCommand = rootCommands;
	while (commandPath.length && targetCommand instanceof command.CommandTree) {
		targetCommand = targetCommand.get(commandPath.shift());
	}

	// The remaining commands require connecting to the master server.
	if (!controlConfig.get("control.master_url") || !controlConfig.get("control.master_token")) {
		console.error("Missing URL and/or token to connect with.  See README.md for setting up access.");
		process.exitCode = 1;
		return;
	}

	let controlConnector = new ControlConnector(
		controlConfig.get("control.master_url"),
		controlConfig.get("control.reconnect_delay"),
		controlConfig.get("control.master_token")
	);
	let control = new Control(controlConnector, controlPlugins);
	try {
		await controlConnector.connect();
	} catch(err) {
		if (err instanceof errors.AuthenticationFailed) {
			throw new errors.StartupError(err.message);
		}
		throw err;
	}

	process.on("SIGINT", () => {
		console.log("Caught interrupt signal, closing connection");
		control.shutdown().catch(err => {
			console.error(err);
			process.exit(1);
		});
	});

	let keepOpen = Boolean(args.keepOpen);
	try {
		await targetCommand.run(args, control);

	} catch (err) {
		keepOpen = false;
		if (err instanceof errors.CommandError) {
			console.error(`Error running command: ${err.message}`);
			process.exitCode = 1;

		} else if (err instanceof errors.RequestError) {
			console.error(`Error sending request: ${err.message}`);
			process.exitCode = 1;

		} else {
			throw err;
		}

	} finally {
		if (!keepOpen) {
			await control.shutdown();
		}
	}
}

module.exports = {
	Control,

	// for testing only
	_formatOutputColored: formatOutputColored,
};


if (module === require.main) {
	console.warn(`
+==========================================================+
I WARNING:  This is the development branch for the 2.0     I
I           version of clusterio.  Expect things to break. I
+==========================================================+
`
	);
	startControl().catch(err => {
		if (!(err instanceof errors.StartupError)) {
			console.error(`
+----------------------------------------------------------------+
| Unexpected error occured while starting control, please report |
| it to https://github.com/clusterio/factorioClusterio/issues    |
+----------------------------------------------------------------+`
			);
		} else {
			console.error(`
+-------------------------------+
| Unable to to start clusterctl |
+-------------------------------+`
			);
		}

		console.error(err);
		process.exitCode = 1;
	});
}
