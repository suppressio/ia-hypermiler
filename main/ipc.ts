// main/ipc.ts — typed wrappers over ipcMain / webContents.send, keyed on the contract in
// types/ipc.ts. Handler arguments stay `unknown` on purpose: every value coming from the
// renderer is validated in the handler (CLAUDE.md, Electron security).

import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { IpcEventChannels, IpcInvokeChannels, IpcSendChannels } from '../types/ipc';

type Unvalidated<T extends unknown[]> = { [K in keyof T]: unknown };

export function handle<C extends keyof IpcInvokeChannels>(
  channel: C,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: Unvalidated<IpcInvokeChannels[C]['args']>
  ) => IpcInvokeChannels[C]['result'] | Promise<IpcInvokeChannels[C]['result']>,
): void {
  ipcMain.handle(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
}

export function listen<C extends keyof IpcSendChannels>(
  channel: C,
  listener: (event: IpcMainEvent, ...args: Unvalidated<IpcSendChannels[C]>) => void,
): void {
  ipcMain.on(channel, listener as (event: IpcMainEvent, ...args: unknown[]) => void);
}

export function sendToRenderer<C extends keyof IpcEventChannels>(
  win: BrowserWindow,
  channel: C,
  ...args: IpcEventChannels[C]
): void {
  win.webContents.send(channel, ...args);
}
