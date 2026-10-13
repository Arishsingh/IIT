/**
 * Electron main process.
 *
 * All scraping happens here (Node side). The renderer talks to it only through
 * the small IPC API exposed in preload.js:
 *   suggestions()                -> city autocomplete list
 *   search(city, { refresh })    -> { iit, professors, warnings, scrapedAt, fromCache }
 *   progress events              -> human-readable status lines while scraping
 *   saveCsv(text, name)          -> native "Save as" dialog
 *   openExternal(url)            -> opens http(s) links in the default browser
 *   copy(text)                   -> puts text on the system clipboard
 *   mail:*                       -> the "Email them" section (see mail-ipc.js)
 */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const scrapers = require('../scrapers');
const { registerMailIpc } = require('./mail-ipc');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    title: 'IIT Professor Finder',
    backgroundColor: '#fafaf9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never open new Electron windows; send links to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  // Cache lives in the per-user app data folder, e.g. ~/Library/Application Support/…
  // (Falls back to the project's ./cache, if present, for instant first results.)
  scrapers.cache.setCacheDir(path.join(app.getPath('userData'), 'cache'), {
    seed: path.join(__dirname, '..', 'cache'),
  });

  ipcMain.handle('suggestions', () => scrapers.citySuggestions());

  // One scrape per IIT at a time; repeated clicks share the running job.
  const running = new Map();
  ipcMain.handle('search', async (event, city, opts = {}) => {
    const iit = scrapers.resolveCity(city);
    if (!iit) return { iit: null, professors: [], warnings: [], notFound: true, query: city };
    const key = iit.id + (opts.refresh ? ':refresh' : '');
    if (!running.has(key)) {
      const job = scrapers
        .scrapeCity(city, {
          refresh: Boolean(opts.refresh),
          onProgress: (msg) => event.sender.send('progress', msg),
        })
        .finally(() => running.delete(key));
      running.set(key, job);
    }
    try {
      return await running.get(key);
    } catch (err) {
      return { iit: scrapers.publicIit(iit), professors: [], warnings: [`Scrape failed: ${err.message}`] };
    }
  });

  ipcMain.handle('save-csv', async (_e, text, defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export professors to CSV',
      defaultPath: path.join(app.getPath('downloads'), defaultName || 'professors.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { saved: false };
    // BOM so Excel opens UTF-8 names correctly.
    fs.writeFileSync(filePath, '﻿' + text, 'utf8');
    return { saved: true, filePath };
  });

  // Main-process clipboard: works even when the window isn't focused.
  ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text || '')));

  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  registerMailIpc({ app, ipcMain, dialog, safeStorage, getWin: () => win });

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
