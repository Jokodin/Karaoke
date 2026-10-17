const statusEl = document.getElementById("status");
const noticeEl = document.getElementById("notice");
const errorEl = document.getElementById("error");
const nowTitleEl = document.getElementById("now-title");
const queueEl = document.getElementById("queue");
const apiBaseEl = document.getElementById("api-base");
const prevBtn = document.getElementById("prev");
const playBtn = document.getElementById("play");
const nextBtn = document.getElementById("next");
const clearBtn = document.getElementById("clear");
const popoutBtn = document.getElementById("popout");
const saveBtn = document.getElementById("save-api");

const isPanel = new URLSearchParams(window.location.search).has("panel");
let busy = false;
let apiDirty = false;

if (isPanel) {
  popoutBtn.hidden = true;
  document.documentElement.classList.add("panel");
}

function setMessage(element, text) {
  element.hidden = !text;
  element.textContent = text || "";
}

function render(state) {
  const count = state.queue.length;
  statusEl.textContent = count === 1 ? "1 song" : `${count} songs`;

  setMessage(errorEl, state.lastError);
  setMessage(noticeEl, state.notice);

  if (state.started && state.queue[state.currentIndex]) {
    const current = state.queue[state.currentIndex];
    nowTitleEl.textContent = current.title || current.url;
    playBtn.textContent = "Replay";
  } else {
    nowTitleEl.textContent = count ? "Press Play to start" : "Queue is empty";
    playBtn.textContent = "Play";
  }

  if (!apiDirty) {
    apiBaseEl.value = state.apiBase;
  }

  const empty = count === 0;
  prevBtn.disabled = busy || empty || !state.started || state.currentIndex <= 0;
  playBtn.disabled = busy || empty;
  nextBtn.disabled = busy || empty || (state.started && state.currentIndex >= count - 1);
  clearBtn.disabled = busy || empty;

  queueEl.replaceChildren();
  if (empty) {
    const emptyRow = document.createElement("div");
    emptyRow.className = "empty";
    emptyRow.textContent = "Songs you add at the homepage will show up here.";
    queueEl.appendChild(emptyRow);
    queueEl.scrollTop = 0;
    return;
  }

  for (let index = state.queue.length - 1; index >= 0; index--) {
    const item = state.queue[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "queue-item";
    if (state.started && index === state.currentIndex) {
      button.classList.add("current");
    } else if (state.started && index < state.currentIndex) {
      button.classList.add("played");
    }
    button.textContent = item.title || item.url;
    button.disabled = busy;
    button.addEventListener("click", () => send("play", { index }));
    queueEl.appendChild(button);
  }
  queueEl.scrollTop = 0;
}

async function load() {
  if (busy) return;
  render(await Karaoke.getState());
}

async function send(type, extra) {
  const locksButtons = type !== "refresh";
  if (locksButtons) {
    busy = true;
    render(await Karaoke.getState());
  }

  try {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (locksButtons) busy = false;
    if (busy) return;

    if (!response?.ok) {
      const state = await Karaoke.getState();
      render({ ...state, lastError: response?.error || "That action failed" });
      return;
    }
    render(response.state);
  } catch (err) {
    if (locksButtons) busy = false;
    if (busy) return;
    const state = await Karaoke.getState();
    render({
      ...state,
      lastError: err.message || "Could not reach the extension",
    });
  }
}

prevBtn.addEventListener("click", () => send("prev"));
playBtn.addEventListener("click", () => send("play"));
nextBtn.addEventListener("click", () => send("next"));

clearBtn.addEventListener("click", () => {
  if (!confirm("Clear the whole queue?")) return;
  send("clear");
});

popoutBtn.addEventListener("click", async () => {
  await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?panel=1"),
    type: "popup",
    width: 400,
    height: 640,
  });
  window.close();
});

apiBaseEl.addEventListener("input", () => {
  apiDirty = true;
});

saveBtn.addEventListener("click", async () => {
  let apiBase;
  try {
    apiBase = Karaoke.normalizeApiBase(apiBaseEl.value);
  } catch (err) {
    const state = await Karaoke.getState();
    render({ ...state, lastError: err.message });
    return;
  }

  const granted = await chrome.permissions.request({ origins: [`${apiBase}/*`] });
  if (!granted) {
    const state = await Karaoke.getState();
    render({
      ...state,
      lastError: "Chrome needs permission to read that server.",
    });
    return;
  }

  apiDirty = false;
  await send("set-api-base", { apiBase });
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local" && !busy) load();
});

load();
send("refresh");
setInterval(() => {
  if (!busy) send("refresh");
}, 4000);
