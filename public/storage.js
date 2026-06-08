(function () {
  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota or private mode */
    }
  }

  function remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  function clearAllAppData() {
    remove("shipmozo-chat-v1");
    remove("shipmozo-docs-v1");
  }

  window.DevHelperStorage = {
    KEYS: {
      CHAT: "shipmozo-chat-v1",
      DOCS: "shipmozo-docs-v1",
      TESTING: "shipmozo-testing-v1",
    },
    loadJson,
    saveJson,
    remove,
    clearAllAppData,
  };
})();
