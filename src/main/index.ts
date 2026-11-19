import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, powerSaveBlocker, session as electronSession, shell, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { APP, draft } from '../shared/events';
import { IPC, type EnvInfo, type QuickAddInput } from '../shared/ipc';
import { DEFAULT_CONFIG } from '../shared/types';
import { AttentionScheduler } from './attention/scheduler';
import { Orchestrator } from './app/orchestrator';
import { ElectronNotifier } from './app/electron-notifier';
import { installLaunchAgent, resolveClaude, versionOk } from './app/environment';
import { NotificationService } from './notify/notification-service';
import { PtyManager } from './pty/pty-manager';
import { abPaths, shq } from './pty/session-files';
import { EventStore, LogIntegrityError, newBootId } from './store/event-store';
import { StateHub } from './store/state-hub';

const HOME = process.env.AGENTBOARD_HOME ?? path.join(os.homedir(), 'agentboard');
function findResources(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'resources');
  for (let d = __dirname; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'resources', 'prompts', 'manager.md'))) return path.join(d, 'resources');
  }
  return path.join(app.getAppPath(), 'resources');
}
const RESOURCES = findResources();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let orch: Orchestrator | undefined;
let sched: AttentionScheduler | undefined;
let envInfo: EnvInfo = { home: HOME, versionOk: false, missingFlags: [], platform: process.platform };
let quitting = false;
let psb: number | undefined;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'agentboard',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#111317',
    show: !process.argv.includes('--background'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  w.on('close', (e) => {
    // closing the window keeps agentboard (and its sessions) running in the tray
    if (!quitting && process.platform === 'darwin') {
      e.preventDefault();
      w.hide();
    }
  });
  w.webContents.on('render-process-gone', () => setTimeout(() => w.reload(), 500));
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(path.join(__dirname, '../renderer/index.html'));
  return w;
}

function showView(view: string): void {
  if (!win) win = createWindow();
  win.show();
  win.focus();
  win.webContents.send(IPC.navigate, view);
}

function buildTray(): void {
  const iconPath = path.join(RESOURCES, 'icons', 'trayTemplate.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img);
  const refresh = () => {
    const st = orch?.hub.state;
    const open = st ? Object.values(st.attention).filter((a) => a.status === 'open').length : 0;
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open agentboard', click: () => showView('manager') },
        { label: `Needs you (${open})`, click: () => showView('needs') },
        { type: 'separator' },
        { label: st?.usage.paused ? 'Resume spawning' : 'Pause spawning', click: () => void orch?.userSetPaused(!st?.usage.paused) },
        {
          label: st?.usage.plan.fiveHour ? `Plan: 5h ${Math.round(st.usage.plan.fiveHour.usedPct)}%${st.usage.plan.sevenDay ? ` · 7d ${Math.round(st.usage.plan.sevenDay.usedPct)}%` : ''}` : 'Plan usage: waiting for first response',
          enabled: false,
        },
        { type: 'separator' },
        { label: 'Quit agentboard… (sessions resume next launch)', click: () => quit() },
      ]),
    );
  };
  refresh();
  orch?.hub.on('events', refresh);
  tray.on('click', () => showView('needs'));
}

function quit(): void {
  quitting = true;
  app.quit();
}

function broadcastState(): void {
  if (!win || win.isDestroyed() || !orch) return;
  win.webContents.send(IPC.state, orch.hub.state);
}

let stateTimer: NodeJS.Timeout | undefined;
function scheduleBroadcast(): void {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    broadcastState();
  }, 150);
}

function wireIpc(o: Orchestrator): void {
  ipcMain.handle(IPC.getState, () => o.hub.state);
  ipcMain.handle(IPC.getEnv, () => ({ ...envInfo, busUrl: o.bus.url }));
  ipcMain.handle(IPC.liveUsage, () => o.usage.live);
  ipcMain.handle(IPC.ptyReplay, (_e, s: string) => o.d.ptys.get(s)?.replay() ?? '');
  ipcMain.on(IPC.ptyInput, (_e, s: string, d: string) => o.d.ptys.get(s)?.userInput(d));
  ipcMain.on(IPC.ptyResize, (_e, s: string, c: number, r: number) => o.d.ptys.get(s)?.resize(c, r));
  ipcMain.handle(IPC.addTask, (_e, i: QuickAddInput) => o.userAddTask(i));
  ipcMain.handle(IPC.previewBatch, (_e, t: string) => o.previewBatch(t));
  ipcMain.handle(IPC.answerBatch, (_e, t: string) => o.userAnswerBatch(t));
  ipcMain.handle(IPC.answer, (_e, id: string, k?: string, t?: string) => o.userAnswer(id, { optionKey: k, text: t }));
  ipcMain.handle(IPC.snooze, (_e, id: string, m: number) => o.userSnooze(id, m));
  ipcMain.handle(IPC.cancelTask, (_e, id: string) => o.userCancelTask(id));
  ipcMain.handle(IPC.setPaused, (_e, p: boolean) => o.userSetPaused(p));
  ipcMain.handle(IPC.restartSession, (_e, s: string) => o.userRestartSession(s));
  ipcMain.handle(IPC.stopSession, (_e, s: string) => o.stopSession(s));
  ipcMain.handle(IPC.openPath, (_e, p: string) => shell.openPath(p));
  ipcMain.handle(IPC.copyResumeCommand, (_e, s: string) => {
    const sess = o.hub.state.sessions[s];
    if (!sess) return '';
    const dir = path.join(abPaths(HOME).sessions, s);
    const cmd = `cd ${shq(sess.cwd)} && claude --resume ${s} --name ${shq(sess.name)} --settings ${shq(path.join(dir, 'settings.json'))} --setting-sources project,local --mcp-config ${shq(path.join(dir, 'mcp.json'))} --strict-mcp-config`;
    clipboard.writeText(cmd);
    return cmd;
  });
  o.on('pty-data', (s: string, d: string) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.ptyData, s, d);
  });
  o.on('usage', (s: string, u: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.usage, s, u);
  });
  o.hub.on('events', () => {
    scheduleBroadcast();
    // keep the Mac awake while any session is working
    const busy = Object.values(o.hub.state.sessions).some((s) => s.state === 'busy');
    if (busy && psb === undefined) psb = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && psb !== undefined) {
      powerSaveBlocker.stop(psb);
      psb = undefined;
    }
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  // renderer may never request notification permission or raise web notifications (SPEC §8 #10)
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const paths = abPaths(HOME);
  if (!fs.existsSync(paths.repos)) fs.writeFileSync(paths.repos, JSON.stringify({ repos: {} }, null, 2));
  if (!fs.existsSync(paths.mcpCatalog)) fs.writeFileSync(paths.mcpCatalog, JSON.stringify({}, null, 2));

  const ce = await resolveClaude(process.env.AGENTBOARD_CLAUDE_PATH); // override: dev/testing
  envInfo = { home: HOME, claudePath: ce.claudePath, claudeVersion: ce.claudeVersion, versionOk: versionOk(ce.claudeVersion), missingFlags: ce.missingFlags, platform: process.platform };

  const hub = new StateHub(new EventStore(paths.events));
  let boot: Awaited<ReturnType<StateHub['boot']>>;
  try {
    boot = await hub.boot();
  } catch (e) {
    if (e instanceof LogIntegrityError) {
      const { dialog } = await import('electron');
      dialog.showErrorBox('agentboard: event log damaged', `${e.message}\n\nagentboard will not start to avoid losing data. Inspect or move ${paths.events}.`);
      app.exit(1);
      return;
    }
    throw e;
  }
  // apply config.json overrides (user-editable)
  try {
    const cfg = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    Object.assign(hub.state.config, { ...DEFAULT_CONFIG, ...cfg });
  } catch {
    fs.writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  await hub.commit(draft('app.started', APP, { version: app.getVersion(), claudeVersion: ce.claudeVersion, pid: process.pid, bootId: newBootId() }));
  if (boot.tornBytes > 0) await hub.commit(draft('log.torn_tail_repaired', APP, { bytes: boot.tornBytes, file: boot.quarantineFile ?? '' }));

  const ptys = new PtyManager((file, args, o) => pty.spawn(file, args, o));
  orch = new Orchestrator({ hub, ptys, home: HOME, resources: RESOURCES, claudePath: ce.claudePath ?? 'claude', loginPath: ce.loginPath, baseEnv: process.env });
  const notify = new NotificationService(new ElectronNotifier(() => tray));
  notify.onClick = () => showView('needs');
  sched = new AttentionScheduler(hub, notify);

  wireIpc(orch);
  await orch.start();
  buildTray();
  win = createWindow();
  sched.start(true); // boot: open items are re-alerted right away

  const hk = hub.state.config.hotkey;
  if (!globalShortcut.register(hk, () => showView('quickadd'))) {
    await hub.commit(draft('banner.shown', APP, { id: 'hotkey', level: 'warn', text: `Global hotkey ${hk} is taken by another app; change "hotkey" in ${paths.config}.` }));
  }
  if (app.isPackaged) installLaunchAgent(process.execPath);

  if (!ce.claudePath) {
    await hub.commit(draft('banner.shown', APP, { id: 'claude', level: 'error', text: 'claude CLI not found on your login-shell PATH. Install Claude Code and log in, then restart agentboard.' }));
    return;
  }
  if (!envInfo.versionOk || ce.missingFlags.length) {
    await hub.commit(
      draft('banner.shown', APP, { id: 'claude', level: 'error', text: `Claude Code ${ce.claudeVersion ?? '?'} is too old or missing flags (${ce.missingFlags.join(', ') || 'needs ≥ 2.1.224'}). Update with \`claude update\`.` }),
    );
    return;
  }
  await hub.commit(draft('banner.cleared', APP, { id: 'claude' }));
  try {
    await orch.resumeAll();
  } catch (e) {
    await hub.commit(draft('banner.shown', APP, { id: 'manager', level: 'error', text: `Could not start the manager session: ${String((e as Error).message ?? e)}` }));
  }
}

app.on('second-instance', () => showView('manager'));
app.on('activate', () => showView('manager'));
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', (e) => {
  if (!orch) return;
  e.preventDefault();
  globalShortcut.unregisterAll();
  sched?.stop();
  const o = orch;
  orch = undefined;
  void o.hub
    .commit(draft('app.stopping', APP, { reason: 'quit' }))
    .catch(() => undefined)
    .then(() => o.shutdown())
    .finally(() => app.exit(0));
});

main().catch((e) => {
  console.error('agentboard failed to start', e);
  app.exit(1);
});
