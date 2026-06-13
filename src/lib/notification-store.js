import { writable } from 'svelte/store';

export const DEFAULT_NOTIFICATION_DURATION = 5000;

let nextId = 0;
/** When false, `notify()` is a no-op (Kimchi is asleep). */
let kimchiNotificationsEnabled = true;

const queue = writable([]);

/**
 * Read-only queue of active notifications. `KimchiNotification.svelte` stacks
 * them upward (newest anchored above the avatar).
 */
export const notifications = { subscribe: queue.subscribe };

/** Enable or disable Kimchi chat bubbles (e.g. asleep vs awake). */
export function setKimchiNotificationsEnabled(enabled) {
  kimchiNotificationsEnabled = enabled;
}

/**
 * Queue a chat-bubble notification from Kimchi.
 *
 * @param {string | { text: string, link?: { href: string, label: string } }} message
 *   Plain text, or an object with `text` and an optional trailing link.
 * @param {number} [duration] Auto-dismiss delay in ms (default 5000).
 * @param {{ force?: boolean }} [options] Pass `{ force: true }` to show while Kimchi is asleep (e.g. sleep "Zzz…").
 * @returns {number} Notification id (usable with `dismiss`), or -1 when suppressed.
 */
export function notify(message, duration = DEFAULT_NOTIFICATION_DURATION, options = {}) {
  if (!kimchiNotificationsEnabled && !options.force) {
    return -1;
  }

  const id = ++nextId;
  const content = typeof message === 'string' ? { text: message } : message;

  queue.update((items) => [...items, { id, ...content, duration }]);

  return id;
}

/** Remove a notification by id (no-op if already gone). */
export function dismiss(id) {
  queue.update((items) => items.filter((item) => item.id !== id));
}

/** Drop every queued notification. */
export function clearNotifications() {
  queue.set([]);
}
