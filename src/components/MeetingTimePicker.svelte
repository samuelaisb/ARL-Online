<script module>
  function toLocalInputValue(date) {
    const local = new Date(date);
    local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
    return local.toISOString().slice(0, 16);
  }

  /** Current local time as a datetime-local value (YYYY-MM-DDTHH:mm). */
  export function nowLocalInputValue() {
    return toLocalInputValue(new Date());
  }

  /**
   * Parses a datetime-local value as local time. Built from its parts instead of
   * Date.parse, which older Safari reads as UTC. Returns null when invalid.
   */
  export function parseMeetingTimeInput(raw) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw?.trim() ?? '');
    if (!match) {
      return null;
    }

    const [, year, month, day, hour, minute, second] = match.map(Number);
    const date = new Date(year, month - 1, day, hour, minute, second || 0);
    if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }

    return date;
  }
</script>

<script>
  // A visible native datetime-local field. Tapping it opens the system picker on
  // iOS and Android; desktop browsers show editable date and time segments.
  // (A hidden input driven by showPicker() did nothing on iOS Safari.)
  // iOS enforces neither min nor max in its picker, so callers still check the time.
  // No fallbacks on the bindable props: callers bind to per-row maps that start
  // empty, and Svelte throws on bind:x={undefined} when x has a fallback.
  let { value = $bindable(), error = $bindable(), min = '', label, hint = '' } = $props();

  const id = $props.id();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const minValue = $derived(min || nowLocalInputValue());
  // A max keeps Chrome's year segment to 4 digits; meetings are booked weeks out, not years.
  const maxValue = toLocalInputValue(new Date(Date.now() + 366 * 24 * 60 * 60 * 1000));

  let inputEl = $state(null);

  const describedBy = $derived([hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined);

  /** Moves focus to the field, e.g. after the caller rejects its value. */
  export function focus() {
    inputEl?.focus();
  }

  function onInput(event) {
    value = event.target.value;
    error = '';
  }
</script>

<div class="meeting-time-picker">
  <label class="consultation-field__label meeting-time-picker__label" for={id}>{label}</label>
  <input
    bind:this={inputEl}
    {id}
    type="datetime-local"
    class="meeting-time-picker__input"
    min={minValue}
    max={maxValue}
    value={value ?? ''}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={describedBy}
    oninput={onInput}
    onchange={onInput}
  />
  {#if hint}
    <span id={hintId} class="meeting-time-picker__hint">{hint}</span>
  {/if}
  {#if error}
    <span id={errorId} class="meeting-time-picker__error">{error}</span>
  {/if}
</div>
