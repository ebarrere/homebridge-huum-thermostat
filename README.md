# homebridge-huum-thermostat

[Homebridge](https://homebridge.io) plugin for [HUUM](https://huum.eu) sauna heaters (UKU Wi-Fi controller), exposed as a **heat-only HomeKit thermostat**.

- **Thermostat** "Sauna": Off / Heat, target 40–110 °C, current temperature.
- **Contact sensor** "Sauna Door": refuses to start with the door open (the HUUM API requires it closed).
- **Scheduled start** over a small HTTP API, so a Siri Shortcut can say "start the sauna at 6pm" (HomeKit itself can't schedule by voice).
- Polls the HUUM cloud API in the background; HomeKit reads never wait on the network.
- Published as a standalone (unbridged) accessory with no dependencies beyond Node ≥ 18.

## Install

```sh
npm install github:ebarrere/homebridge-huum-thermostat
```

Restart Homebridge, then in the Home app: **Add Accessory → More options… → Sauna XXXX**, using your Homebridge setup code (shown in the log).

## Configuration

```json
{
  "platform": "HuumHeater",
  "name": "Sauna",
  "username": "you@example.com",
  "password": "your-huum-app-password",
  "defaultTemperature": 80,
  "pollInterval": 30,
  "temperatureUnit": "F",
  "scheduleToken": "a-long-random-string"
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `username` / `password` | — | HUUM app credentials. |
| `name` | `Sauna` | Accessory and Siri name. |
| `defaultTemperature` | `80` | Target (°C) used until one is set from HomeKit; the last target is remembered. |
| `pollInterval` | `30` | Seconds, minimum 10. |
| `temperatureUnit` | `F` | Display hint only; HomeKit always works in °C. |
| `scheduleToken` | — | Enables the schedule API (below). Generate with `openssl rand -hex 32`. |
| `schedulePort` | `8582` | Schedule API port. |

## Scheduled start

Siri and Shortcuts can't delay a HomeKit action, and the HUUM API has no scheduled start, so the plugin keeps the schedule itself (persisted across restarts). It starts heating at the saved target temperature within one poll interval of the requested time.

```sh
H="Authorization: Bearer $TOKEN"; URL=http://homebridge.local:8582/schedule
curl -H "$H" -X POST $URL -d '{"at": "2026-11-06T18:00:00-07:00"}'  # schedule (ISO 8601)
curl -H "$H" $URL                                                     # show
curl -H "$H" -X DELETE $URL                                           # cancel
```

Every response is `{"scheduled": <ISO time or null>, "message": "<sentence for Siri to speak>"}`. One start at a time, up to a week ahead. A start missed by more than 15 minutes (e.g. Homebridge was down) is dropped rather than run late, and the door must still be closed when it fires.

**Shortcut:** *Ask for Input* (Date and Time) → *Format Date* (ISO 8601, include time) → *Get Contents of URL* (POST, JSON body `at` = formatted date, header `Authorization: Bearer <token>`) → *Get Dictionary Value* `message` → *Show Result*. Name it "Schedule Sauna" and say "Hey Siri, schedule sauna". The API is plain HTTP: keep it on your LAN/VPN.

## Siri

- "Turn on/off the sauna" and "set the sauna to 185 degrees" both work.
- Siri's "turn on" writes thermostat mode **Auto** regardless of the advertised modes; the plugin accepts Auto as Heat and snaps the mode back. Auto therefore appears in the Home app's mode picker.
- Siri's confirmation banner may read "Cooling to …" when setting a temperature. That wording comes from iOS, not from the plugin's state.
- If a **room** shares the accessory's name, Siri targets the room (its lights) instead. Rename one of them.

## Why not a HeaterCooler?

The Home app always renders a HeaterCooler as an air conditioner (icon and "Cooling to" wording), even when it's heat-only and unbridged, and Siri named it "Heater-Cooler". A thermostat displays and speaks correctly.

## Credits

API contract from [pyhuum](https://github.com/frwickst/pyhuum). Not affiliated with HUUM.
