<script>
  let {
    value = $bindable(),
    min = '',
    label = '',
    selectLabel,
    changeLabel,
    hint = '',
    displayValue = '',
  } = $props();

  let inputEl = $state(null);

  function onInput(event) {
    value = event.target.value;
  }

  function openPicker() {
    const input = inputEl;
    if (!input) {
      return;
    }

    // A transparent input does not open the native picker on click.
    // showPicker() has to run in this gesture, on a field that is still rendered.
    if (typeof input.showPicker === 'function') {
      try {
        input.showPicker();
        return;
      } catch {
        // Some browsers reject showPicker outside a direct click. Fall through.
      }
    }

    input.focus();
    input.click();
  }
</script>

<div class="meeting-time-picker">
  {#if label}
    <span class="consultation-field__label">{label}</span>
  {/if}
  <div class="meeting-time-picker__row">
    {#if value}
      <span class="consultation-field__value meeting-time-picker__value">{displayValue || value}</span>
    {/if}
    <button
      type="button"
      class="meeting-time-picker__trigger"
      class:meeting-time-picker__trigger--change={Boolean(value)}
      onclick={openPicker}
    >
      {value ? changeLabel : selectLabel}
    </button>
    <input
      bind:this={inputEl}
      type="datetime-local"
      class="meeting-time-picker__input"
      tabindex="-1"
      aria-hidden="true"
      min={min || undefined}
      value={value ?? ''}
      oninput={onInput}
      onchange={onInput}
    />
  </div>
  {#if hint}
    <span class="meeting-time-picker__hint">{hint}</span>
  {/if}
</div>
