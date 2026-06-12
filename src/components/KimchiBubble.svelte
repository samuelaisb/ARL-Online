<script>
  import { onMount } from 'svelte';
  import { backOut } from 'svelte/easing';
  import { t } from '../lib/i18n.js';

  /** @type {{ notification: { id: number, text: string, duration: number, link?: { href: string, cta: string, label: string } }, isAnchored: boolean, onDismiss: (id: number) => void, onLinkClick: (event: MouseEvent, href: string) => void }} */
  let { notification, isAnchored, onDismiss, onLinkClick } = $props();

  const FADE_MS = 350;

  onMount(() => {
    const timer = setTimeout(() => onDismiss(notification.id), notification.duration);
    return () => clearTimeout(timer);
  });

  /** Elastic pop: the bubble springs up from Kimchi with a backOut overshoot. */
  function pop(node, { duration = 480, easing = backOut, y = 18 } = {}) {
    return {
      duration,
      easing,
      css: (progress, remaining) => `
        transform: translateY(${remaining * y}px) scale(${0.55 + 0.45 * progress});
        opacity: ${Math.min(1, progress * 1.8)};
      `,
    };
  }

  /** Fade out in place so flex siblings do not collapse the leaving bubble instantly. */
  function bubbleFadeOut(node, { duration = FADE_MS } = {}) {
    const bubbleArea = node.parentElement;
    const rect = node.getBoundingClientRect();
    const areaRect = bubbleArea?.getBoundingClientRect() ?? rect;
    const top = rect.top - areaRect.top;
    const right = areaRect.right - rect.right;

    return {
      duration,
      css: (t) => `
        opacity: ${t};
        position: absolute;
        top: ${top}px;
        right: ${right}px;
        width: ${rect.width}px;
        min-height: ${rect.height}px;
        z-index: 2;
        pointer-events: none;
      `,
    };
  }
</script>

<div class="kimchi-bubble" role="status" in:pop out:bubbleFadeOut>
  <button
    class="kimchi-bubble__close"
    type="button"
    aria-label={$t('kimchi.dismiss_aria')}
    onclick={() => onDismiss(notification.id)}
  >
    &times;
  </button>
  <p class="kimchi-bubble__name">{$t('kimchi.name')}</p>
  <p class="kimchi-bubble__text">
    {notification.text}{#if notification.link}<span class="kimchi-bubble__cta">
        {notification.link.cta}{' '}<a
          class="kimchi-bubble__link"
          href={notification.link.href}
          onclick={(event) => onLinkClick(event, notification.link.href)}
        >{notification.link.label}</a>
      </span>{/if}
  </p>
  {#if isAnchored}
    <span class="kimchi-bubble__tail" aria-hidden="true"></span>
  {/if}
</div>

<style>
  .kimchi-bubble {
    position: relative;
    width: max-content;
    max-width: 100%;
    box-sizing: border-box;
    padding: 0.875rem 2.25rem 0.9375rem 1.125rem;
    background: #fff;
    border: 2px solid #ffb35c;
    border-radius: 1.25rem 1.25rem 0.375rem 1.25rem;
    box-shadow: 0 8px 24px rgba(255, 138, 31, 0.28);
    transform-origin: bottom right;
    pointer-events: auto;
  }

  .kimchi-bubble__tail {
    position: absolute;
    right: 1.125rem;
    bottom: -0.625rem;
    width: 1.125rem;
    height: 1.125rem;
    background: #fff;
    border-right: 2px solid #ffb35c;
    border-bottom: 2px solid #ffb35c;
    border-bottom-right-radius: 0.25rem;
    transform: rotate(45deg);
  }

  .kimchi-bubble__name {
    margin: 0 0 0.25rem;
    font-family: 'Fredoka', 'Quicksand', 'Baloo 2', ui-rounded, 'Arial Rounded MT Bold',
      'Comic Sans MS', sans-serif;
    font-size: 1.0625rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: #ff8a1f;
    text-shadow:
      0 1px 0 #fff,
      0 2px 0 rgba(255, 138, 31, 0.35),
      0 3px 6px rgba(255, 138, 31, 0.3);
  }

  .kimchi-bubble__text {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--color-dark, #1f1f1f);
    overflow-wrap: break-word;
  }

  .kimchi-bubble__cta {
    display: block;
  }

  .kimchi-bubble__link {
    font-weight: 600;
    color: #ff8a1f;
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }

  .kimchi-bubble__link:hover {
    color: #e06f00;
  }

  .kimchi-bubble__close {
    position: absolute;
    top: 0.375rem;
    right: 0.5rem;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    font-size: 1.125rem;
    line-height: 1;
    color: #b5b5b5;
    cursor: pointer;
  }

  .kimchi-bubble__close:hover {
    background: #fff1e0;
    color: #ff8a1f;
  }

  .kimchi-bubble__close:focus-visible,
  .kimchi-bubble__link:focus-visible {
    outline: 2px solid #ff8a1f;
    outline-offset: 2px;
  }
</style>
