<script>
  import { onMount, tick } from 'svelte';
  import { fetchReservationMessages, sendReservationMessage } from '../lib/inventory.js';
  import { LIBRARY_TIME_ZONE } from '../lib/calendar.js';
  import { RESERVATION_MESSAGE_MAX } from '../lib/reservation-rules.js';
  import { locale, t } from '../lib/i18n.js';
  import BusyLabel from './BusyLabel.svelte';

  // A booking's conversation (016) and the field to add to it. Opening it loads the messages,
  // which marks them read for this side (`onread()` then lets the card drop its unread count).
  // A sent message joins the list and the field stays open for the next one. The other side
  // sees it on /account and gets an email only when they've read the conversation since the
  // last one. Self-contained: parents pass plain props (nothing binds into it) and hear back
  // through the callbacks. `idPrefix` is the panel's id, for the toggle's aria-controls.
  // `otherLabel` names the other side ("The host", the mentor's name, "The member").
  // `disabled` is the parent's "another action is running"; `onbusy(true|false)` tells the parent
  // this one is, so it can hold its other buttons (one action at a time).
  let {
    reservationId,
    kind = 'message',
    as = 'member',
    idPrefix,
    label,
    hint = '',
    placeholder = '',
    otherLabel = '',
    disabled = false,
    onsent,
    oncancel,
    onbusy,
    onread,
  } = $props();

  let value = $state('');
  let sending = $state(false);
  let error = $state('');
  let inputEl = $state(null);
  let sendButton = $state(null);
  let listEl = $state(null);
  /** The conversation: 'loading' | 'ready' | 'error'. */
  let threadState = $state('loading');
  let messages = $state([]);

  const inputId = $derived(`${idPrefix}-input`);
  const hintId = $derived(`${idPrefix}-hint`);
  const noteId = $derived(`${idPrefix}-note`);
  const errorId = $derived(`${idPrefix}-error`);
  const threadId = $derived(`${idPrefix}-thread`);
  const describedBy = $derived([hint ? hintId : '', noteId, error ? errorId : ''].filter(Boolean).join(' '));
  const timeFormat = $derived(
    new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: LIBRARY_TIME_ZONE,
    }),
  );

  onMount(() => {
    loadThread();
  });

  async function loadThread() {
    threadState = 'loading';
    try {
      messages = await fetchReservationMessages(reservationId, as);
      threadState = 'ready';
      onread?.();
      await scrollToLatest();
    } catch {
      threadState = 'error';
    }
  }

  async function scrollToLatest() {
    await tick();
    if (listEl) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  }

  function who(message) {
    if (message.mine) {
      return $t('reservation_message.from_you');
    }
    return message.byStaff ? $t('reservation_message.from_staff') : otherLabel;
  }

  function formatTime(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
  }

  /** Moves focus to the message field, e.g. right after the panel opens. */
  export function focus() {
    inputEl?.focus();
  }

  async function handleSend() {
    if (sending || disabled) {
      return;
    }

    if (!value.trim()) {
      error = $t('reservation_message.required');
      inputEl?.focus();
      return;
    }

    error = '';
    sending = true;
    onbusy?.(true);
    let result = null;

    try {
      result = await sendReservationMessage(reservationId, { message: value, kind, as });
    } catch (sendError) {
      error = sendError.message || $t('reservation_message.send_error');
    } finally {
      sending = false;
      onbusy?.(false);
    }

    if (result) {
      value = '';
      if (result.message && !messages.some((entry) => entry.id === result.message.id)) {
        messages = [...messages, result.message];
        if (threadState !== 'ready') {
          // The earlier messages didn't load; show at least this one.
          threadState = 'ready';
        }
      }
      onsent?.(result);
      await scrollToLatest();
      inputEl?.focus();
      return;
    }

    // Disabling the button while it ran dropped its focus; put it back for a retry.
    await tick();
    sendButton?.focus();
  }
</script>

<div id={idPrefix} class="consultation-follow-up reservation-message">
  <div class="reservation-thread">
    <p id="{threadId}-label" class="consultation-field__label">{$t('reservation_message.thread_label')}</p>
    {#if threadState === 'loading'}
      <p class="meeting-time-picker__hint" role="status">{$t('reservation_message.loading')}</p>
    {:else if threadState === 'error'}
      <p class="admin-status admin-status-error reservation-thread__status">
        {$t('reservation_message.load_error')}
        <button type="button" class="link-btn" onclick={loadThread}>{$t('reservation_message.retry')}</button>
      </p>
    {:else if messages.length === 0}
      <p class="meeting-time-picker__hint">{$t('reservation_message.empty')}</p>
    {:else}
      <!-- Scrolls on its own once it's long; focusable so a keyboard can scroll it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <ol
        bind:this={listEl}
        id={threadId}
        class="reservation-thread__list"
        aria-labelledby="{threadId}-label"
        tabindex="0"
      >
        {#each messages as message (message.id)}
          <li class="reservation-thread__message" class:reservation-thread__message--mine={message.mine}>
            <p class="reservation-thread__meta">
              <span class="reservation-thread__who">{who(message)}</span>
              <time datetime={message.createdAt}>{formatTime(message.createdAt)}</time>
              {#if message.kind === 'new_time'}
                <span class="reservation-thread__tag">{$t('reservation_message.suggested_tag')}</span>
              {/if}
            </p>
            <p class="reservation-thread__body">{message.body}</p>
          </li>
        {/each}
      </ol>
    {/if}
  </div>

  <label class="consultation-field__label" for={inputId}>{label}</label>
  <textarea
    bind:this={inputEl}
    id={inputId}
    class="confirmation-message__input reservation-message__input"
    rows="3"
    maxlength={RESERVATION_MESSAGE_MAX}
    {placeholder}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={describedBy}
    bind:value
    oninput={() => {
      if (error && value.trim()) {
        error = '';
      }
    }}
  ></textarea>
  {#if hint}
    <span id={hintId} class="meeting-time-picker__hint">{hint}</span>
  {/if}
  <span id={noteId} class="meeting-time-picker__hint">{$t('reservation_message.sharing_note')}</span>
  <div class="admin-pending-actions">
    <button
      bind:this={sendButton}
      type="button"
      class="btn-approve"
      disabled={disabled || sending}
      onclick={handleSend}
    >
      <BusyLabel
        label={$t('reservation_message.send')}
        busyLabel={$t('reservation_message.sending')}
        busy={sending}
      />
    </button>
    <button type="button" class="link-btn" disabled={sending} onclick={() => oncancel?.()}>
      {$t('reservation_message.close')}
    </button>
  </div>
  {#if error}
    <p id={errorId} class="admin-status admin-status-error reservation-message__error" role="alert">{error}</p>
  {/if}
</div>
