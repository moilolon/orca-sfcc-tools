// The debugger piece's requests (named `debugger.*`) and panel events. Empty until phase 5;
// src/protocol.ts imports this file.
export {}

declare module 'orca' {
  interface PluginRequests {}
  interface PluginPanelEvents {}
}
