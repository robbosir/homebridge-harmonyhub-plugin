
var Discover = require('@harmonyhub/discover').Explorer;
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var _ = require('lodash');
var Promise = require('bluebird');
var Hub = require('./hub').Hub;
var Connection = require('./helper/hub-connection');
var AccessoryBase = require('./accessory-base').AccessoryBase;

var Events = {
	DiscoveredHubs: 'discoveredHubs'
};

module.exports = function() {
	return Homebridge;
};
module.exports.Events = Events;
module.exports.Homebridge = Homebridge;

var singleton;

function Homebridge(log, config, api) {
	EventEmitter.call(this);

	this.log = log;

	if (!config) {
		log.warn("Ignoring Harmony Platform setup because it is not configured");
		this.disabled = true;
		return;
	}

	if (singleton) {
		log.warn("Ignoring duplicate Harmony Platform.  Only one platform can be defined.  Multi-Hub support is now built into the platform, so multiple definitions are no longer required.");
		this.disabled = true;
		return;
	}

	singleton = this;

	var self = this;
	self._discoveredHubs = [];
	self._cachedAccessories = [];
	self._hubs = {};
	self._hubIndex = [];
	self._isInitialized = false;
	self._autoAddNewHubs = false;
	self._discover = new Discover(61991);
	self._discover.on('update', function (hubs) {
		self.log('received update event from harmonyhubjs-discover. there are ' + hubs.length + ' hubs');
		self._discoveredHubs = hubs;
		_.forEach(self._discoveredHubs, self._handleDiscoveredHubAsync.bind(self));
		self.emit(Events.DiscoveredHubs, hubs);
	});
	
	self._discover.start();

	if (api) {
		// Save the API object as plugin needs to register new accessory via this object.
		self._api = api;

		// Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories
		// Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
		// Or start discover new accessories
		self._api.on('didFinishLaunching', self._finishInitialization.bind(self));
	}
}
util.inherits(Homebridge, EventEmitter);

Homebridge.prototype._finishInitialization = function() {
	var self = this;
	return this._finishInitializationAsync()
		.catch(function(err) {
			self.log.error('Error finishing initialization of HarmonyHub: ' + (err ? (err.stack || err.message || err) : err));
		});
};

Homebridge.prototype._finishInitializationAsync = function() {
	this.log("Finalizing Plugin Launch");
	var self = this;
	return Promise
		.map(self._cachedAccessories, function(acc) {
			acc.updateReachability(false);
			var hubId = acc && acc.context && acc.context.hubId;
			if (!hubId) return;
			var hub = self._hubs[hubId];
			if (hub) return;
			hub = new Hub(self.log);
			self._hubs[hubId] = hub;
			self._hubIndex.push(hubId);
			return self._refreshHubAccessoriesAsync(hubId, hub, false);
		})
		.then(function(){
			self._autoAddNewHubs = true;
			return this._discoveredHubs || [];
		})
		.map(self._handleDiscoveredHubAsync.bind(self))
		.then(function() {
			self._isInitialized = true;
		});
};

Homebridge.prototype._handleDiscoveredHubAsync = function(hubInfo) {
	if (!this._autoAddNewHubs) return;

	var hubId = hubInfo.uuid;
	if (!hubId) return;

	var hub = this._hubs[hubId];
	if (hub && hub.connection) return;

	var conn = new Connection(hubInfo, this.log, this._discover);
	if (!hub) {
		hub = new Hub(this.log, conn);
		this._hubs[hubId] = hub;
		this._hubIndex.push(hubId);
	} else {
		hub.updateConnection(conn);
	}

	return conn.connectAsync(hubInfo)
		.then(this._refreshHubAccessoriesAsync.bind(this, hubId, hub, true));
};

Homebridge.prototype._refreshHubAccessoriesAsync = function(hubId, hub, doRegister) {
	var self = this;
	var cachedAccList = _.filter(self._cachedAccessories, function(acc) {
		return acc && acc.context && acc.context.hubId == hubId;
	});
	var task = hub.updateAccessoriesAsync(cachedAccList);
	if (doRegister) {
		task = task
			.tap(function(accList) {
				if (!self._api) return;
				accList = _.map(accList, function(acc) {
					return (acc instanceof AccessoryBase) ? acc.accessory : acc;
				});
				var newAccList = _.difference(accList, cachedAccList);
				self._api.registerPlatformAccessories("homebridge-harmonyhub", "HarmonyHub", newAccList);
			});
	}
	return task;
};

Homebridge.prototype.configureAccessory = function(accessory) {
	if (singleton && singleton != this) {
		return singleton.configureAccessory(accessory);
	}
	if (this.disabled) {
		return false;
	}
	this.log("Plugin - Configure Accessory: " + accessory.displayName);
	if (this._cachedAccessories == null) this._cachedAccessories = [];
	this._cachedAccessories.push(accessory);
};