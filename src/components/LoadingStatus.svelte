<script>
  // Screen-reader half of a loader: empty at mount (nothing is announced for fast
  // waits), then filled with `text` once the wait passes 1s. "Loaded" is never said.
  import { onMount } from 'svelte';

  let { text } = $props();

  let announced = $state(false);

  onMount(() => {
    const timer = setTimeout(() => {
      announced = true;
    }, 1000);
    return () => clearTimeout(timer);
  });
</script>

<p class="visually-hidden" role="status">{announced ? text : ''}</p>
