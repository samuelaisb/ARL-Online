<script>
  // Button label that keeps its width while busy: the idle and busy labels share
  // one grid cell (see .busy-label in app.css). The busy text drops its trailing
  // "…" because three hopping dots replace it. Put icons outside BusyLabel.
  let { label, busyLabel, busy = false, compact = false } = $props();

  const busyText = $derived(String(busyLabel ?? label ?? '').replace(/\s*(?:…|\.\.\.)\s*$/, ''));
</script>

<span class="busy-label" class:is-busy={busy} class:busy-label--compact={compact}>
  <!-- aria-hidden keeps the name exact during the 160ms cross-fade, when both are visible. -->
  <span class="busy-label__idle" aria-hidden={busy ? 'true' : undefined}>{label}</span>
  <span class="busy-label__busy" aria-hidden={busy ? undefined : 'true'}><span class="busy-label__text">{busyText}</span><span class="busy-dots" aria-hidden="true"><span></span><span></span><span></span></span></span>
</span>
