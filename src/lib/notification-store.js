import { writable } from 'svelte/store';

export const DEFAULT_NOTIFICATION_DURATION = 5000;

let nextId = 0;

const queue = writable([]);

/**
 * Read-only queue of active notifications. `KimchiNotification.svelte` stacks
 * them upward (newest anchored above the avatar).
 */
export const notifications = { subscribe: queue.subscribe };

/**
 * Queue a chat-bubble notification from Kimchi.
 *
 * @param {string | { text: string, link?: { href: string, label: string } }} message
 *   Plain text, or an object with `text` and an optional trailing link.
 * @param {number} [duration] Auto-dismiss delay in ms (default 5000).
 * @returns {number} Notification id (usable with `dismiss`).
 */
export function notify(message, duration = DEFAULT_NOTIFICATION_DURATION) {
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
