const FS = require('fs');
const HTTP = require('http');
const McCrypto = require('@doctormckay/crypto');
const MySQL = require('mysql');
const Tesla = require('teslajs');
const WS13 = require('websocket13');

const Config = require('./config.json');
const WebSocketProxy = require('./components/websocket_proxy.js');
const log = require('./components/log.js');

const DOOR_DRIVER = 1 << 0;
const DOOR_PASSENGER = 1 << 1;
const DOOR_REAR_LEFT = 1 << 2;
const DOOR_REAR_RIGHT = 1 << 3;
const DOOR_FRUNK = 1 << 4;
const DOOR_LIFTGATE = 1 << 5;
const DOOR_SUNROOF = 1 << 6;
const DOOR_LOCKED = 1 << 7;

const CLIMATE_ON = 1 << 0;
const CLIMATE_PRECONDITIONING = 1 << 1;
const CLIMATE_BATTERY_HEATER = 1 << 2;

const VehicleState = {
	"Unknown": 0,
	"Charging": 1,
	"Supercharging": 2,
	"Driving": 3,
	"Parked": 4,
	"Awoken": 5,
	"ClimateOn": 6
};

const g_VehicleCommands = {
	"lock": function(callback) {
		Tesla.doorLock({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"unlock": function(callback) {
		Tesla.doorUnlock({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"start_climate": function(callback) {
		Tesla.climateStart({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"stop_climate": function(callback) {
		Tesla.climateStop({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"flash_lights": function(callback) {
		Tesla.flashLights({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"honk_horn": function(callback) {
		Tesla.honkHorn({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"start_charge": function(callback) {
		Tesla.startCharge({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"stop_charge": function(callback) {
		Tesla.stopCharge({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"open_charge_port": function(callback) {
		Tesla.openChargePort({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"close_charge_port": function(callback) {
		Tesla.closeChargePort({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"wake_up": function(callback) {
		Tesla.wakeUp({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, callback);
	},
	"vent_sunroof": function(callback) {
		Tesla.sunRoofControl({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, Tesla.SUNROOF_VENT, callback);
	},
	"close_sunroof": function(callback) {
		Tesla.sunRoofControl({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, Tesla.SUNROOF_CLOSED, callback);
	},
	"trigger_homelink": function(callback) {
		triggerHomeLink(callback);
	}
};

const g_VehicleCommandsWithRefresh = ["lock", "unlock", "start_climate", "stop_climate", "wake_up", "vent_sunroof", "close_sunroof", "open_charge_port", "close_charge_port", "start_charge", "stop_charge"];

var g_VehicleStateInterval = {}; // these are in minutes
g_VehicleStateInterval[VehicleState.Unknown] = 1;
g_VehicleStateInterval[VehicleState.Charging] = 5;
g_VehicleStateInterval[VehicleState.Supercharging] = 1;
g_VehicleStateInterval[VehicleState.Driving] = 1;
g_VehicleStateInterval[VehicleState.Parked] = 30;
g_VehicleStateInterval[VehicleState.Awoken] = 1;
g_VehicleStateInterval[VehicleState.ClimateOn] = 1;

var g_BearerToken;
var g_BearerTokenExpiresTime = Infinity;
var g_DB;
var g_CurrentState = VehicleState.Unknown;
var g_LastState = VehicleState.Unknown;
var g_LastStateChange = 0;
var g_PollTimer;
var g_LastPoll = 0;
var g_DataListenerSockets = [];

if (!process.env.ENCRYPTION_KEY) {
	log("Encryption key needed");
	process.exit(1);
}

g_DB = MySQL.createConnection(Config.mysql);
g_DB.connect((err) => {
	if (err) {
		throw err;
	}
	
	log("Connected to MySQL with thread ID " + g_DB.threadId);
	auth();
});

function auth() {
	log("Decrypting refresh token");
	var refreshToken = McCrypto.decrypt(process.env.ENCRYPTION_KEY, new Buffer(Config.tesla.encryptedToken, 'base64'));
	
	log("Obtaining new bearer token...");
	Tesla.refreshToken(refreshToken, (err, res) => {
		if (err) {
			throw err;
		}
		
		var body = JSON.parse(res.body);
		
		if (!body || !body.access_token || !body.refresh_token || !body.expires_in) {
			throw new Error("Got malformed response");
		}
		
		log("Got new refresh token " + body.refresh_token.substring(0, 6) + "...");
		g_BearerToken = body.access_token;
		Config.tesla.encryptedToken = McCrypto.encrypt(McCrypto.Cipher.AES256CTRWithHMAC, process.env.ENCRYPTION_KEY, body.refresh_token).toString('base64');
		FS.writeFileSync(__dirname + '/config.json', JSON.stringify(Config, undefined, "\t"));
		
		g_BearerTokenExpiresTime = Date.now() + (1000 * (body.expires_in - (60 * 60)));
		getData();
	});
}

function getData() {
	clearTimeout(g_PollTimer);

	if (g_BearerTokenExpiresTime <= Date.now()) {
		g_BearerTokenExpiresTime = Infinity;
		auth();
		return;
	}

	if (Date.now() - g_LastPoll < 10000) {
		// last poll was <10 seconds ago
		enqueueRequest();
		return;
	}
	
	log("Requesting data");
	var options = {"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId};
	
	Tesla.vehicleData(options, function(err, result) {
		if (err) {
			log("Can't get vehicle data: " + (err.message || err));
			enqueueRequest();
			return;
		}

		g_DataListenerSockets.forEach((socket) => {
			socket.send(JSON.stringify({"type": "vehicle_update", "data": result}));
		});

		let state = getState(result);
		if (state != g_CurrentState) {
			log("State is now " + state + " (was " + g_CurrentState + ")");
			g_LastState = g_CurrentState;
			g_CurrentState = state;
			g_LastStateChange = Date.now();
		}
		
		var charge = result.charge_state;
		var climate = result.climate_state;
		var drive = result.drive_state;
		var vehicle = result.vehicle_state;
		
		var climateFlags = flagify(climate, {"is_climate_on": CLIMATE_ON, "smart_preconditioning": CLIMATE_PRECONDITIONING});
		if (charge.battery_heater_on) {
			climateFlags |= CLIMATE_BATTERY_HEATER;
		}
		
		var doorFlags = flagify(vehicle, {"df": DOOR_DRIVER, "pf": DOOR_PASSENGER, "dr": DOOR_REAR_LEFT, "pr": DOOR_REAR_RIGHT, "ft": DOOR_FRUNK, "rt": DOOR_LIFTGATE, "locked": DOOR_LOCKED});
		if (vehicle.sun_roof_percent_open > 0) {
			doorFlags |= DOOR_SUNROOF;
		}

		let chargeState = charge.charging_state;
		if (chargeState === null) {
			chargeState = charge.charge_port_door_open ? 'Complete' : 'Disconnected';
		}
		
		var cols = {
			"timestamp": Math.floor(Date.now() / 1000),
			"charging_state": chargeState,
			"battery_level": charge.battery_level,
			"battery_range": charge.battery_range,
			"charge_rate": charge.charge_rate,
			"inside_temp": climate.inside_temp,
			"outside_temp": climate.outside_temp,
			"climate_flags": climateFlags,
			"speed": drive.speed,
			"latitude": drive.latitude,
			"longitude": drive.longitude,
			"heading": drive.heading,
			"gps_as_of": drive.gps_as_of,
			"door_flags": doorFlags,
			"odometer": vehicle.odometer,
			"charge_state": JSON.stringify(charge),
			"climate_state": JSON.stringify(climate),
			"drive_state": JSON.stringify(drive),
			"vehicle_state": JSON.stringify(vehicle)
		};
		
		g_DB.query("INSERT INTO `tesla_data` SET ?", [cols], (err) => {
			if (err) {
				throw err;
			}
			
			log("Recorded data in database at time " + cols.timestamp);
			enqueueRequest();
		});
	});
}

function enqueueRequest() {
	clearTimeout(g_PollTimer);

	let timeout = g_VehicleStateInterval[g_CurrentState];
	let usingLast = false;

	if (Date.now() - g_LastStateChange < 1000 * 60 * 10) {
		timeout = Math.min(timeout, g_VehicleStateInterval[g_LastState]);
		usingLast = true;
	}

	log("Enqueueing next request in " + timeout + " minute(s) due to state " + g_CurrentState + (usingLast ? " (and previous " + g_LastState + ")" : ""));
	g_PollTimer = setTimeout(getData, 1000 * 60 * timeout);
}

function getState(response) {
	if (response.charge_state && response.charge_state.charging_state == "Charging" && response.charge_state.fast_charger_present) {
		return VehicleState.Supercharging;
	}

	if (response.charge_state && response.charge_state.charging_state == "Charging") {
		return VehicleState.Charging;
	}

	if (response.drive_state && response.drive_state.shift_state) {
		return VehicleState.Driving;
	}

	if (response.climate_state && response.climate_state.is_climate_on) {
		return VehicleState.ClimateOn;
	}

	return VehicleState.Parked;
}

function flagify(obj, flags) {
	var out = 0;
	
	for (var flag in flags) {
		if (flags.hasOwnProperty(flag) && obj.hasOwnProperty(flag) && obj[flag]) {
			out |= flags[flag];
		}
	}
	
	return out;
}

// Set up the HTTP server
var webServer = HTTP.createServer((req, res) => {
	if (req.method == 'GET' && req.url == '/vehicle_state') {
		req.on('data', () => {});
		res.setHeader("Content-Type", "application/json; charset=UTF-8");
		res.end(JSON.stringify({"current_state": g_CurrentState, "last_state": g_LastState, "now": Date.now(), "last_change": g_LastStateChange}));
	} else if (req.method == 'POST' && req.url == '/awake') {
		log("Awoken from external input");

		g_LastState = g_CurrentState;
		g_CurrentState = VehicleState.Awoken;
		g_LastStateChange = Date.now();
		getData();

		req.on('data', () => {});
		res.statusCode = 204;
		res.statusMessage = "No Content";
		res.end();
	} else if (req.method == 'POST' && req.url.match(/^\/command\/[a-z_]+$/) && g_VehicleCommands[req.url.substring(9)]) {
		let command = req.url.substring(9);
		log("Received command " + command);

		res.setHeader("Content-Type", "application/json; charset=UTF-8");
		g_VehicleCommands[command]((err) => {
			if (err) {
				log("Cannot send command " + command + ": " + err.message);
				res.end(JSON.stringify({"success": false, "error": err.message}));
			} else {
				log("Sent command " + command + " successfully");
				res.end(JSON.stringify({"success": true}));

				if (g_VehicleCommandsWithRefresh.includes(command)) {
					setTimeout(getData, 1000);
				}
			}
		});
	} else {
		log("Internal URL not found: " + req.method + " \"" + req.url + "\"");
		res.statusCode = 404;
		res.statusMessage = "Not Found";
		res.setHeader("Content-Type", "text/plain; charset=UTF-8");
		res.end("Not Found");
	}
});
webServer.listen(Config.httpPort || 2019, "127.0.0.1");

// Set up the WebSocket server
var wsServer = new WS13.WebSocketServer({"pingInterval": 1000, "pingTimeout": 2000});
wsServer.http(webServer);
wsServer.on('handshake', (handshakeData, reject, accept) => {
	var match = handshakeData.path.match(/^\/connect\/(\d+)\/?$/);
	if (!match && handshakeData.path != "/wsdata/") {
		reject(404, "Not Found");
		return;
	}

	if (!Config.tesla.email || !Config.tesla.websocketPassword) {
		reject(400, "No email or WebSocket password configured");
		return;
	}
	
	if (handshakeData.query.password != Config.tesla.websocketPassword) {
		reject(403, "Incorrect password");
		return;
	}

	if (handshakeData.path == "/wsdata/") {
		log("Incoming WS data socket connection from " + handshakeData.remoteAddress);
		var client = accept({
			"options": {
				"pingInterval": 30000
			}
		});
		g_DataListenerSockets.push(client);

		client.on('disconnected', (code, reason, initiatedByUs) => {
			log("Client from " + handshakeData.remoteAddress + " disconnected: \"" + reason + "\" (" + code + ")");
			var idx = g_DataListenerSockets.indexOf(client);
			if (idx != -1) {
				g_DataListenerSockets.splice(idx, 1);
			}
		});

		client.on('error', (err) => {
			log("Client from " + handshakeData.remoteAddress + " experienced error: " + err.message);
			var idx = g_DataListenerSockets.indexOf(client);
			if (idx != -1) {
				g_DataListenerSockets.splice(idx, 1);
			}
		});

		return;
	}

	var vehicleId = match[1];
	// Get the vehicle tokens
	Tesla.allVehicles({"authToken": g_BearerToken}, (err, vehicles) => {
		if (err) {
			log("Cannot retrieve vehicle list: " + err.message);
			reject(502, "Cannot get vehicle list");
			return;
		}

		vehicles = vehicles.filter(vehicle => vehicle.vehicle_id == vehicleId);
		if (vehicles.length != 1) {
			log("Cannot find vehicle " + vehicleId);
			reject(400, "Cannot find requested vehicle");
			return;
		}

		var vehicle = vehicles[0];
		if (!vehicle.tokens || !vehicle.tokens[0]) {
			log("No vehicle token for vehicle " + vehicleId);
			reject(500, "Cannot get vehicle token");
			return;
		}

		// Establish our connection
		log("Connecting to: wss://" + Config.tesla.email + ":" + vehicle.tokens[0] + "@streaming.vn.teslamotors.com/connect/" + vehicleId);
		var wsClient = new WS13.WebSocket("wss://" + Config.tesla.email + ":" + vehicle.tokens[0] + "@streaming.vn.teslamotors.com/connect/" + vehicleId);
		wsClient.on('connected', onConnect);
		wsClient.on('disconnected', onDisconnect);
		wsClient.on('error', onError);

		function onConnect(details) {
			log("Connected to Tesla WebSocket API");
			cleanup();
			var sock = accept();
			new WebSocketProxy(sock, wsClient);

			// We need the vehicle's GPS position
			Tesla.driveState({"authToken": g_BearerToken, "vehicleID": vehicle.id_s}, (err, driveState) => {
				if (err) {
					log("Cannot get drive state: " + err.message);
					return;
				}

				sock.send(JSON.stringify({
					"msg_type": "internal:gps",
					"latitude": driveState.latitude,
					"longitude": driveState.longitude,
					"heading": driveState.heading
				}));
			});
		}

		function onDisconnect(code, reason, initiatedByUs) {
			log("Disconnected from Tesla WebSocket API: " + code + " (" + reason + ")");
			cleanup();
			reject(502, "Cannot connect to streaming API: " + code);
		}

		function onError(err) {
			log("Error from Tesla WebSocket API: " + err.message);
			cleanup();
			reject(502, "Cannot connect to streaming API");
		}

		function cleanup() {
			wsClient.removeListener('connected', onConnect);
			wsClient.removeListener('disconnected', onDisconnect);
			wsClient.removeListener('error', onError);
		}
	});
});

function triggerHomeLink(callback) {
	// This is a bit more involved than it really needs to be
	Tesla.allVehicles({"authToken": g_BearerToken}, (err, vehicles) => {
		if (err) {
			callback(err);
			return;
		}

		var vehicle = vehicles.filter(vehicle => vehicle.id_s == Config.tesla.vehicleId);
		if (vehicle.length != 1) {
			callback(new Error("Cannot find vehicle"));
			return;
		}

		if (!vehicle[0].tokens || !vehicle[0].tokens[0]) {
			callback(new Error("No tokens found"));
			return;
		}

		var driveStateFailed = null;
		var latitude = null;
		var longitude = null;

		Tesla.driveState({"authToken": g_BearerToken, "vehicleID": Config.tesla.vehicleId}, (err, driveState) => {
			if (err) {
				driveStateFailed = err;
				return;
			}

			latitude = driveState.latitude;
			longitude = driveState.longitude;
		});

		var success = false;

		var otherVehicleId = vehicle[0].vehicle_id;
		var token = vehicle[0].tokens[0];
		var ws = new WS13.WebSocket("wss://" + Config.tesla.email + ":" + token + "@streaming.vn.teslamotors.com/connect/" + otherVehicleId);
		ws.on('connected', () => {
			log("WS connected to Tesla API");
		});

		ws.on('disconnected', (code, reason, initiatedByUs) => {
			if (initiatedByUs) {
				log("Successfully disconnected from Tesla WS API");
			} else {
				log("Disconnected from Tesla WS API: " + code + " (" + reason + ")");
				if (!success) {
					callback(new Error("Disconnected from Tesla"));
				}
			}
		});

		ws.on('error', (err) => {
			log("Got error with Tesla WS API: " + err.message);
			if (!success) {
				callback(err);
			}
		});

		ws.on('message', (type, data) => {
			data = data.toString('utf8');
			try {
				data = JSON.parse(data);
			} catch (ex) {
				callback(ex);
				return;
			}

			if (data.msg_type == 'homelink:status') {
				// that's our cue
				var attempts = 0;
				tryExecHomeLink();

				function tryExecHomeLink() {
					if (driveStateFailed) {
						callback(driveStateFailed);
						return;
					}

					if (!latitude || !longitude) {
						if (++attempts > 30) {
							callback(new Error("Cannot get drive state"));
							try {
								ws.disconnect(1000);
							} catch (ex) {
								// whatever
							}
							return;
						}
						setTimeout(tryExecHomeLink, 100);
						return;
					}

					// we have our drive state
					log("Sending HomeLink trigger command");
					ws.send(JSON.stringify({
						"msg_type": "homelink:cmd_trigger",
						"latitude": latitude,
						"longitude": longitude
					}));
				}
			} else if (data.msg_type == 'homelink:cmd_result') {
				success = true;

				if (data.result) {
					// success
					callback(null);
				} else {
					callback(new Error(data.reason || "Could not trigger HomeLink"));
				}

				try {
					ws.disconnect(1000);
				} catch (ex) {
					// don't care
				}
			}
		});
	});
}
