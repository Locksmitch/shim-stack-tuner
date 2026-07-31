/* =========================================================
   LIVE SYNC — pushes the current visual state to any open pop-out windows via
   BroadcastChannel, and persists the latest snapshot to localStorage (SNAPSHOT_KEY) so a
   pop-out opened after the last broadcast still paints immediately on open instead of
   sitting blank until the next change on the main page.
   ========================================================= */
import { lsGet, lsSet } from './storage.js';

const CHANNEL_NAME = 'sst-live-visuals';
const SNAPSHOT_KEY = 'sst_live_visuals_v1';

let channel = null;
function getChannel() {
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

// Merges `partial` into the last known snapshot - each visual broadcasts only its own
// slice (e.g. {stack: {...}}), so producers never need to know about each other or
// re-send state they didn't just recompute.
export function broadcastLiveVisuals(partial) {
  const snapshot = Object.assign({}, lsGet(SNAPSHOT_KEY), partial);
  lsSet(SNAPSHOT_KEY, snapshot);
  getChannel().postMessage(snapshot);
}

export function readLiveVisualsSnapshot() {
  return lsGet(SNAPSHOT_KEY);
}

// Returns an unsubscribe function.
export function subscribeLiveVisuals(callback) {
  const ch = getChannel();
  const handler = (e) => callback(e.data);
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}
