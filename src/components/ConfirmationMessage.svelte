<script>
  import { CONFIRMATION_MESSAGE_MAX } from '../lib/expertise-fields.js';

  // Optional note to the member, sent with the Schedule / Approve that follows it.
  // No fallback on `value`: callers bind to per-row maps that start empty (see MeetingTimePicker).
  let { value = $bindable(), label, hint = '' } = $props();

  const id = $props.id();
  const hintId = `${id}-hint`;
</script>

<div class="confirmation-message">
  <label class="consultation-field__label" for={id}>{label}</label>
  <textarea
    {id}
    class="confirmation-message__input"
    rows="2"
    maxlength={CONFIRMATION_MESSAGE_MAX}
    aria-describedby={hint ? hintId : undefined}
    value={value ?? ''}
    oninput={(event) => (value = event.target.value)}
  ></textarea>
  {#if hint}
    <span id={hintId} class="meeting-time-picker__hint">{hint}</span>
  {/if}
</div>
