// Signal K plugin: Simrad Autopilot (TP22/TP32) via NMEA2000 PGN 127237
// Author: Sam Andrews

const PLUGIN_ID = 'signalk-autopilot-simrad';
const REST_BASE_PATH = `/plugins/${PLUGIN_ID}`;

function normalizeDegrees(deg) {
  if (!Number.isFinite(deg)) return null;
  let v = deg % 360;
  if (v < 0) v += 360;
  return v;
}

function radiansToDegrees(rad) {
  return (rad * 180) / Math.PI;
}

module.exports = function simradAutopilotPlugin(app) {
  const plugin = {};
  let config = {
    enabled: true,
    src: 25,
    dst: 255, // should be the pilot’s N2K address (e.g. 7)
    headingReference: 'magnetic'
  };

  let headingMagDeg = null;
  let headingTrueDeg = null;
  let currentHeadingDeg = null;
  let commandedHeadingDeg = null;
  let sid = 0;
  let subscriptions = [];
  let routesRegistered = false;

  function updateCurrentHeading() {
    const preferTrue = config.headingReference === 'true';
    const candidate = preferTrue
      ? (headingTrueDeg ?? headingMagDeg)
      : (headingMagDeg ?? headingTrueDeg);
    if (typeof candidate === 'number') {
      currentHeadingDeg = normalizeDegrees(candidate);
    }
  }

  function send127237({ mode, heading }) {
    sid = (sid + 1) & 0xff;
    const ref = config.headingReference === 'true' ? 'True' : 'Magnetic';
    const headingRad = Number.isFinite(heading) ? heading * Math.PI / 180 : undefined;

    const dst = Number(config.dst) || 255;
    const src = Number(config.src) || 25;

    // 1) Mode-only
    app.emit('nmea2000out', {
      prio: 3,
      pgn: 127237,
      dst,
      src,
      fields: {
        'SID': sid,
        'Mode': mode.charAt(0).toUpperCase() + mode.slice(1),
        'Reference': ref,
        'Commanded Rudder Angle': 0,
        'Rudder Limit': 30,
        'Off-Heading Limit': 5
      }
    });

    // 2) Mode + heading if provided
    if (headingRad != null && mode !== 'standby') {
      sid = (sid + 1) & 0xff;
      app.emit('nmea2000out', {
        prio: 3,
        pgn: 127237,
        dst,
        src,
        fields: {
          'SID': sid,
          'Mode': mode.charAt(0).toUpperCase() + mode.slice(1),
          'Reference': ref,
          'Commanded Rudder Angle': 0,
          'Rudder Limit': 30,
          'Off-Heading Limit': 5,
          'Heading Command': headingRad
        }
      });
    }

    app.debug(`PGN 127237 sent: dst=${dst} mode=${mode} heading=${heading ?? 'n/a'}`);
  }

  function nudgeHeading(deltaDeg) {
    const base =
      typeof commandedHeadingDeg === 'number'
        ? commandedHeadingDeg
        : typeof currentHeadingDeg === 'number'
        ? currentHeadingDeg
        : null;
    if (base == null) return null;
    commandedHeadingDeg = normalizeDegrees(base + deltaDeg);
    send127237({ mode: 'auto', heading: commandedHeadingDeg });
    return commandedHeadingDeg;
  }

  function setHeadingDegrees(heading, mode = 'auto') {
    if (!Number.isFinite(heading)) {
      return { ok: false, statusCode: 400, message: 'Heading must be a number' };
    }
    commandedHeadingDeg = normalizeDegrees(heading);
    send127237({ mode, heading: commandedHeadingDeg });
    return { ok: true, heading: commandedHeadingDeg };
  }

  function applyMode(mode) {
    if (mode === 'auto' && typeof commandedHeadingDeg !== 'number') {
      if (typeof currentHeadingDeg !== 'number') {
        return { ok: false, statusCode: 409, message: 'No heading available to engage auto' };
      }
      commandedHeadingDeg = currentHeadingDeg;
    }
    if (mode === 'standby') commandedHeadingDeg = null;
    send127237({ mode, heading: commandedHeadingDeg });
    return { ok: true, heading: commandedHeadingDeg };
  }

  function respond(res, result) {
    if (result.ok) res.json({ ok: true, heading: result.heading ?? null });
    else res.status(result.statusCode ?? 400).json({ ok: false, error: result.message });
  }

  function startSubscriptions() {
    stopSubscriptions();
    if (!app.streambundle) return;

    const sub = (path, handler) => {
      try {
        const stream = app.streambundle.getSelfStream(path);
        if (stream && typeof stream.onValue === 'function') {
          const unsub = stream.onValue(handler);
          if (typeof unsub === 'function') subscriptions.push(unsub);
        }
      } catch (err) {
        app.error(`Failed to subscribe ${path}: ${err.message}`);
      }
    };

    sub('navigation.headingMagnetic', (v) => {
      if (typeof v === 'number') {
        headingMagDeg = normalizeDegrees(radiansToDegrees(v));
        updateCurrentHeading();
      }
    });
    sub('navigation.headingTrue', (v) => {
      if (typeof v === 'number') {
        headingTrueDeg = normalizeDegrees(radiansToDegrees(v));
        updateCurrentHeading();
      }
    });
  }

  function stopSubscriptions() {
    subscriptions.forEach((u) => { try { u(); } catch {} });
    subscriptions = [];
    headingMagDeg = headingTrueDeg = currentHeadingDeg = null;
  }

  function addRoutes(router) {
    if (routesRegistered) return;
    router.post('/standby', (_req, res) => respond(res, applyMode('standby')));
    router.post('/auto', (_req, res) => respond(res, applyMode('auto')));
    router.post('/wind', (_req, res) => respond(res, applyMode('wind')));
    router.post('/track', (_req, res) => respond(res, applyMode('track')));
    router.post('/plus1', (_req, res) => respond(res, { ok: true, heading: nudgeHeading(1) }));
    router.post('/minus1', (_req, res) => respond(res, { ok: true, heading: nudgeHeading(-1) }));
    router.post('/plus10', (_req, res) => respond(res, { ok: true, heading: nudgeHeading(10) }));
    router.post('/minus10', (_req, res) => respond(res, { ok: true, heading: nudgeHeading(-10) }));
    router.post('/setHeading', (req, res) => {
      const h = Number(req.body?.heading);
      respond(res, setHeadingDegrees(h, 'auto'));
    });
    routesRegistered = true;
  }

  plugin.id = PLUGIN_ID;
  plugin.name = 'Simrad Autopilot (TP22/TP32) – N2K';
  plugin.description = 'Control Simrad tillerpilots via PGN 127237 (nmea2000out)';

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enabled', default: config.enabled },
      src: { type: 'number', title: 'Source Address', default: config.src },
      dst: { type: 'number', title: 'Destination Address', default: config.dst },
      headingReference: {
        type: 'string',
        title: 'Heading Reference',
        enum: ['magnetic', 'true'],
        default: config.headingReference
      }
    }
  };

  plugin.registerWithRouter = (router) => addRoutes(router);

  plugin.start = (options) => {
    config = Object.assign({}, config, options || {});
    commandedHeadingDeg = null;
    startSubscriptions();
    app.debug(`Simrad autopilot plugin started; dst=${config.dst}, src=${config.src}`);
  };

  plugin.stop = () => {
    stopSubscriptions();
    commandedHeadingDeg = null;
    app.debug('Simrad autopilot plugin stopped');
  };

  return plugin;
};
