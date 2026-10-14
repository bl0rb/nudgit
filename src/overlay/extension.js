// @ts-check
// Helpers for running the overlay as a browser-extension content script
// (extension/ in this repo). No import-time side effects.

/**
 * Extension mode: the overlay module was loaded from the extension's own
 * origin (web-accessible resource) and the extension runtime is available.
 * @param {string} moduleUrl - `import.meta.url` of the overlay entry
 * @param {any} [chromeApi]
 * @returns {boolean}
 */
export function detectExtensionMode(moduleUrl, chromeApi = /** @type {any} */ (globalThis).chrome) {
  return moduleUrl.startsWith('chrome-extension://') && Boolean(chromeApi?.runtime?.id);
}

/**
 * Asks the extension's service worker to save the markdown through the
 * downloads API (Save dialog). Resolves `{ canceled: true }` if the user
 * dismissed the dialog; throws on any other failure so the caller can fall
 * back to a plain Blob download.
 * @param {any} chromeApi
 * @param {string} markdown
 * @returns {Promise<{ canceled: boolean }>}
 */
export async function downloadViaExtension(chromeApi, markdown) {
  const res = await chromeApi.runtime.sendMessage({ type: 'nudgit:download', markdown });
  if (res && res.ok) return { canceled: false };
  if (res && res.canceled) return { canceled: true };
  throw new Error((res && res.error) || 'download failed');
}

/**
 * Tells the service worker whether the overlay is shown, so its badge and
 * tracking follow a close (×) click. Fire and forget.
 * @param {any} chromeApi
 * @param {boolean} visible
 * @returns {Promise<void>}
 */
export async function notifyVisibility(chromeApi, visible) {
  try {
    await chromeApi.runtime.sendMessage({ type: 'nudgit:visibility', visible });
  } catch {
    // service worker unreachable (extension reloaded): nothing to update
  }
}

const RECORDING_KEY = 'uce:recording';

/**
 * Record mode: while on, every real click on the page (not on the overlay)
 * makes the service worker save a full-page screenshot. Captures run one
 * after another with the overlay hidden. The on/off state survives reloads
 * and same-origin navigation through sessionStorage.
 * @param {{ chromeApi: any, win: Window, host: HTMLElement, onChange: (on: boolean) => void, onError: (message: string) => void }} opts
 * @returns {{ isOn: () => boolean, setOn: (on: boolean) => Promise<boolean> }}
 */
export function createClickRecorder({ chromeApi, win, host, onChange, onError }) {
  let on = false;
  /** @type {Promise<void>} */
  let queue = Promise.resolve();

  async function capture() {
    host.style.setProperty('visibility', 'hidden', 'important');
    try {
      const res = await chromeApi.runtime.sendMessage({ type: 'nudgit:screenshot', url: win.location.href });
      if (!res || !res.ok) onError((res && res.error) || 'no response');
    } catch (err) {
      onError(String((err && /** @type {Error} */ (err).message) || err));
    } finally {
      host.style.removeProperty('visibility');
    }
  }

  /** @param {MouseEvent} e */
  function onClick(e) {
    if (!e.isTrusted || e.composedPath().includes(host)) return;
    queue = queue.then(capture);
  }

  /** @param {boolean} next */
  function remember(next) {
    try {
      if (next) win.sessionStorage.setItem(RECORDING_KEY, '1');
      else win.sessionStorage.removeItem(RECORDING_KEY);
    } catch {
      // sessionStorage unavailable: recording just stops on reload
    }
  }

  /** @param {boolean} next  @param {boolean} [notify] */
  function setLocal(next, notify = true) {
    on = next;
    if (on) win.addEventListener('click', onClick, true);
    else win.removeEventListener('click', onClick, true);
    remember(on);
    if (notify) onChange(on);
  }

  /**
   * @param {boolean} next
   * @returns {Promise<boolean>} whether the recorder is on afterwards
   */
  async function setOn(next) {
    if (next === on) return on;
    if (!next) {
      setLocal(false);
      try {
        await chromeApi.runtime.sendMessage({ type: 'nudgit:recording', on: false });
      } catch {
        // service worker unreachable: nothing attached to detach
      }
      return false;
    }
    let res;
    try {
      res = await chromeApi.runtime.sendMessage({ type: 'nudgit:recording', on: true });
    } catch (err) {
      res = { ok: false, error: String((err && /** @type {Error} */ (err).message) || err) };
    }
    if (!res || !res.ok) {
      onError((res && res.error) || 'no response');
      return false;
    }
    setLocal(true);
    return true;
  }

  // The user dismissed Chrome's debugging bar: stop without detaching again.
  chromeApi.runtime.onMessage?.addListener((/** @type {any} */ message) => {
    if (message && message.type === 'nudgit:recording-stopped' && on) setLocal(false);
  });

  let resume = false;
  try {
    resume = win.sessionStorage.getItem(RECORDING_KEY) === '1';
  } catch {
    // ignore
  }
  if (resume) void setOn(true);

  return { isOn: () => on, setOn };
}
