'use strict';

// The loopback-only experiment pauses one request after it captures its SQL snapshot.
function refillGate(app, validItem) {
  let active = null;

  app.post('/__test/refill-gate/arm', (req, res) => {
    if (active?.state === 'blocked' || active?.state === 'armed') return res.sendStatus(409);
    const { itemId } = req.body ?? {};
    if (!validItem(itemId)) return res.sendStatus(400);
    active = { itemId, state: 'armed' };
    return res.json({ state: active.state });
  });
  app.get('/__test/refill-gate', (_req, res) => res.json({ state: active?.state ?? 'idle' }));
  app.post('/__test/refill-gate/release', (_req, res) => {
    if (active?.state !== 'blocked') return res.sendStatus(409);
    active.release('released');
    return res.json({ state: active.state });
  });

  return {
    async afterSnapshot(itemId) {
      if (active?.state !== 'armed' || active.itemId !== itemId) return;
      const operation = active;
      operation.state = 'blocked';
      await new Promise((resolve) => {
        const timeout = setTimeout(() => operation.release('timed_out'), 2000);
        operation.release = (state) => {
          clearTimeout(timeout);
          operation.state = state;
          resolve();
        };
      });
    },
  };
}

module.exports = { refillGate };
