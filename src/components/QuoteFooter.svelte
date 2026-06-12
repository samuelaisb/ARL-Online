<script>
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { get } from 'svelte/store';
  import { locale, quotes, t } from '../lib/i18n.js';

  const ROTATE_MS = 10_000;
  const FADE_MS = 600;

  let index = $state(0);
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;

  $effect(() => {
    $locale;
    index = 0;
  });

  onMount(() => {
    timer = setInterval(() => {
      const items = get(quotes);
      if (items.length > 0) {
        index = (index + 1) % items.length;
      }
    }, ROTATE_MS);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<footer class="quote-footer" aria-label={$t('quotes.aria_label')}>
  <div class="quote-footer__inner" aria-live="polite" aria-atomic="true">
    {#if $quotes.length > 0}
      {#key index}
        <blockquote
          class="quote-footer__quote"
          in:fade={{ duration: FADE_MS }}
          out:fade={{ duration: FADE_MS }}
        >
          <p class="quote-footer__text">&ldquo;{$quotes[index].text}&rdquo;</p>
          <cite class="quote-footer__author">&mdash; {$quotes[index].author}</cite>
        </blockquote>
      {/key}
    {/if}
  </div>
</footer>
