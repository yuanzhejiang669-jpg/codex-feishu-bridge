function createWindowReadiness(showWindow) {
  if (typeof showWindow !== "function") throw new TypeError("showWindow must be a function");

  let ready = false;
  let pending = false;

  return {
    requestShow() {
      if (!ready) {
        pending = true;
        return false;
      }
      showWindow();
      return true;
    },
    markReady() {
      ready = true;
      if (!pending) return false;
      pending = false;
      showWindow();
      return true;
    },
    snapshot() {
      return { ready, pending };
    },
  };
}

module.exports = { createWindowReadiness };
