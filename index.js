const dgram = require('dgram');
const path = require('path');

const PLUGIN_ID = 'signalk-autopilot-simrad';
const UI_ROUTE = `/${PLUGIN_ID}`;
const REST_BASE_PATH = `/plugins/${PLUGIN_ID}`;

const MODE_MAP = {
  standby: 0,
  auto: 1,
  wind: 2,
  track: 3
};

function normalizeDegrees(deg) {
  if (!Number.isFinite(deg)) {
    return null;
  }
  let value = deg % 360;
  if (value < 0) {
    value += 360;
  }
  return value;
}

function radiansToDegrees(rad) {
  return (rad * 180) / Math.PI;
}

function pack127237({ sid, headingRefMag, mode, commandedHeadingDeg }) {
  const payload = Buffer.alloc(16, 0xff);

  payload.writeUInt8(sid & 0xff, 0);

  const headingReferenceBits = headingRefMag ? 1 : 0;
  const modeBits = MODE_MAP[mode] ?? MODE_MAP.standby;
  payload.writeUInt8((headingReferenceBits & 0x03) | ((modeBits & 0x07) << 2), 1);

  payload.writeInt16LE(0, 2);

  let headingToSteer = 0xffff;
  if (typeof commandedHeadingDeg === 'number') {
    const radians = (commandedHeadingDeg * Math.PI) / 180;
    headingToSteer = Math.round(radians * 10000) & 0xffff;
  }
  payload.writeUInt16LE(headingToSteer, 4);

  return payload;
}

function payloadToHexString(payload) {
  return Array.from(payload)
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(',');
}

module.exports = function simradAutopilotPlugin(app) {
  const plugin = {};

  let udpSocket;
  let config = {
    enabled: true,
    ydwgHost: '192.168.4.1',
    ydwgPort: 1456,
    src: 25,
    dst: 255,
    headingReference: 'magnetic'
  };

  let headingMagDeg = null;
  let headingTrueDeg = null;
  let currentHeadingDeg = null;
  let commandedHeadingDeg = null;
  let sid = 0;
  let subscriptions = [];
  let routesRegistered = false;
  let putHandlersRegistered = false;
  let webAppRegistered = false;

  function updateCurrentHeading() {
    const preferTrue = config.headingReference === 'true';
    const candidate = preferTrue
      ? (headingTrueDeg ?? headingMagDeg)
      : (headingMagDeg ?? headingTrueDeg);

    if (typeof candidate === 'number') {
      currentHeadingDeg = normalizeDegrees(candidate);
    }
  }

  function openUdpSocket() {
    closeUdpSocket();
    udpSocket = dgram.createSocket('udp4');
    udpSocket.on('error', (err) => {
      app.error(`Simrad autopilot UDP error: ${err.message}`);
      if (app.setPluginError) {
        app.setPluginError(err.message);
      }
    });
  }

  function closeUdpSocket() {
    if (udpSocket) {
      try {
        udpSocket.close();
      } catch (err) {
        app.error(`Failed to close UDP socket: ${err.message}`);
      }
    }
    udpSocket = null;
  }

  function buildYdrawFrame(pgn, payload) {
    const priority = 3;
    const length = payload.length;
    const src = config.src & 0xff;
    const dst = config.dst & 0xff;
    const hex = payloadToHexString(payload);
    const line = `YDRAW,${priority},${pgn},${src},${dst},${length},${hex}\r\n`;
    return Buffer.from(line, 'ascii');
  }

  function send127237({ mode, heading }) {
    if (!udpSocket) {
      app.error('Simrad autopilot UDP socket is not initialised');
      return;
    }
    const normalisedHeading = typeof heading === 'number' ? normalizeDegrees(heading) : null;
    const payload = pack127237({
      sid: (sid = (sid + 1) & 0xff),
      headingRefMag: config.headingReference !== 'true',
      mode,
      commandedHeadingDeg: normalisedHeading
    });
    const frame = buildYdrawFrame(127237, payload);
    udpSocket.send(frame, config.ydwgPort, config.ydwgHost, (err) => {
      if (err) {
        app.error(`Failed to send PGN 127237: ${err.message}`);
        if (app.setPluginError) {
          app.setPluginError(err.message);
        }
      } else {
        app.debug(
          `Sent Simrad autopilot command mode=${mode} heading=${
            normalisedHeading != null ? normalisedHeading.toFixed(1) : 'NA'
          } to ${config.ydwgHost}:${config.ydwgPort}`
        );
        if (app.setPluginStatus) {
          app.setPluginStatus(
            `Sending PGN 127237 to ${config.ydwgHost}:${config.ydwgPort}`
          );
        }
      }
    });
  }

  function nudgeHeading(deltaDeg) {
    const base =
      typeof commandedHeadingDeg === 'number'
        ? commandedHeadingDeg
        : typeof currentHeadingDeg === 'number'
        ? currentHeadingDeg
        : null;
    if (base == null) {
      return null;
    }
    commandedHeadingDeg = normalizeDegrees(base + deltaDeg);
    send127237({ mode: 'auto', heading: commandedHeadingDeg });
    return commandedHeadingDeg;
  }

  function setHeadingDegrees(heading, mode = 'auto') {
    if (!Number.isFinite(heading)) {
      return { ok: false, statusCode: 400, message: 'Heading must be a finite number' };
    }
    commandedHeadingDeg = normalizeDegrees(heading);
    send127237({ mode, heading: commandedHeadingDeg });
    return { ok: true, heading: commandedHeadingDeg };
  }

  function applyMode(mode) {
    if (!Object.prototype.hasOwnProperty.call(MODE_MAP, mode)) {
      return { ok: false, statusCode: 400, message: `Unsupported mode "${mode}"` };
    }
    if (mode === 'auto' && typeof commandedHeadingDeg !== 'number') {
      if (typeof currentHeadingDeg !== 'number') {
        return { ok: false, statusCode: 409, message: 'No heading available to engage auto mode' };
      }
      commandedHeadingDeg = currentHeadingDeg;
    }
    if (mode === 'standby') {
      commandedHeadingDeg = null;
    }
    send127237({ mode, heading: commandedHeadingDeg });
    return { ok: true, heading: commandedHeadingDeg };
  }

  function applyCommand(command) {
    if (typeof command === 'number') {
      return setHeadingDegrees(command, 'auto');
    }

    if (typeof command === 'string') {
      const lowered = command.toLowerCase();
      if (lowered === 'plus1' || lowered === '+1') {
        const heading = nudgeHeading(1);
        if (heading == null) {
          return { ok: false, statusCode: 409, message: 'No heading available for +1 command' };
        }
        return { ok: true, heading };
      }
      if (lowered === 'minus1' || lowered === '-1') {
        const heading = nudgeHeading(-1);
        if (heading == null) {
          return { ok: false, statusCode: 409, message: 'No heading available for -1 command' };
        }
        return { ok: true, heading };
      }
      if (lowered === 'plus10' || lowered === '+10') {
        const heading = nudgeHeading(10);
        if (heading == null) {
          return { ok: false, statusCode: 409, message: 'No heading available for +10 command' };
        }
        return { ok: true, heading };
      }
      if (lowered === 'minus10' || lowered === '-10') {
        const heading = nudgeHeading(-10);
        if (heading == null) {
          return { ok: false, statusCode: 409, message: 'No heading available for -10 command' };
        }
        return { ok: true, heading };
      }
      if (lowered === 'tack') {
        const heading = nudgeHeading(100);
        if (heading == null) {
          return { ok: false, statusCode: 409, message: 'No heading available for tack command' };
        }
        return { ok: true, heading };
      }
      if (lowered === 'gybe' || lowered === 'jibe') {
        const heading = nudgeHeading(-100);
        if (heading == null) {
          return { ok: false, statusCode: 409, message: 'No heading available for gybe command' };
        }
        return { ok: true, heading };
      }
      return applyMode(lowered);
    }

    if (command && typeof command === 'object') {
      if (Object.prototype.hasOwnProperty.call(command, 'heading')) {
        return setHeadingDegrees(command.heading, command.mode ?? 'auto');
      }
      if (Object.prototype.hasOwnProperty.call(command, 'delta')) {
        const heading = nudgeHeading(Number(command.delta));
        if (heading == null) {
          return { ok: false, statusCode: 409, message: 'No heading available to adjust' };
        }
        return { ok: true, heading };
      }
      if (Object.prototype.hasOwnProperty.call(command, 'action')) {
        return applyCommand(command.action);
      }
      if (Object.prototype.hasOwnProperty.call(command, 'mode')) {
        return applyMode(command.mode);
      }
    }

    return { ok: false, statusCode: 400, message: 'Unsupported command payload' };
  }

  function respond(res, result) {
    if (result.ok) {
      res.json({ ok: true, heading: result.heading ?? null });
    } else {
      res.status(result.statusCode ?? 400).json({ ok: false, error: result.message });
    }
  }

  function startSubscriptions() {
    stopSubscriptions();

    if (!app.streambundle || typeof app.streambundle.getSelfStream !== 'function') {
      app.error('Signal K streambundle is not available; heading tracking disabled');
      return;
    }

    const subscribe = (path, handler) => {
      try {
        const stream = app.streambundle.getSelfStream(path);
        if (stream && typeof stream.onValue === 'function') {
          const unsubscribe = stream.onValue(handler);
          if (typeof unsubscribe === 'function') {
            subscriptions.push(unsubscribe);
          }
        }
      } catch (err) {
        app.error(`Failed to subscribe to ${path}: ${err.message}`);
      }
    };

    subscribe('navigation.headingMagnetic', (value) => {
      if (typeof value === 'number') {
        headingMagDeg = normalizeDegrees(radiansToDegrees(value));
        updateCurrentHeading();
      }
    });

    subscribe('navigation.headingTrue', (value) => {
      if (typeof value === 'number') {
        headingTrueDeg = normalizeDegrees(radiansToDegrees(value));
        updateCurrentHeading();
      }
    });

    const passivePaths = [
      'navigation.courseRhumbline.crossTrackError',
      'navigation.courseRhumbline.bearingToDestination',
      'navigation.courseRhumbline.nextPoint.distance',
      'environment.wind.angleApparent',
      'environment.wind.angleTrueWater'
    ];
    passivePaths.forEach((path) => subscribe(path, () => {}));
  }

  function stopSubscriptions() {
    subscriptions.forEach((unsubscribe) => {
      try {
        if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      } catch (err) {
        app.error(`Failed to unsubscribe: ${err.message}`);
      }
    });
    subscriptions = [];
    headingMagDeg = null;
    headingTrueDeg = null;
    currentHeadingDeg = null;
  }

  function registerPutHandlers() {
    if (!app.registerPutHandler || putHandlersRegistered) {
      return;
    }

    app.registerPutHandler('vessels.self', 'steering.autopilot.command', (_context, _path, value, callback) => {
      const result = applyCommand(value);
      if (result.ok) {
        callback({ state: 'SUCCESS', statusCode: 200 });
      } else {
        callback({
          state: 'FAILURE',
          statusCode: result.statusCode ?? 400,
          message: result.message
        });
      }
    });

    putHandlersRegistered = true;
  }

  function unregisterPutHandlers() {
    if (!putHandlersRegistered || !app.unregisterPutHandler) {
      putHandlersRegistered = false;
      return;
    }

    app.unregisterPutHandler('vessels.self', 'steering.autopilot.command');
    putHandlersRegistered = false;
  }

  function addRoutes(router) {
    if (routesRegistered) {
      return;
    }

    router.post('/standby', (_req, res) => {
      respond(res, applyMode('standby'));
    });

    router.post('/auto', (_req, res) => {
      respond(res, applyMode('auto'));
    });

    router.post('/wind', (_req, res) => {
      respond(res, applyMode('wind'));
    });

    router.post('/track', (_req, res) => {
      respond(res, applyMode('track'));
    });

    router.post('/plus1', (_req, res) => {
      const heading = nudgeHeading(1);
      if (heading == null) {
        res.status(409).json({ ok: false, error: 'No heading available to adjust' });
        return;
      }
      res.json({ ok: true, heading });
    });

    router.post('/minus1', (_req, res) => {
      const heading = nudgeHeading(-1);
      if (heading == null) {
        res.status(409).json({ ok: false, error: 'No heading available to adjust' });
        return;
      }
      res.json({ ok: true, heading });
    });

    router.post('/plus10', (_req, res) => {
      const heading = nudgeHeading(10);
      if (heading == null) {
        res.status(409).json({ ok: false, error: 'No heading available to adjust' });
        return;
      }
      res.json({ ok: true, heading });
    });

    router.post('/minus10', (_req, res) => {
      const heading = nudgeHeading(-10);
      if (heading == null) {
        res.status(409).json({ ok: false, error: 'No heading available to adjust' });
        return;
      }
      res.json({ ok: true, heading });
    });

    router.post('/tack', (_req, res) => {
      const heading = nudgeHeading(100);
      if (heading == null) {
        res.status(409).json({ ok: false, error: 'No heading available for tack' });
        return;
      }
      res.json({ ok: true, heading });
    });

    router.post('/gybe', (_req, res) => {
      const heading = nudgeHeading(-100);
      if (heading == null) {
        res.status(409).json({ ok: false, error: 'No heading available for gybe' });
        return;
      }
      res.json({ ok: true, heading });
    });

    router.post('/setHeading', (req, res) => {
      const fromBody = req.body && Number(req.body.heading);
      const fromQuery = req.query && Number(req.query.heading);
      const heading = Number.isFinite(fromBody) ? fromBody : fromQuery;
      respond(res, setHeadingDegrees(heading, 'auto'));
    });

    routesRegistered = true;
  }

  function registerWebApp() {
    if (webAppRegistered) {
      return;
    }

    if (typeof app.registerPluginWebapp === 'function') {
      try {
        app.registerPluginWebapp(
          plugin.id,
          plugin.name,
          path.join(__dirname, 'public')
        );
        webAppRegistered = true;
        app.debug(`Registered Simrad autopilot UI at ${UI_ROUTE}`);
      } catch (err) {
        app.error(`Failed to register Simrad autopilot UI: ${err.message}`);
      }
      return;
    }

    app.debug(
      `Signal K host does not support registerPluginWebapp; UI not exposed at ${UI_ROUTE}.`
    );
  }

  function unregisterWebApp() {
    if (!webAppRegistered) {
      return;
    }

    if (typeof app.unregisterPluginWebapp === 'function') {
      try {
        app.unregisterPluginWebapp(plugin.id);
      } catch (err) {
        app.error(`Failed to unregister Simrad autopilot UI: ${err.message}`);
      }
    }

    webAppRegistered = false;
  }

  plugin.id = PLUGIN_ID;
  plugin.name = 'Simrad Autopilot (TP22/TP32) – NMEA 2000';
  plugin.description = 'Control Simrad tillerpilots via PGN 127237 sent as UDP YDRAW frames.';

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enabled',
        default: config.enabled
      },
      ydwgHost: {
        type: 'string',
        title: 'Gateway host/IP',
        default: config.ydwgHost
      },
      ydwgPort: {
        type: 'number',
        title: 'Gateway UDP port',
        default: config.ydwgPort
      },
      src: {
        type: 'number',
        title: 'NMEA 2000 source address (0-252)',
        default: config.src
      },
      dst: {
        type: 'number',
        title: 'Destination address (255 for broadcast)',
        default: config.dst
      },
      headingReference: {
        type: 'string',
        title: 'Heading reference for commands',
        enum: ['magnetic', 'true'],
        default: config.headingReference
      }
    }
  };

  plugin.registerWithRouter = (router) => {
    const wasRegistered = routesRegistered;
    addRoutes(router);
    if (!wasRegistered && routesRegistered) {
      app.debug(`Simrad autopilot REST endpoints mounted at ${REST_BASE_PATH}/*`);
    }
  };

  plugin.start = (options) => {
    config = Object.assign({}, config, options || {});
    commandedHeadingDeg = null;
    openUdpSocket();
    startSubscriptions();
    registerPutHandlers();
    registerWebApp();
    updateCurrentHeading();
    app.debug(
      `Simrad autopilot plugin started; sending PGN 127237 to ${config.ydwgHost}:${config.ydwgPort}`
    );
    if (app.setPluginStatus) {
      app.setPluginStatus(
        `Ready to send PGN 127237 to ${config.ydwgHost}:${config.ydwgPort}`
      );
    }
  };

  plugin.stop = () => {
    stopSubscriptions();
    unregisterPutHandlers();
    unregisterWebApp();
    closeUdpSocket();
    commandedHeadingDeg = null;
    if (app.setPluginStatus) {
      app.setPluginStatus('Simrad autopilot plugin stopped');
    }
    app.debug('Simrad autopilot plugin stopped');
  };

  return plugin;
};
