import { writable } from 'svelte/store';

/** Shared clock for availability badges and calendar "today" highlighting. */
export const availabilityNow = writable(Date.now());

const INTERVAL_MS = 60_000;

let refcount = 0;
/** @type {ReturnType<typeof setInterval> | undefined} */
let timer;

export function subscribeAvailabilityClock() {
  refcount += 1;
  if (refcount === 1) {
    timer = setInterval(() => {
      availabilityNow.set(Date.now());
    }, INTERVAL_MS);
  }
}

export function unsubscribeAvailabilityClock() {
  refcount = Math.max(0, refcount - 1);
  if (refcount === 0 && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
