const Karaoke = {
  DEFAULT_API_BASE: "http://localhost:3000",

  async getState() {
    const stored = await chrome.storage.local.get([
      "apiBase",
      "queue",
      "currentIndex",
      "currentUrl",
      "started",
      "lastError",
      "notice",
    ]);

    return {
      apiBase: stored.apiBase || Karaoke.DEFAULT_API_BASE,
      queue: Array.isArray(stored.queue) ? stored.queue : [],
      currentIndex: Number.isInteger(stored.currentIndex) ? stored.currentIndex : 0,
      currentUrl: stored.currentUrl || "",
      started: stored.started === true,
      lastError: stored.lastError || "",
      notice: stored.notice || "",
    };
  },

  async setState(partial) {
    await chrome.storage.local.set(partial);
    return Karaoke.getState();
  },

  async getTabId() {
    const stored = await chrome.storage.session.get("tabId");
    return Number.isInteger(stored.tabId) ? stored.tabId : null;
  },

  async setTabId(tabId) {
    await chrome.storage.session.set({ tabId });
  },

  normalizeApiBase(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      throw new Error("Enter the server address");
    }

    let url;
    try {
      url = new URL(trimmed);
    } catch (err) {
      throw new Error("Server address must start with http:// or https://");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Server address must start with http:// or https://");
    }

    return url.origin;
  },

  extractVideoId(url) {
    const match = String(url || "").match(/(?:v=|\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  },

  explainFetchError(err, apiBase) {
    if (err instanceof TypeError) {
      return `Could not reach ${apiBase}. Start the server with npm start, then try again.`;
    }
    return err.message || "Could not reach the server";
  },

  async readJson(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(`Server returned a non-JSON response (${response.status})`);
    }
    return response.json();
  },

  async fetchQueue(apiBase) {
    let response;
    try {
      response = await fetch(`${apiBase}/api/queue`, { cache: "no-store" });
    } catch (err) {
      throw new Error(Karaoke.explainFetchError(err, apiBase));
    }

    if (!response.ok) {
      throw new Error(`Queue request failed (${response.status})`);
    }

    const data = await Karaoke.readJson(response);
    if (!Array.isArray(data)) {
      throw new Error("Queue response was not a list");
    }
    return data;
  },

  async clearQueue(apiBase) {
    let response;
    try {
      response = await fetch(`${apiBase}/api/queue`, {
        method: "DELETE",
        cache: "no-store",
      });
    } catch (err) {
      throw new Error(Karaoke.explainFetchError(err, apiBase));
    }

    if (!response.ok) {
      let message = `Could not clear the queue (${response.status})`;
      try {
        const data = await Karaoke.readJson(response);
        if (data.error) message = data.error;
      } catch (err) {
        // The status line is enough when the body is not JSON.
      }
      throw new Error(message);
    }
  },

  reconcilePosition(queue, state) {
    if (!queue.length) {
      return { currentIndex: 0, currentUrl: "", started: false };
    }

    if (state.started && state.currentUrl) {
      const indexStillMatches =
        state.currentIndex >= 0 &&
        state.currentIndex < queue.length &&
        queue[state.currentIndex].url === state.currentUrl;
      if (indexStillMatches) {
        return {
          currentIndex: state.currentIndex,
          currentUrl: state.currentUrl,
          started: true,
        };
      }

      // The song at that slot changed. Prefer the copy nearest the old index
      // so a repeated link does not snap back to the first one.
      let nearest = -1;
      let nearestDistance = Infinity;
      queue.forEach((item, index) => {
        if (item.url !== state.currentUrl) return;
        const distance = Math.abs(index - state.currentIndex);
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      });
      if (nearest !== -1) {
        return {
          currentIndex: nearest,
          currentUrl: state.currentUrl,
          started: true,
        };
      }
    }

    const currentIndex = Math.max(0, Math.min(state.currentIndex, queue.length - 1));
    return {
      currentIndex,
      currentUrl: state.started ? queue[currentIndex].url || "" : "",
      started: state.started,
    };
  },

  async refreshFromServer() {
    const state = await Karaoke.getState();
    try {
      const queue = await Karaoke.fetchQueue(state.apiBase);
      const position = Karaoke.reconcilePosition(queue, state);
      return Karaoke.setState({
        queue,
        currentIndex: position.currentIndex,
        currentUrl: position.currentUrl,
        started: position.started,
        lastError: "",
      });
    } catch (err) {
      return Karaoke.setState({
        lastError: err.message || "Could not reach the server",
      });
    }
  },

  async openWatchPage(url) {
    const existingId = await Karaoke.getTabId();
    if (existingId != null) {
      try {
        const existing = await chrome.tabs.get(existingId);
        const sameVideo =
          Karaoke.extractVideoId(existing.url) !== null &&
          Karaoke.extractVideoId(existing.url) === Karaoke.extractVideoId(url);
        if (sameVideo) {
          // A second copy of the same link would otherwise stay on the first one.
          await chrome.tabs.update(existingId, { url: "about:blank" });
          await Karaoke.waitForTabComplete(existingId);
        }
        const tab = await chrome.tabs.update(existingId, { url, active: true });
        if (tab.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return tab.id;
      } catch (err) {
        // The saved tab was closed. Open a new one below.
      }
    }

    const windowId = await Karaoke.normalWindowId();
    const created = await chrome.tabs.create({
      url,
      active: true,
      ...(Number.isInteger(windowId) ? { windowId } : {}),
    });
    if (created.windowId != null) {
      await chrome.windows.update(created.windowId, { focused: true });
    }
    return created.id;
  },

  async normalWindowId() {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const focused = windows.find((win) => win.focused);
    return (focused || windows[0] || {}).id;
  },

  waitForTabComplete(tabId) {
    return new Promise((resolve) => {
      const finish = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timeout);
        resolve();
      };
      const onUpdated = (updatedId, info) => {
        if (updatedId === tabId && info.status === "complete") finish();
      };
      const timeout = setTimeout(finish, 1500);
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  },
};
