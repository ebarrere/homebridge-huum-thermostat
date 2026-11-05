'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// HUUM sauna as a heat-only Thermostat. API contract: https://github.com/frwickst/pyhuum
const PLUGIN = 'homebridge-huum-thermostat';
const PLATFORM = 'HuumHeater';
const BASE = 'https://api.huum.eu/action/home';
const MIN_TEMP = 40;
const MAX_TEMP = 110;
const STATUS = {
  230: 'offline',
  231: 'heating',
  232: 'idle',
  233: 'locked by another user',
  400: 'emergency stop',
};

const MAX_SCHEDULE_AHEAD = 7 * 24 * 3600e3;
// A start missed by more than this (e.g. Homebridge was down) is dropped, not run late.
const SCHEDULE_GRACE = 15 * 60e3;

const clamp = (t) => Math.round(Math.min(MAX_TEMP, Math.max(MIN_TEMP, t)));

// Format an ISO 8601 time in its own UTC offset, so replies match the caller's clock.
function spoken(iso) {
  const m = /([+-])(\d\d):?(\d\d)$/.exec(iso);
  const offset = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = new Date(Date.parse(iso) + offset * 60e3);
  const fmt = (o) => local.toLocaleString('en-US', { timeZone: 'UTC', ...o });
  return `on ${fmt({ weekday: 'long' })} at ${fmt({ hour: 'numeric', minute: '2-digit' })}`;
}

// iOS names service tiles (and Siri targets) from ConfiguredName, not Name.
function named(service, name, C) {
  service.setCharacteristic(C.Name, name);
  if (!service.testCharacteristic(C.ConfiguredName)) service.addOptionalCharacteristic(C.ConfiguredName);
  service.getCharacteristic(C.ConfiguredName).updateValue(name);
}

module.exports = (api) => api.registerPlatform(PLUGIN, PLATFORM, HuumPlatform);

class HuumPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = [];
    api.on('didFinishLaunching', () => this.launch());
  }

  configureAccessory(accessory) {
    this.cached.push(accessory);
  }

  launch() {
    if (!this.config.username || !this.config.password) {
      this.log.error('username and password are required');
      return;
    }
    if (this.cached.length) this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, this.cached);
    const uuid = this.api.hap.uuid.generate('huum-sauna-external');
    const accessory = new this.api.platformAccessory(this.config.name || 'Sauna', uuid, this.api.hap.Categories.THERMOSTAT);
    new Sauna(this.log, this.config, this.api, accessory);
    this.api.publishExternalAccessories(PLUGIN, [accessory]);
  }
}

class Sauna {
  constructor(log, config, api, accessory) {
    this.log = log;
    this.api = api;
    this.auth = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
    this.status = null;
    this.stateFile = path.join(api.user.storagePath(), 'huum-thermostat.json');

    const { Service, Characteristic: C } = api.hap;
    this.C = C;
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {}
    this.savedTarget = clamp(saved.target ?? config.defaultTemperature ?? 80);
    this.schedule = saved.schedule ?? null; // { at: ISO 8601 string }

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'HUUM')
      .setCharacteristic(C.Model, 'UKU Wi-Fi')
      .setCharacteristic(C.SerialNumber, 'huum-sauna');

    const t = this.thermostat = accessory.getService(Service.Thermostat)
      || accessory.addService(Service.Thermostat, config.name || 'Sauna');
    t.setPrimaryService(true);
    named(t, config.name || 'Sauna', C);
    t.getCharacteristic(C.CurrentHeatingCoolingState)
      .setProps({ validValues: [C.CurrentHeatingCoolingState.OFF, C.CurrentHeatingCoolingState.HEAT] })
      .onGet(() => this.currentMode());
    // Siri's "turn on" writes AUTO regardless of validValues; accept it and treat it as HEAT.
    t.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT, C.TargetHeatingCoolingState.AUTO] })
      .onGet(() => this.targetMode())
      .onSet((v) => this.setTargetMode(v));
    t.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -20, maxValue: 130 })
      .onGet(() => this.temperature());
    // Seed directly: default props (10-38) would reject a sauna temp.
    t.getCharacteristic(C.TargetTemperature).value = this.savedTarget;
    t.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
      .onGet(() => this.target())
      .onSet((v) => this.setTarget(v));
    t.getCharacteristic(C.TemperatureDisplayUnits)
      .updateValue(config.temperatureUnit === 'C'
        ? C.TemperatureDisplayUnits.CELSIUS
        : C.TemperatureDisplayUnits.FAHRENHEIT);

    this.door = accessory.getService(Service.ContactSensor)
      || accessory.addService(Service.ContactSensor, 'Sauna Door');
    named(this.door, 'Sauna Door', C);
    this.door.getCharacteristic(C.ContactSensorState)
      .onGet(() => this.doorState());

    if (config.scheduleToken) this.serve(config.scheduleToken, config.schedulePort || 8582);
    this.poll();
    setInterval(() => this.poll(), Math.max(10, config.pollInterval || 30) * 1000);
  }

  save() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ target: this.savedTarget, schedule: this.schedule }));
    } catch (e) {
      this.log.warn(`saving state: ${e.message}`);
    }
  }

  // --- HomeKit getters: serve the last polled status, never block on the API.

  current() {
    if (!this.status || this.status.statusCode === 230) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.status;
  }

  heating() {
    return this.current().statusCode === 231;
  }

  targetMode() {
    const M = this.C.TargetHeatingCoolingState;
    return this.heating() ? M.HEAT : M.OFF;
  }

  // HEAT while warming up, OFF once holding temperature (Home shows "Idle").
  currentMode() {
    const M = this.C.CurrentHeatingCoolingState;
    return this.heating() && this.temperature() < this.target() ? M.HEAT : M.OFF;
  }

  temperature() {
    return Number(this.current().temperature) || 0;
  }

  target() {
    const t = Number(this.status?.targetTemperature);
    return this.status?.statusCode === 231 && t ? clamp(t) : this.savedTarget;
  }

  doorState() {
    return this.current().door
      ? this.C.ContactSensorState.CONTACT_DETECTED
      : this.C.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // --- HomeKit setters.

  async setTargetMode(value) {
    // HAP stores the written value after onSet resolves; snap AUTO back to the real mode afterwards.
    if (value === this.C.TargetHeatingCoolingState.AUTO) setTimeout(() => this.status && this.update(this.status), 100);
    if (value !== this.C.TargetHeatingCoolingState.OFF) {
      if (this.heating()) return;
      if (!this.current().door) this.fail('door is open; not starting');
      await this.command('start', { targetTemperature: this.savedTarget });
      if (!this.heating()) this.fail(`start refused: ${STATUS[this.status.statusCode] || this.status.statusCode}`);
    } else if (this.heating()) {
      await this.command('stop');
    }
  }

  async setTarget(value) {
    this.savedTarget = clamp(value);
    this.save();
    if (this.status?.statusCode === 231) {
      await this.command('start', { targetTemperature: this.savedTarget });
    }
  }

  // --- API.

  async request(method, path, body) {
    const res = await fetch(`${BASE}/${path}`, {
      method,
      headers: { Authorization: this.auth, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async command(path, body) {
    try {
      this.update(await this.request('POST', path, body));
      this.log.info(`${path}${body ? ` ${body.targetTemperature}°C` : ''} -> ${STATUS[this.status.statusCode] || this.status.statusCode}`);
    } catch (e) {
      this.fail(e.message);
    }
  }

  async poll() {
    try {
      this.update(await this.request('GET', 'status'));
    } catch (e) {
      this.log.warn(`status: ${e.message}`);
      return;
    }
    if (this.schedule && Date.now() >= Date.parse(this.schedule.at)) await this.runSchedule();
  }

  // --- Scheduled start (HomeKit has no voice scheduling; see README).

  async runSchedule() {
    const { at } = this.schedule;
    this.schedule = null;
    this.save();
    if (Date.now() - Date.parse(at) > SCHEDULE_GRACE) {
      this.log.warn(`skipped scheduled start for ${at}: missed by more than 15 minutes`);
      return;
    }
    this.log.info(`scheduled start for ${at}`);
    try {
      await this.setTargetMode(this.C.TargetHeatingCoolingState.HEAT);
    } catch {
      this.log.error(`scheduled start for ${at} failed (sauna ${STATUS[this.status?.statusCode] || 'unreachable'})`);
    }
  }

  scheduleMessage() {
    return this.schedule
      ? `The sauna will start heating ${spoken(this.schedule.at)}.`
      : 'No sauna start is scheduled.';
  }

  serve(token, port) {
    const expected = Buffer.from(`Bearer ${token}`);
    const authorized = (h = '') => h.length === expected.length && crypto.timingSafeEqual(Buffer.from(h), expected);
    http.createServer(async (req, res) => {
      const reply = (code, message) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ scheduled: this.schedule?.at ?? null, message }));
      };
      if (!req.url.split('?')[0].endsWith('/schedule')) return reply(404, 'Not found.');
      if (!authorized(req.headers.authorization)) return reply(401, 'Unauthorized.');
      if (req.method === 'GET') return reply(200, this.scheduleMessage());
      if (req.method === 'DELETE') {
        this.schedule = null;
        this.save();
        this.log.info('scheduled start cancelled');
        return reply(200, 'Cancelled the scheduled sauna start.');
      }
      if (req.method !== 'POST') return reply(405, 'Method not allowed.');

      let at;
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        at = String(JSON.parse(body).at);
      } catch {
        return reply(400, 'Expected JSON like {"at": "2026-11-06T18:00:00-07:00"}.');
      }
      const when = Date.parse(at);
      if (Number.isNaN(when)) return reply(400, `I couldn't read the time "${at}".`);
      if (when < Date.now() - 60e3) return reply(400, `That time (${spoken(at)}) is in the past.`);
      if (when > Date.now() + MAX_SCHEDULE_AHEAD) return reply(400, 'I can only schedule up to a week ahead.');
      this.schedule = { at };
      this.save();
      this.log.info(`start scheduled for ${at}`);
      reply(200, this.scheduleMessage());
    }).on('error', (e) => this.log.error(`schedule API: ${e.message}`))
      .listen(port, () => this.log.info(`schedule API listening on :${port}`));
  }

  update(status) {
    const prev = this.status?.statusCode;
    this.status = status;
    if (prev !== status.statusCode) this.log.info(`sauna is ${STATUS[status.statusCode] || status.statusCode}`);

    const { C, thermostat } = this;
    if (status.statusCode === 230) {
      const err = new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      thermostat.updateCharacteristic(C.TargetHeatingCoolingState, err);
      return;
    }
    thermostat.updateCharacteristic(C.TargetHeatingCoolingState, this.targetMode());
    thermostat.updateCharacteristic(C.CurrentHeatingCoolingState, this.currentMode());
    thermostat.updateCharacteristic(C.CurrentTemperature, this.temperature());
    thermostat.updateCharacteristic(C.TargetTemperature, this.target());
    this.door.updateCharacteristic(C.ContactSensorState, this.doorState());
  }

  fail(message) {
    this.log.error(message);
    throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
