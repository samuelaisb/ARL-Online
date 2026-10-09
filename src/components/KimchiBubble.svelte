<script>
  import { onMount } from 'svelte';
  import { backOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { t } from '../lib/i18n.js';

  /** @type {{ notification: { id: number, duration: number, text?: string, textKey?: string, vars?: Record<string, unknown>, link?: { href: string, cta?: string, label?: string, ctaKey?: string, labelKey?: string, vars?: Record<string, unknown> } }, isAnchored: boolean, onDismiss: (id: number) => void, onClose?: (id: number) => void, onLinkClick: (event: MouseEvent, href: string, id: number) => void }} */
  let { notification, isAnchored, onDismiss, onClose, onLinkClick } = $props();

  /** A paused bubble always gets at least this long to be read once it resumes. */
  const MIN_RESUME_MS = 1500;

  // Keyed bubbles re-translate when the language changes; `text` / `label` are frozen (legacy).
  const text = $derived(
    notification.textKey ? $t(notification.textKey, notification.vars) : (notification.text ?? ''),
  );
  const link = $derived.by(() => {
    const raw = notification.link;
    if (!raw?.href) return null;
    const vars = raw.vars ?? notification.vars;
    return {
      href: raw.href,
      cta: raw.ctaKey ? $t(raw.ctaKey, vars) : (raw.cta ?? ''),
      label: raw.labelKey ? $t(raw.labelKey, vars) : (raw.label ?? ''),
    };
  });

  // The auto-dismiss timer pauses while the pointer is over the bubble or focus is inside it.
  let remainingMs = 0;
  let startedAt = 0;
  let timer = null;
  let pointerInside = false;
  let focusInside = false;

  function startTimer() {
    if (timer) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      onDismiss(notification.id);
    }, remainingMs);
  }

  function pauseTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remainingMs = Math.max(MIN_RESUME_MS, remainingMs - (Date.now() - startedAt));
  }

  function syncTimer() {
    if (pointerInside || focusInside) pauseTimer();
    else startTimer();
  }

  function handlePointerEnter() {
    pointerInside = true;
    syncTimer();
  }

  function handlePointerLeave() {
    pointerInside = false;
    syncTimer();
  }

  function handleFocusIn() {
    focusInside = true;
    syncTimer();
  }

  function handleFocusOut(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    focusInside = false;
    syncTimer();
  }

  /** The × button. Timer expiry goes through `onDismiss` only, so a close can be told apart. */
  function handleClose() {
    (onClose ?? onDismiss)(notification.id);
  }

  onMount(() => {
    remainingMs = notification.duration;
    startTimer();
    return () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
  });

  /**
   * Elastic pop: the bubble springs up from Kimchi with a backOut overshoot (transform
   * only, never a fade). With reduced motion it appears at once. The duration must be
   * explicit there: Svelte 5.56 turns an omitted one into NaN. There is no outro: a
   * closed bubble leaves at once and the stack springs into place (`springSlide`).
   */
  function pop(node, { duration = 480, easing = backOut, y = 18 } = {}) {
    if (prefersReducedMotion.current) return { duration: 0 };

    return {
      duration,
      easing,
      css: (progress, remaining) =>
        `transform: translateY(${remaining * y}px) scale(${0.55 + 0.45 * progress});`,
    };
  }
</script>

<div
  class="kimchi-bubble"
  role="status"
  data-kimchi-bubble-id={notification.id}
  in:pop
  onpointerenter={handlePointerEnter}
  onpointerleave={handlePointerLeave}
  onfocusin={handleFocusIn}
  onfocusout={handleFocusOut}
>
  <button
    class="kimchi-bubble__close"
    type="button"
    aria-label={$t('kimchi.dismiss_aria')}
    onclick={handleClose}
  >
    &times;
  </button>
  <p class="kimchi-bubble__name">{$t('kimchi.name')}</p>
  <p class="kimchi-bubble__text">
    {text}{#if link}<span class="kimchi-bubble__cta">
        {link.cta}{' '}<a
          class="kimchi-bubble__link"
          href={link.href}
          onclick={(event) => onLinkClick(event, link.href, notification.id)}
        >{link.label}</a>
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
    border: 2px solid var(--color-lemon, #ffdd2a);
    border-radius: 1.25rem 1.25rem 0.375rem 1.25rem;
    box-shadow: 0 8px 24px rgba(255, 221, 42, 0.35);
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
    border-right: 2px solid var(--color-lemon, #ffdd2a);
    border-bottom: 2px solid var(--color-lemon, #ffdd2a);
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
    color: #c4a800;
    text-shadow:
      0 1px 0 #fff,
      0 2px 0 rgba(255, 221, 42, 0.4),
      0 3px 6px rgba(255, 221, 42, 0.35);
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

  /* #6b5b00 keeps the lemon family at 6.7:1 on white (the old #c4a800 was 2.35:1). */
  .kimchi-bubble__link {
    font-weight: 600;
    color: #6b5b00;
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }

  .kimchi-bubble__link:hover {
    color: #4a3f00;
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
    color: #767676;
    cursor: pointer;
  }

  .kimchi-bubble__close:hover {
    background: #fffbe6;
    color: #6b5b00;
  }

  .kimchi-bubble__close:focus-visible,
  .kimchi-bubble__link:focus-visible {
    outline: 2px solid var(--color-mint, #024238);
    outline-offset: 2px;
  }

  /* Short viewports (landscape phones, 400% zoom): a tighter, smaller bubble. */
  @media (max-height: 500px) {
    .kimchi-bubble {
      padding: 0.5rem 2rem 0.5625rem 0.875rem;
    }

    .kimchi-bubble__name {
      margin-bottom: 0.125rem;
      font-size: 0.9375rem;
    }

    .kimchi-bubble__text {
      font-size: 0.8125rem;
      line-height: 1.4;
    }

    .kimchi-bubble__close {
      top: 0.25rem;
      right: 0.375rem;
    }
  }
</style>
