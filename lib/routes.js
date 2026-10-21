/**
 * The three JSON routes the Client half polls.
 *
 * Everything is served under a plugin-owned prefix so it cannot collide with the
 * shipped app's own paths, and every handler answers JSON even on failure — a client
 * polling once a second must never receive HTML error pages.
 *
 * Request bodies are read with a hard byte cap: this endpoint accepts writes from the
 * page, so an unbounded read would be a memory hole.
 */

const PREFIX = '/dsh-stall-guard';
/** A settings document is a few hundred bytes; anything past this is not a settings document. */
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/** Read and parse one JSON request body, bounded by `MAX_BODY_BYTES`. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new Error(`request body is not valid JSON: ${error.message}`));
      }
    });
  });
}

/**
 * Register the plugin's routes on one Host context.
 *
 * `locale` is read at request time so a language switch reaches new supervisor
 * sentences without a restart.
 */
export function registerRoutes(ctx, { config, monitor, locale = () => 'zh', onChange }) {
  const disposers = [];

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/config.json`,
    handler: async (req, res) => {
      if (req.method === 'GET' || req.method === undefined) {
        sendJson(res, 200, { ok: true, config: config.get() });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `method ${req.method} is not allowed` });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const { config: stored, warnings } = config.update(body);
        // Export a change hook instead of reaching into the monitor: the route layer should
        // not need to know which settings have runtime effects.
        if (typeof onChange === 'function') {
          try {
            onChange(stored);
          } catch {
            /* a failed hook must not turn a saved config into a 400 */
          }
        }
        sendJson(res, 200, { ok: true, config: stored, warnings });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }));

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/state.json`,
    handler: (req, res) => {
      // A stale alert must not stay on screen forever if nothing else touches the monitor.
      monitor.settleAlert();
      sendJson(res, 200, monitor.snapshot());
    },
  }));

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/ack`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `method ${req.method} is not allowed` });
        return;
      }
      try {
        // Drain the (normally empty) body so the socket can be reused.
        await readJsonBody(req);
      } catch {
        /* an acknowledgement carries no data; a malformed body is not a reason to fail */
      }
      monitor.acknowledge();
      sendJson(res, 200, { ok: true, state: monitor.snapshot() });
    },
  }));

  // `locale` is accepted for parity with the guard so a future localized field can use it.
  void locale;

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* a route already removed by the fiber teardown is fine */
      }
    }
  };
}

export { PREFIX };
