import * as virtual from './virtual.js';
import * as pickup from './pickup.js';

export const MONITORS = { virtual, pickup };
export const MONITOR_NAMES = Object.keys(MONITORS);

export function getMonitor(monitorName) {
  const monitor = MONITORS[monitorName];
  if (!monitor) {
    throw new Error(`Unknown monitor "${monitorName}" — known monitors: ${MONITOR_NAMES.join(', ')}`);
  }
  return monitor;
}
