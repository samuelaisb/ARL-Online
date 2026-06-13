<script>
  import { onDestroy } from 'svelte';
  import { backOut } from 'svelte/easing';
  import { t, translateKey } from '../lib/i18n.js';
  import { navigate } from '../lib/router.js';
  import { authReady, session } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import {
    notifications,
    notify,
    dismiss,
    clearNotifications,
    setKimchiNotificationsEnabled,
  } from '../lib/notification-store.js';
  import KimchiBubble from './KimchiBubble.svelte';
  import kimchiAwake from '../../content/kimchi-awake.jpg';
  import kimchiSleep from '../../content/kimchi-sleep.jpg';

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
  const GREETING_SPLIT_DELAY = 1000;
  const LOGGED_IN_DURATION = 5000;
  const TAP_DURATION = 5000;
  const SLEEP_ZZZ_DURATION = 3500;

  let authGreetingHandled = false;
  let previousUserId = null;
  let isAwake = $state(true);

  const avatarSrc = $derived(isAwake ? kimchiAwake : kimchiSleep);

  let greetingSplitTimeout = null;

  function notifyGreeting() {
    notify(translateKey('kimchi.greeting'), GREETING_DURATION);
    greetingSplitTimeout = setTimeout(() => {
      greetingSplitTimeout = null;
      notify(
        {
          text: '',
          link: {
            href: '/howthisworks',
            cta: translateKey('kimchi.greeting_cta'),
            label: translateKey('kimchi.greeting_link'),
          },
        },
        GREETING_DURATION
      );
    }, GREETING_SPLIT_DELAY);
  }

  onDestroy(() => {
    if (greetingSplitTimeout) clearTimeout(greetingSplitTimeout);
  });

  function notifyLoggedIn() {
    notify(translateKey('kimchi.logged_in'), LOGGED_IN_DURATION);
  }

  function handleLinkClick(event, href) {
    if (!href?.startsWith('/')) return;

    event.preventDefault();
    navigate(href);
  }

  let tapShuffledIndices = [];
  let tapShufflePos = 0;

  function getNextTapMessage() {
    const taps = translateKey('kimchi.taps');
    const messages = Array.isArray(taps) ? taps : [];
    if (messages.length === 0) return null;

    if (tapShufflePos >= tapShuffledIndices.length || tapShuffledIndices.length !== messages.length) {
      tapShuffledIndices = [...Array(messages.length).keys()].sort(() => Math.random() - 0.5);
      tapShufflePos = 0;
    }

    return messages[tapShuffledIndices[tapShufflePos++]];
  }

  function notifyRandomTap() {
    const text = getNextTapMessage();
    if (text == null) return;
    notify(text, TAP_DURATION);
  }

  function handleAvatarClick() {
    if (!isAwake) return;
    notifyRandomTap();
  }

  function handleStatusClick() {
    if (isAwake) {
      clearNotifications();
      notify(translateKey('kimchi.sleep'), SLEEP_ZZZ_DURATION, { force: true });
      isAwake = false;
      setKimchiNotificationsEnabled(false);
      return;
    }

    isAwake = true;
    setKimchiNotificationsEnabled(true);
    notifyRandomTap();
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

  <div class="kimchi-widget__avatar-wrap">
    <button
      type="button"
      class="kimchi-widget__avatar"
      class:kimchi-widget__avatar--talking={$notifications.length > 0}
      aria-label={$t('kimchi.tap_aria')}
      onclick={handleAvatarClick}
    >
      <img src={avatarSrc} alt={$t('kimchi.avatar_alt')} width="64" height="64" />
    </button>
    <button
      type="button"
      class="kimchi-widget__status"
      class:kimchi-widget__status--offline={!isAwake}
      aria-label={isAwake ? $t('kimchi.status_online_aria') : $t('kimchi.status_offline_aria')}
      onclick={handleStatusClick}
    ></button>
  </div>
</div>

<style>
  .kimchi-widget {
    position: fixed;
    right: 1rem;
    bottom: calc(var(--quote-footer-height) + 0.75rem);
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

  .kimchi-widget__avatar-wrap {
    position: relative;
    pointer-events: auto;
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
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .kimchi-widget__avatar:hover {
    transform: scale(1.06);
    box-shadow: 0 6px 18px rgba(255, 221, 42, 0.4);
  }

  .kimchi-widget__avatar:focus-visible {
    outline: 2px solid var(--color-lemon, #ffdd2a);
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
    padding: 0;
    border-radius: 50%;
    background: #34c759;
    border: 2.5px solid #fff;
    box-shadow: 0 1px 3px rgba(30, 30, 30, 0.25);
    animation: kimchi-online-pulse 2.4s ease-in-out infinite;
    cursor: pointer;
    transition: transform 0.15s ease;
  }

  .kimchi-widget__status:hover {
    transform: scale(1.12);
  }

  .kimchi-widget__status:focus-visible {
    outline: 2px solid var(--color-lemon, #ffdd2a);
    outline-offset: 2px;
  }

  .kimchi-widget__status--offline {
    background: #9e9e9e;
    animation: none;
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
