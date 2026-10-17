/* Each tab owns its Workers, request queue and recognition session. */
(function (root) {
  'use strict';
  let nextSession = 0;

  function createId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      const bytes = new Uint32Array(4);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes, value => value.toString(16)).join('-');
    }
    return Date.now().toString(36) + '-' + (++nextSession) + '-' + Math.random().toString(36).slice(2);
  }

  function closeBitmap(message) {
    try {
      if (message && message.bitmap && typeof message.bitmap.close === 'function') message.bitmap.close();
    } catch (error) { /* Already released or transferred. */ }
  }

  function createWorkerClient(url, options) {
    options = options || {};
    const sessionId = options.sessionId || createId();
    const timeoutMs = options.timeoutMs || 30000;
    const queue = [];
    let worker = null;
    let active = null;
    let nextRequest = 0;

    function dispose() {
      if (worker) worker.terminate();
      worker = null;
      if (active) {
        clearTimeout(active.timer);
        active.resolve(null);
        active = null;
      }
      while (queue.length) {
        const pending = queue.shift();
        closeBitmap(pending.payload);
        pending.resolve(null);
      }
    }

    function dispatchNext() {
      if (!worker || active || !queue.length) return;
      active = queue.shift();
      const pending = active;
      // A queued request gets its full processing timeout after work starts.
      pending.timer = setTimeout(dispose, timeoutMs);
      try {
        const message = Object.assign({}, pending.payload, { sessionId, id: pending.id });
        worker.postMessage(message, pending.transfer);
      } catch (error) {
        closeBitmap(pending.payload);
        dispose();
      }
    }

    try {
      if (typeof root.Worker === 'function') worker = new root.Worker(url);
      if (worker) {
        worker.onmessage = function (event) {
          const data = event.data || {};
          if (!active || data.sessionId !== sessionId || data.id !== active.id) {
            closeBitmap(data);
            return;
          }
          const pending = active;
          clearTimeout(pending.timer);
          active = null;
          if (data.error) closeBitmap(data);
          pending.resolve(data.error ? null : data);
          dispatchNext();
        };
        worker.onerror = dispose;
        worker.onmessageerror = dispose;
      }
    } catch (error) { dispose(); }

    return {
      sessionId,
      get available() { return Boolean(worker); },
      request: function (payload, transfer) {
        if (!worker) {
          closeBitmap(payload);
          return Promise.resolve(null);
        }
        // Capture settings before waiting for another recognition request.
        const snapshot = Object.assign({}, payload);
        if (snapshot.options) snapshot.options = Object.assign({}, snapshot.options);
        return new Promise(resolve => {
          queue.push({ id: ++nextRequest, payload: snapshot, transfer: transfer ? transfer.slice() : [], resolve });
          dispatchNext();
        });
      },
      dispose
    };
  }

  root.ScanSession = { createId, createWorkerClient };
})(typeof window !== 'undefined' ? window : self);
