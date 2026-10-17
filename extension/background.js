importScripts("lib.js");

let chain = Promise.resolve();

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&autoplay=1`;
}

async function playLoaded(state, index) {
  if (!state.queue.length) {
    throw new Error("Queue is empty");
  }
  if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) {
    throw new Error("That song is not in the queue");
  }

  const item = state.queue[index];
  const videoId = Karaoke.extractVideoId(item.url);
  if (!videoId) {
    throw new Error("Could not find a YouTube video id in that link");
  }

  await Karaoke.setState({
    queue: state.queue,
    currentIndex: index,
    currentUrl: item.url,
    started: true,
    lastError: "",
    notice: "",
  });

  try {
    const tabId = await Karaoke.openWatchPage(watchUrl(videoId));
    await Karaoke.setTabId(tabId);
  } catch (err) {
    await Karaoke.setState({
      lastError: err.message || "Could not open YouTube",
    });
  }

  return Karaoke.getState();
}

async function playAt(index) {
  const state = await Karaoke.refreshFromServer();
  if (state.lastError && !state.queue.length) {
    throw new Error(state.lastError);
  }
  return playLoaded(state, index);
}

async function playRelative(delta) {
  const state = await Karaoke.refreshFromServer();
  if (state.lastError && !state.queue.length) {
    throw new Error(state.lastError);
  }
  if (!state.queue.length) {
    throw new Error("Queue is empty");
  }

  if (!state.started) {
    if (delta < 0) {
      return Karaoke.setState({ notice: "Already at the first song" });
    }
    return playLoaded(state, 0);
  }

  const index = state.currentIndex + delta;
  if (index < 0) {
    return Karaoke.setState({ notice: "Already at the first song" });
  }
  if (index >= state.queue.length) {
    return Karaoke.setState({ notice: "That's the last song" });
  }
  return playLoaded(state, index);
}

async function clearAll() {
  const state = await Karaoke.getState();
  await Karaoke.clearQueue(state.apiBase);
  return Karaoke.setState({
    queue: [],
    currentIndex: 0,
    currentUrl: "",
    started: false,
    lastError: "",
    notice: "Queue cleared",
  });
}

async function handle(message) {
  switch (message.type) {
    case "refresh":
      return Karaoke.refreshFromServer();
    case "play":
      if (Number.isInteger(message.index)) {
        return playAt(message.index);
      }
      {
        const state = await Karaoke.refreshFromServer();
        if (state.lastError && !state.queue.length) {
          throw new Error(state.lastError);
        }
        return playLoaded(state, state.started ? state.currentIndex : 0);
      }
    case "next":
      return playRelative(1);
    case "prev":
      return playRelative(-1);
    case "clear":
      return clearAll();
    case "set-api-base":
      await Karaoke.setState({
        apiBase: Karaoke.normalizeApiBase(message.apiBase),
        queue: [],
        currentIndex: 0,
        currentUrl: "",
        started: false,
        lastError: "",
        notice: "",
      });
      return Karaoke.refreshFromServer();
    default:
      throw new Error("Unknown action");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  enqueue(() => handle(message))
    .then((state) => sendResponse({ ok: true, state }))
    .catch((err) => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "next-song" && command !== "prev-song") return;
  enqueue(() => playRelative(command === "next-song" ? 1 : -1)).catch((err) => {
    Karaoke.setState({ lastError: err.message || "Could not change songs" });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    const saved = await Karaoke.getTabId();
    if (saved === tabId) {
      await chrome.storage.session.remove("tabId");
    }
  });
});

function ensureAlarm() {
  chrome.alarms.create("poll-queue", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "poll-queue") return;
  enqueue(() => Karaoke.refreshFromServer());
});
