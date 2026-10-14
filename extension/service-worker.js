// Service worker (module). Holds no state in globals: the set of tabs where
// nudgit is active lives in chrome.storage.session. Every handler takes the
// chrome API as its first parameter so it can be tested with a mock.

export const LOADER_FILE = 'content/loader.js';
export const STORAGE_KEY = 'nudgitActiveTabs';
const BADGE_ON = { text: 'ON', color: '#635bff' };
const BADGE_ERROR = { text: '!', color: '#d92d20' };
const DEBUGGER_VERSION = '1.3';
export const SCREENSHOT_DIR = 'nudgit-screenshots';

/**
 * @param {any} api - the chrome namespace
 * @returns {Promise<Record<string, true>>} active tab ids as keys
 */
export async function getActiveTabs(api) {
  try {
    const data = await api.storage.session.get(STORAGE_KEY);
    return data[STORAGE_KEY] || {};
  } catch (err) {
    console.warn('nudgit: could not read session state', err);
    return {};
  }
}

/**
 * @param {any} api
 * @param {number} tabId
 * @param {boolean} active
 */
export async function setTabActive(api, tabId, active) {
  try {
    const tabs = await getActiveTabs(api);
    if (active) tabs[tabId] = true;
    else delete tabs[tabId];
    await api.storage.session.set({ [STORAGE_KEY]: tabs });
  } catch (err) {
    console.warn('nudgit: could not write session state', err);
  }
}

/**
 * @param {any} api
 * @param {number} tabId
 * @param {{ text: string, color?: string }|null} badge - null clears it
 */
export async function setBadge(api, tabId, badge) {
  try {
    await api.action.setBadgeText({ tabId, text: badge ? badge.text : '' });
    if (badge && badge.color) await api.action.setBadgeBackgroundColor({ tabId, color: badge.color });
  } catch {
    // the tab may be gone already
  }
}

/**
 * Runs the loader in the tab's top frame. The loader loads the overlay on
 * the first run and toggles it afterwards.
 * @param {any} api
 * @param {number} tabId
 * @returns {Promise<{ ok: true, visible: boolean } | { ok: false, error: string }>}
 */
export async function injectLoader(api, tabId) {
  try {
    const results = await api.scripting.executeScript({ target: { tabId }, files: [LOADER_FILE] });
    const result = results && results[0] && results[0].result;
    if (result && result.ok) return { ok: true, visible: Boolean(result.visible) };
    return { ok: false, error: (result && result.error) || 'no result from content script' };
  } catch (err) {
    return { ok: false, error: String((err && /** @type {Error} */ (err).message) || err) };
  }
}

/**
 * Toggles nudgit in a tab (icon click / shortcut) and records the outcome.
 * @param {any} api
 * @param {number|undefined} tabId
 */
export async function toggleTab(api, tabId) {
  if (tabId == null) return { ok: false, error: 'no tab' };
  const res = await injectLoader(api, tabId);
  if (!res.ok) {
    await setTabActive(api, tabId, false);
    await setBadge(api, tabId, BADGE_ERROR); // e.g. chrome:// pages cannot be scripted
    return res;
  }
  await setTabActive(api, tabId, res.visible);
  await setBadge(api, tabId, res.visible ? BADGE_ON : null);
  return res;
}

/**
 * Re-injects into a tracked tab after a page load. The loader toggles when
 * the overlay already lives in the page, so flip it back if it was hidden.
 * On failure (Chrome no longer grants access) state and badge are cleared.
 * @param {any} api
 * @param {number} tabId
 */
export async function reinjectTab(api, tabId) {
  let res = await injectLoader(api, tabId);
  if (res.ok && !res.visible) res = await injectLoader(api, tabId);
  if (!res.ok || !res.visible) {
    await setTabActive(api, tabId, false);
    await setBadge(api, tabId, null);
    await setRecording(api, tabId, false); // no overlay left to stop a running recording
    return res;
  }
  await setBadge(api, tabId, BADGE_ON);
  return res;
}

/**
 * @param {any} api
 * @param {number} tabId
 * @param {{ status?: string }} changeInfo
 */
export async function handleTabUpdated(api, tabId, changeInfo) {
  if (changeInfo.status !== 'complete') return;
  const tabs = await getActiveTabs(api);
  if (tabs[tabId]) await reinjectTab(api, tabId);
}

/**
 * @param {any} api
 * @param {number} tabId
 */
export async function handleTabRemoved(api, tabId) {
  const tabs = await getActiveTabs(api);
  if (tabs[tabId]) await setTabActive(api, tabId, false);
}

/**
 * Saves the markdown through the downloads API (Save dialog).
 * @param {any} api
 * @param {string} markdown
 * @returns {Promise<{ ok: true, id: number } | { ok: false, error: string, canceled?: boolean }>}
 */
export async function downloadMarkdown(api, markdown) {
  try {
    const id = await api.downloads.download({
      url: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown),
      filename: 'ui-changes.md',
      saveAs: true,
    });
    return { ok: true, id };
  } catch (err) {
    const error = String((err && /** @type {Error} */ (err).message) || err);
    return { ok: false, error, canceled: /cancel/i.test(error) };
  }
}

/**
 * Attaches the debugger (needed for full-page screenshots; Chrome shows its
 * "started debugging this browser" bar while attached) or detaches it.
 * Attaching twice is fine, so a restarted worker can simply attach again.
 * @param {any} api
 * @param {number} tabId
 * @param {boolean} on
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function setRecording(api, tabId, on) {
  try {
    if (on) await api.debugger.attach({ tabId }, DEBUGGER_VERSION);
    else await api.debugger.detach({ tabId });
    return { ok: true };
  } catch (err) {
    const error = String((err && /** @type {Error} */ (err).message) || err);
    if (!on || /already attached/i.test(error)) return { ok: true }; // detach of a detached tab is a no-op
    return { ok: false, error };
  }
}

/**
 * @param {Date} date
 * @param {string} [pageUrl]
 * @returns {string} e.g. nudgit-screenshots/2026-10-14T12-30-05-123Z-example.com.png
 */
export function screenshotFilename(date, pageUrl) {
  let host = 'page';
  try {
    host = new URL(String(pageUrl)).hostname.replace(/[^a-z0-9.-]/gi, '_') || 'page';
  } catch {
    // keep "page"
  }
  return `${SCREENSHOT_DIR}/${date.toISOString().replace(/[:.]/g, '-')}-${host}.png`;
}

/**
 * Captures the whole page (beyond the viewport) through the debugger and
 * saves it as PNG to Downloads/nudgit-screenshots/ without a Save dialog.
 * @param {any} api
 * @param {number} tabId
 * @param {string} [pageUrl]
 * @param {Date} [now]
 * @returns {Promise<{ ok: true, filename: string } | { ok: false, error: string }>}
 */
export async function saveScreenshot(api, tabId, pageUrl, now = new Date()) {
  try {
    const attached = await setRecording(api, tabId, true);
    if (!attached.ok) return attached;
    const target = { tabId };
    const metrics = await api.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const shot = await api.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 },
    });
    const filename = screenshotFilename(now, pageUrl);
    await api.downloads.download({
      url: 'data:image/png;base64,' + shot.data,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: String((err && /** @type {Error} */ (err).message) || err) };
  }
}

/**
 * @param {any} api
 * @param {any} message
 * @param {{ id?: string, tab?: { id?: number } }} sender
 * @returns {Promise<object>|undefined} undefined when the message is not ours
 */
export function handleMessage(api, message, sender) {
  if (!message || typeof message.type !== 'string') return undefined;
  if (sender && sender.id && sender.id !== api.runtime.id) return undefined;
  if (message.type === 'nudgit:download') {
    if (typeof message.markdown !== 'string') return Promise.resolve({ ok: false, error: 'markdown missing' });
    return downloadMarkdown(api, message.markdown);
  }
  if (message.type === 'nudgit:visibility') {
    // the overlay was closed (×) or shown from inside the page
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) return Promise.resolve({ ok: false, error: 'no tab' });
    return (async () => {
      await setTabActive(api, tabId, Boolean(message.visible));
      await setBadge(api, tabId, message.visible ? BADGE_ON : null);
      return { ok: true };
    })();
  }
  if (message.type === 'nudgit:recording' || message.type === 'nudgit:screenshot') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) return Promise.resolve({ ok: false, error: 'no tab' });
    if (message.type === 'nudgit:recording') return setRecording(api, tabId, Boolean(message.on));
    return saveScreenshot(api, tabId, message.url);
  }
  return undefined;
}

/**
 * All listeners are registered synchronously at the top level so Chrome can
 * wake the worker for them.
 * @param {any} api
 */
export function registerListeners(api) {
  api.action.onClicked.addListener(async (tab) => {
    await toggleTab(api, tab && tab.id);
  });

  api.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'toggle-nudgit') return;
    let tabId = tab && tab.id;
    if (tabId == null) {
      try {
        const [active] = await api.tabs.query({ active: true, currentWindow: true });
        tabId = active && active.id;
      } catch (err) {
        console.warn('nudgit: could not find the active tab', err);
      }
    }
    await toggleTab(api, tabId);
  });

  api.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    await handleTabUpdated(api, tabId, changeInfo);
  });

  api.tabs.onRemoved.addListener(async (tabId) => {
    await handleTabRemoved(api, tabId);
  });

  // The user dismissed Chrome's debugging bar (or the tab went away): tell
  // the overlay so its Record button turns off.
  api.debugger.onDetach.addListener(async (source) => {
    if (!source || source.tabId == null) return;
    try {
      await api.tabs.sendMessage(source.tabId, { type: 'nudgit:recording-stopped' });
    } catch {
      // no overlay in that tab (closed, navigated away)
    }
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const pending = handleMessage(api, message, sender);
    if (!pending) return false;
    (async () => {
      try {
        sendResponse(await pending);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // keep the channel open for the async response
  });
}

if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id) {
  registerListeners(globalThis.chrome);
}
