export function createBridgeShutdown({ closeHarness, closeOpenCode, flushPrefs, unsubscribe, closeServer }) {
  let closing;
  return function shutdown() {
    if (closing) return closing;
    let resolve;
    closing = new Promise((r) => { resolve = r; });
    const invoke = (fn) => {
      try { return Promise.resolve(fn()); }
      catch (error) { return Promise.reject(error); }
    };
    // Fence native work synchronously when shutdown begins.
    const native = invoke(closeHarness);
    const openCode = invoke(closeOpenCode);
    const prefs = invoke(flushPrefs);
    const subscription = invoke(unsubscribe);
    void Promise.allSettled([native, openCode, prefs, subscription])
      .then(() => invoke(closeServer)).catch(() => {}).finally(resolve);
    return closing;
  };
}

export function installBridgeSignals({ processImpl = process, shutdown }) {
  let exiting;
  const handle = () => {
    if (!exiting) exiting = shutdown().finally(() => processImpl.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) processImpl.on(signal, handle);
  return () => {
    for (const signal of ['SIGINT', 'SIGTERM']) processImpl.removeListener(signal, handle);
  };
}
