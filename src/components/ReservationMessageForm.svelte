<script>
  import { tick } from 'svelte';
  import { sendReservationMessage } from '../lib/inventory.js';
  import { RESERVATION_MESSAGE_MAX } from '../lib/reservation-rules.js';
  import { t } from '../lib/i18n.js';
  import BusyLabel from './BusyLabel.svelte';

  // A note to the other side of a booking, emailed with the sender's address as Reply-To and
  // never stored. Self-contained: parents pass plain props (nothing binds into it) and hear back
  // through the callbacks. `idPrefix` is the panel's id, for the toggle's aria-controls.
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
    disabled = false,
    onsent,
    oncancel,
    onbusy,
  } = $props();

  let value = $state('');
  let sending = $state(false);
  let error = $state('');
  let inputEl = $state(null);
  let sendButton = $state(null);

  const inputId = $derived(`${idPrefix}-input`);
  const hintId = $derived(`${idPrefix}-hint`);
  const noteId = $derived(`${idPrefix}-note`);
  const errorId = $derived(`${idPrefix}-error`);
  const describedBy = $derived([hint ? hintId : '', noteId, error ? errorId : ''].filter(Boolean).join(' '));

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
      onsent?.(result);
      return;
    }

    // Disabling the button while it ran dropped its focus; put it back for a retry.
    await tick();
    sendButton?.focus();
  }
</script>

<div id={idPrefix} class="consultation-follow-up reservation-message">
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
      {$t('reservation_message.cancel')}
    </button>
  </div>
  {#if error}
    <p id={errorId} class="admin-status admin-status-error reservation-message__error" role="alert">{error}</p>
  {/if}
</div>
