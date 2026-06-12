<script>
  import { backOut } from 'svelte/easing';
  import { t, translateKey } from '../lib/i18n.js';
  import { navigate } from '../lib/router.js';
  import { authReady, session } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { notifications, notify, dismiss } from '../lib/notification-store.js';
  import KimchiBubble from './KimchiBubble.svelte';
  import kimchiAvatar from '../../content/kimchi.jpg';

  /**
   * Animate existing bubbles sliding upward when a new one pushes in below.
   * Uses backOut easing for a light elastic overshoot.
   */
  function springSlide(node, { from, to }) {
    const dy = from.top - to.top;
    if (!dy) return { duration: 0 };
    return {
      duration: 420,
      easing: backOut,
      css: (t, u) => `transform: translateY(${u * dy}px)`,
    };
  }

  const GREETING_DURATION = 8000;
  const LOGGED_IN_DURATION = 5000;
  const TAP_DURATION = 5000;

  let authGreetingHandled = false;
  let previousUserId = null;

  function notifyGreeting() {
    notify(
      {
        text: translateKey('kimchi.greeting'),
        link: {
          href: '/howthisworks',
          cta: translateKey('kimchi.greeting_cta'),
          label: translateKey('kimchi.greeting_link'),
        },
      },
      GREETING_DURATION
    );
  }

  function notifyLoggedIn() {
    notify(translateKey('kimchi.logged_in'), LOGGED_IN_DURATION);
  }

  function handleLinkClick(event, href) {
    if (!href?.startsWith('/')) return;

    event.preventDefault();
    navigate(href);
  }

  function handleAvatarClick() {
    const taps = translateKey('kimchi.taps');
    const messages = Array.isArray(taps) ? taps : [];
    if (messages.length === 0) return;

    const text = messages[Math.floor(Math.random() * messages.length)];
    notify(text, TAP_DURATION);
  }

  $effect(() => {
    if (supabaseConfigured && !$authReady) return;

    const userId = $session?.user?.id ?? null;

    if (!authGreetingHandled) {
      authGreetingHandled = true;
      if (userId) {
        notifyLoggedIn();
      } else {
        notifyGreeting();
      }
      previousUserId = userId;
      return;
    }

    if (!previousUserId && userId) {
      notifyLoggedIn();
    }

    previousUserId = userId;
  });
</script>

<div class="kimchi-widget" aria-label={$t('kimchi.widget_aria')}>
  <div class="kimchi-widget__bubble-area" aria-live="polite">
    {#each $notifications as notification, index (notification.id)}
      <div class="kimchi-bubble-slot" animate:springSlide>
        <KimchiBubble
          {notification}
          isAnchored={index === $notifications.length - 1}
          onDismiss={dismiss}
          onLinkClick={handleLinkClick}
        />
      </div>
    {/each}
  </div>

  <button
    type="button"
    class="kimchi-widget__avatar"
    class:kimchi-widget__avatar--talking={$notifications.length > 0}
    aria-label={$t('kimchi.tap_aria')}
    onclick={handleAvatarClick}
  >
    <img src={kimchiAvatar} alt="" width="64" height="64" />
    <span class="kimchi-widget__status" aria-hidden="true"></span>
  </button>
</div>

<style>
  .kimchi-widget {
    position: fixed;
    right: 1rem;
    bottom: calc(
      var(--quote-footer-height) + 0.75rem + var(--site-attribution-block-height, 3.7rem) + 2px
    );
    z-index: 30;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.5rem;
    pointer-events: none;
  }

  .kimchi-widget__bubble-area {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: flex-end;
    gap: 0.5rem;
    min-height: 0;
    width: min(18.5rem, calc(100vw - 2rem));
  }

  .kimchi-bubble-slot {
    display: flex;
    justify-content: flex-end;
    width: 100%;
  }

  .kimchi-widget__avatar {
    position: relative;
    width: 4rem;
    height: 4rem;
    padding: 0;
    border-radius: 50%;
    border: 3px solid #fff;
    box-shadow: 0 4px 14px rgba(30, 30, 30, 0.25);
    background: #fff;
    pointer-events: auto;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .kimchi-widget__avatar:hover {
    transform: scale(1.06);
    box-shadow: 0 6px 18px rgba(255, 138, 31, 0.35);
  }

  .kimchi-widget__avatar:focus-visible {
    outline: 2px solid #ff8a1f;
    outline-offset: 3px;
  }

  .kimchi-widget__avatar--talking {
    animation: kimchi-wiggle 0.6s ease-in-out;
  }

  .kimchi-widget__avatar img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
  }

  /* Green "online" presence dot, like a chat app status indicator. */
  .kimchi-widget__status {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 50%;
    background: #34c759;
    border: 2.5px solid #fff;
    box-shadow: 0 1px 3px rgba(30, 30, 30, 0.25);
    animation: kimchi-online-pulse 2.4s ease-in-out infinite;
  }

  @keyframes kimchi-online-pulse {
    0%,
    100% {
      box-shadow:
        0 1px 3px rgba(30, 30, 30, 0.25),
        0 0 0 0 rgba(52, 199, 89, 0.45);
    }
    50% {
      box-shadow:
        0 1px 3px rgba(30, 30, 30, 0.25),
        0 0 0 4px rgba(52, 199, 89, 0);
    }
  }

  @keyframes kimchi-wiggle {
    0%,
    100% {
      transform: rotate(0deg) scale(1);
    }
    25% {
      transform: rotate(-6deg) scale(1.08);
    }
    60% {
      transform: rotate(5deg) scale(1.04);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .kimchi-widget__avatar--talking,
    .kimchi-widget__status {
      animation: none;
    }
  }

  @media (max-width: 600px) {
    .kimchi-widget {
      right: 0.75rem;
    }
  }
</style>
