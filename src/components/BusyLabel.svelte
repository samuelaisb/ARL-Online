<script>
  // Button label that keeps its width while busy: the idle and busy labels share
  // one grid cell (see .busy-label in app.css). The busy text drops its trailing
  // "…" because three hopping dots replace it. Put icons outside BusyLabel.
  let { label, busyLabel, busy = false, compact = false } = $props();

  const busyText = $derived(String(busyLabel ?? label ?? '').replace(/\s*(?:…|\.\.\.)\s*$/, ''));
</script>

<span class="busy-label" class:is-busy={busy} class:busy-label--compact={compact}>
  <span class="busy-label__idle">{label}</span>
  <span class="busy-label__busy"><span class="busy-label__text">{busyText}</span><span class="busy-dots" aria-hidden="true"><span></span><span></span><span></span></span></span>
</span>
