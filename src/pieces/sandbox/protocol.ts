// The sandbox piece's requests (named `sandbox.*`) and panel events. Empty until phase 2;
// src/protocol.ts imports this file.
export {}

declare module 'orca' {
  interface PluginRequests {}
  interface PluginPanelEvents {}
}
