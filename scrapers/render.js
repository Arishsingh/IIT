/**
 * Rendering pages that need a real browser.
 *
 * A few sites build their faculty list with JavaScript, or refuse plain HTTP
 * clients outright (e.g. IIT Indore answers 403 to anything that isn't a
 * browser). For those departments ("render": true in iits.json) we load the
 * page in a real Chromium:
 *   - inside the desktop app: a hidden, sandboxed Electron window (no extra download)
 *   - from the CLI: Puppeteer, if it is installed (npm i puppeteer)
 * Otherwise a clear error explains how to get these departments.
 *
 * Same politeness rules as plain fetches: robots.txt and 1 request/sec per host.
 */
const { isAllowedByRobots, waitForSlot } = require('./utils');

// In plain Node, require('electron') returns the path to the binary (a string).
let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.BrowserWindow) electron = e;
} catch {}

const TAG = 'IITProfessorFinder/1.0 (student research-internship tool)';

async function renderWithElectron(url, { waitFor, timeout }) {
  await electron.app.whenReady();
  const win = new electron.BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, images: false },
  });
  // Keep Chromium's normal UA (some sites reject anything else) but say who we are.
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} ${TAG}`);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await win.loadURL(url).catch(() => {}); // SPA routers sometimes abort the initial navigation
    const deadline = Date.now() + timeout;
    const check = waitFor
      ? `!!document.querySelector(${JSON.stringify(waitFor)})`
      : 'document.readyState === "complete"';
    while (Date.now() < deadline) {
      if (await win.webContents.executeJavaScript(check).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 1500)); // let late items finish rendering
    return await win.webContents.executeJavaScript('document.documentElement.outerHTML');
  } finally {
    win.destroy();
  }
}

let browserPromise = null;
async function renderWithPuppeteer(url, { waitFor, timeout }) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error('this site needs a real browser: use the desktop app, or run "npm i puppeteer" for the CLI');
  }
  browserPromise ??= puppeteer.launch({ headless: true });
  const browser = await browserPromise;
  const page = await browser.newPage();
  try {
    await page.setUserAgent(`${await browser.userAgent()} ${TAG}`.replace('HeadlessChrome', 'Chrome'));
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    if (waitFor) await page.waitForSelector(waitFor, { timeout }).catch(() => {});
    return await page.content();
  } finally {
    await page.close();
  }
}

async function renderHtml(url, { waitFor, timeout = 30000 } = {}) {
  if (!(await isAllowedByRobots(url))) throw new Error(`Blocked by robots.txt: ${url}`);
  await waitForSlot(new URL(url).host);
  return electron ? renderWithElectron(url, { waitFor, timeout }) : renderWithPuppeteer(url, { waitFor, timeout });
}

/** Close Puppeteer (CLI) so the process can exit. */
async function closeRenderer() {
  if (browserPromise) (await browserPromise).close();
  browserPromise = null;
}

module.exports = { renderHtml, closeRenderer, hasElectron: () => Boolean(electron) };
