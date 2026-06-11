<script>
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';

  const QUOTES = [
    {
      text: "Do your little bit of good where you are; it's those little bits of good put together that overwhelm the world.",
      author: 'Desmond Tutu',
    },
    {
      text: 'Never doubt that a small group of thoughtful, committed citizens can change the world; indeed, it\'s the only thing that ever has.',
      author: 'Margaret Mead',
    },
    {
      text: 'I am only one, but still I am one. I cannot do everything, but still I can do something; and because I cannot do everything, I will not refuse to do something that I can do.',
      author: 'Helen Keller',
    },
    {
      text: 'What you do makes a difference, and you have to decide what kind of difference you want to make.',
      author: 'Jane Goodall',
    },
    {
      text: "It always seems impossible until it's done.",
      author: 'Nelson Mandela',
    },
    {
      text: "The most common way people give up their power is by thinking they don't have any.",
      author: 'Alice Walker',
    },
    {
      text: 'Start where you are. Use what you have. Do what you can.',
      author: 'Arthur Ashe',
    },
    {
      text: 'When the whole world is silent, even one voice becomes powerful.',
      author: 'Malala Yousafzai',
    },
    {
      text: 'The time is always right to do what is right.',
      author: 'Dr. Martin Luther King Jr.',
    },
    {
      text: "When I was a boy and I would see scary things in the news, my mother would say to me, 'Look for the helpers. You will always find people who are helping.'",
      author: 'Fred Rogers',
    },
  ];

  const ROTATE_MS = 10_000;
  const FADE_MS = 600;

  let index = $state(0);
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;

  onMount(() => {
    timer = setInterval(() => {
      index = (index + 1) % QUOTES.length;
    }, ROTATE_MS);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<footer class="quote-footer" aria-label="Inspirational quotes">
  <div class="quote-footer__inner" aria-live="polite" aria-atomic="true">
    {#key index}
      <blockquote
        class="quote-footer__quote"
        in:fade={{ duration: FADE_MS }}
        out:fade={{ duration: FADE_MS }}
      >
        <p class="quote-footer__text">&ldquo;{QUOTES[index].text}&rdquo;</p>
        <cite class="quote-footer__author">&mdash; {QUOTES[index].author}</cite>
      </blockquote>
    {/key}
  </div>
</footer>
