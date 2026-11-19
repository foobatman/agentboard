import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AgentboardApi } from '../shared/ipc';

function sub<T extends unknown[]>(channel: string, cb: (...a: T) => void): () => void {
  const h = (_e: unknown, ...a: unknown[]) => cb(...(a as T));
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api: AgentboardApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  getEnv: () => ipcRenderer.invoke(IPC.getEnv),
  onState: (cb) => sub(IPC.state, cb),
  onUsage: (cb) => sub(IPC.usage, cb),
  onNavigate: (cb) => sub(IPC.navigate, cb),
  liveUsage: () => ipcRenderer.invoke(IPC.liveUsage),
  ptyReplay: (s) => ipcRenderer.invoke(IPC.ptyReplay, s),
  ptyInput: (s, d) => ipcRenderer.send(IPC.ptyInput, s, d),
  ptyResize: (s, c, r) => ipcRenderer.send(IPC.ptyResize, s, c, r),
  onPtyData: (cb) => sub(IPC.ptyData, cb),
  addTask: (i) => ipcRenderer.invoke(IPC.addTask, i),
  previewBatch: (t) => ipcRenderer.invoke(IPC.previewBatch, t),
  answerBatch: (t) => ipcRenderer.invoke(IPC.answerBatch, t),
  answer: (id, k, t) => ipcRenderer.invoke(IPC.answer, id, k, t),
  snooze: (id, m) => ipcRenderer.invoke(IPC.snooze, id, m),
  cancelTask: (id) => ipcRenderer.invoke(IPC.cancelTask, id),
  setPaused: (p) => ipcRenderer.invoke(IPC.setPaused, p),
  restartSession: (s) => ipcRenderer.invoke(IPC.restartSession, s),
  stopSession: (s) => ipcRenderer.invoke(IPC.stopSession, s),
  copyResumeCommand: (s) => ipcRenderer.invoke(IPC.copyResumeCommand, s),
  openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
};

contextBridge.exposeInMainWorld('agentboard', api);
