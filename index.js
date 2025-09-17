// Signal K plugin: Simrad Autopilot (TP22/TP32) via NMEA2000 PGN 127237
// Author: Sam Andrews

const dgram = require('dgram');
const path = require('path');

module.exports = function (app) {
  const plugin = {};
  let udp;

  // Default config
  let config = {
    enabled: true,
    ydwgHost: '192.168.4.1',
    ydwgPort: 1456,
    src: 25,
    dst: 255,
    headingReference: 'magnetic'
  };

  // Track headings
  let currentHeadingDeg = null;
  let commandedHeadingDeg = null;
  let sid = 0;

  // Example PGN sender (stub – fill in with your encoder later)
  function send127237({ mode, heading }) {
    sid = (sid + 1) & 0xff;
    // TODO: add your PGN 127237 encoder here
    app.debug(`Sending PGN 127237: mode=${mode}, heading=${heading}`);
  }

  function nudge(deltaDeg) {
    let base = commandedHeadingDeg ?? currentHeadingDeg;
    if (typeof base !== 'number') return;
    let next = (base + deltaDeg + 360) % 360;
    commandedHeadingDeg = next;
    send127237({ mode: 'auto', heading: commandedHeadingDeg });
  }

  plugin.id = 'signalk-autopilot-simrad';
  plugin.name = 'Simrad Autopilot (TP22/TP32) – N2K';
  plugin.description = 'Control Simrad tillerpilots via PGN 127237 over N2K.';

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enabled', default: true },
      ydwgHost: { type: 'string', title: 'Gateway Host/IP', default: config.ydwgHost },
      ydwgPort: { type: 'number', title: 'Gateway UDP Port', default: config.ydwgPort },
      src: { type: 'number', title: 'Source Address', default: config.src },
      dst: { type: 'number', title: 'Destination', default: config.dst },
      headingReference: {
        type: 'string',
        title: 'Heading Reference',
        enum: ['magnetic', 'true'],
        default: 'magnetic'
      }
    }
  };

  plugin.start = function (options) {
    config = Object.assign(config, options || {});
    udp = dgram.createSocket('udp4');

    app.debug(
      `Simrad autopilot plugin started; sending PGN 127237 to ${config.ydwgHost}:${config.ydwgPort}`
    );

    // Force-serve UI at /signalk-autopilot-simrad/
    if (app.express) {
      app.express.use(
        '/signalk-autopilot-simrad',
        app.express.static(path.join(__dirname, 'public'))
      );
      app.debug('UI forced at /signalk-autopilot-simrad');
    } else {
      app.debug('Express not available; cannot mount UI manually');
    }

    // Subscriptions for headings
    app.streambundle.getSelfStream('navigation.headingMagnetic').onValue((v) => {
      if (typeof v === 'number') {
        currentHeadingDeg = (v * 180 / Math.PI + 360) % 360;
      }
    });
    app.streambundle.getSelfStream('navigation.headingTrue').onValue((v) => {
      if (config.headingReference === 'true' && typeof v === 'number') {
        currentHeadingDeg = (v * 180 / Math.PI + 360) % 360;
      }
    });

    // REST endpoints
    const base = '/plugins/signalk-autopilot-simrad';
    app.post(base + '/standby', (_req, res) => {
      send127237({ mode: 'standby', heading: null });
      res.json({ ok: true });
    });
    app.post(base + '/auto', (_req, res) => {
      commandedHeadingDeg = commandedHeadingDeg ?? currentHeadingDeg ?? 0;
      send127237({ mode: 'auto', heading: commandedHeadingDeg });
      res.json({ ok: true, heading: commandedHeadingDeg });
    });
    app.post(base + '/wind', (_req, res) => {
      send127237({ mode: 'wind', heading: commandedHeadingDeg });
      res.json({ ok: true });
    });
    app.post(base + '/track', (_req, res) => {
      send127237({ mode: 'track', heading: commandedHeadingDeg });
      res.json({ ok: true });
    });

    app.post(base + '/plus1', (_req, res) => { nudge(+1); res.json({ ok: true, heading: commandedHeadingDeg }); });
    app.post(base + '/minus1', (_req, res) => { nudge(-1); res.json({ ok: true, heading: commandedHeadingDeg }); });
    app.post(base + '/plus10', (_req, res) => { nudge(+10); res.json({ ok: true, heading: commandedHeadingDeg }); });
    app.post(base + '/minus10', (_req, res) => { nudge(-10); res.json({ ok: true, heading: commandedHeadingDeg }); });

    app.post(base + '/setHeading', (req, res) => {
      const h = Number(req.body?.heading);
      if (!Number.isFinite(h)) {
        return res.status(400).json({ ok: false, error: 'heading required' });
      }
      commandedHeadingDeg = ((h % 360) + 360) % 360;
      send127237({ mode: 'auto', heading: commandedHeadingDeg });
      res.json({ ok: true, heading: commandedHeadingDeg });
    });
  };

  plugin.stop = function () {
    if (udp) udp.close();
    app.debug('Simrad autopilot plugin stopped');
  };

  return plugin;
};
