<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { backOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { get } from 'svelte/store';
  import { t, translateKey } from '../lib/i18n.js';
  import {
    isHowThisWorksRoute,
    isItemDetailRoute,
    isKnownAppPath,
    isPlainLeftClick,
    navigateToPage,
    path,
  } from '../lib/router.js';
  import { authReady, needsMemberAgreement, session } from '../lib/auth.js';
  import { authCallbackSignupConfirmed, supabaseConfigured } from '../lib/supabase.js';
  import { libraryTodayKey } from '../lib/calendar.js';
  import { calendarLineKey } from '../lib/kimchi-calendar.js';
  import {
    hasSeen,
    isDayFlagToday,
    markSeen,
    readJson,
    readSessionJson,
    setDayFlag,
    storageAvailable,
    writeJson,
    writeSessionJson,
  } from '../lib/kimchi-memory.js';
  import {
    notifications,
    notify,
    notifyWhenIdle,
    dismiss,
    clearNotifications,
    getKimchiAsleepSince,
    isKimchiAwake,
    setKimchiNotificationsEnabled,
  } from '../lib/notification-store.js';
  import KimchiBubble from './KimchiBubble.svelte';
  import kimchiAwake from '../../content/kimchi-awake.jpg';
  import kimchiSleep from '../../content/kimchi-sleep.jpg';

  /**
   * Animate existing bubbles sliding upward when a new one pushes in below.
   * Uses backOut easing for a light elastic overshoot. With reduced motion they just
   * move to their new place.
   */
  function springSlide(node, { from, to }) {
    const dy = from.top - to.top;
    if (!dy || prefersReducedMotion.current) return { duration: 0 };
    return {
      duration: 420,
      easing: backOut,
      css: (t, u) => `transform: translateY(${u * dy}px)`,
    };
  }

  const GREETING_DURATION = 8000;
  const GREETING_SPLIT_DELAY = 1000;
  const RETURNING_GREETING_DURATION = 5000;
  const LOGGED_IN_DURATION = 5000;
  const TAP_DURATION = 5000;
  const SLEEP_ZZZ_DURATION = 3500;
  /** A returning signed-in member hears "you're logged in" at most once per hour. */
  const LOGGED_IN_REPEAT_MS = 60 * 60 * 1000;
  const LOGGED_IN_STORAGE_KEY = 'arl-kimchi-logged-in';
  /** A bubble link waits this long for a lazy page to render its heading or `#id` target. */
  const LINK_TARGET_WAIT_MS = 4000;

  /** localStorage: this browser has met Kimchi, so later visits get a short line (D1). */
  const GREETED_STORAGE_KEY = 'arl-kimchi-greeted';
  /** sessionStorage: already greeted in this tab session, so a reload stays quiet (D1). */
  const GREETED_SESSION_KEY = 'arl-kimchi-greeted-session';
  /** After a deep link, the welcome waits this long once the item overlay closes (D2). */
  const DEEP_LINK_GREETING_DELAY = 600;
  /** Calendar lines (D14) run longer than a greeting, the days of remembrance especially. */
  const DAY_LINE_DURATION = 10000;
  /** `setDayFlag` name for the calendar line: once per Montréal day in this browser. */
  const CALENDAR_DAY_FLAG = 'calendar';
  const NOT_FOUND_DURATION = 6000;
  /** "You're all set" can wait out an item overlay left open under the agreement dialog (A2). */
  const SIGNUP_COMPLETE_WAIT_MS = 60 * 1000;

  /** The connection has to stay down this long before Kimchi mentions it (B7). */
  const OFFLINE_CONFIRM_MS = 2500;
  /** At most one offline notice per 2 minutes, so a flaky connection doesn't nag. */
  const OFFLINE_REPEAT_MS = 2 * 60 * 1000;
  const OFFLINE_DURATION = 10000;
  const BACK_ONLINE_DURATION = 4000;

  /** Rapid taps (D3): `kimchi.tap_spam.0` at 5 taps within 3 s, `.1` at 12 within 8 s. */
  const TAP_SPAM_LEVELS = [
    { taps: 5, withinMs: 3000 },
    { taps: 12, withinMs: 8000 },
  ];
  /** sessionStorage: the rapid-tap levels already shown in this tab session. */
  const TAP_SPAM_SESSION_KEY = 'arl-kimchi-tap-spam';

  /** Sleep-talk (D4): at most once per 20 s and 3 times per nap. */
  const SLEEP_TALK_DURATION = 4000;
  const SLEEP_TALK_GAP_MS = 20 * 1000;
  const SLEEP_TALK_PER_NAP = 3;

  /** Nap hint (D5): 3 × presses within 2 minutes while awake. */
  const NAP_HINT_CLOSES = 3;
  const NAP_HINT_WINDOW_MS = 120 * 1000;
  const NAP_HINT_DURATION = 8000;

  /** Wake-up lines (D7): a nap under 10 s is "already?", one over an hour "what a nap!". */
  const WAKE_SHORT_NAP_MS = 10 * 1000;
  const WAKE_LONG_NAP_MS = 60 * 60 * 1000;

  let authGreetingHandled = false;
  let previousUserId = null;
  /** Signed-in user whose member agreement is still pending: their welcome waits (A2). */
  let agreementPendingUserId = null;
  /** The page loaded on an item link (D2): its welcome waits for the overlay to close. */
  const landedOnItem = isItemDetailRoute(get(path));
  let deepLinkGreetingPending = false;
  /** This load came from the sign-up confirmation email; the first welcome spends it (A4). */
  let signupConfirmedPending = authCallbackSignupConfirmed;
  /** Unknown paths that already got the 404 line on this load (kept in memory only, D9). */
  const notFoundShownPaths = new Set();
  let pathEffectPrimed = false;
  // Asleep is remembered across visits (notification-store.js): no greeting, sleep photo.
  let isAwake = $state(isKimchiAwake());
  /** When the current nap started (ms), or null while awake. Read by the wake-up line (D7). */
  let sleptAt = getKimchiAsleepSince();
  let avatarButton = $state();
  /** Text on the hidden status line: a welcome that couldn't show as a bubble (translated
   *  once, so a language switch doesn't re-announce it). */
  let statusText = $state('');

  const avatarSrc = $derived(isAwake ? kimchiAwake : kimchiSleep);

  let greetingSplitTimeout = null;
  let deepLinkGreetingTimeout = null;
  let offlineTimeout = null;
  /** The offline notice showed for this outage, so its end gets "back online" (B7). */
  let offlineNoticeShown = false;
  let lastOfflineNoticeAt = -Infinity;

  /** Recent awake tap times (ms) for the rapid-tap lines (D3). */
  let recentTaps = [];
  let tapSpamShown = readTapSpamShown();
  /** The rapid-tap bubble on screen: while it shows, taps only count (Kimchi is hiding). */
  let tapSpamBubbleId = null;
  /** Sleep-talk during the current nap (D4). */
  let sleepTalk = { nap: null, count: 0, lastAt: 0 };
  /** When the visitor pressed × on a bubble while Kimchi was awake (D5). */
  let recentCloses = [];

  /** Run `show` in the greeting's follow-up slot (its link, or the 404 line) after `delay`. */
  function scheduleGreetingFollowUp(show, delay = GREETING_SPLIT_DELAY) {
    if (greetingSplitTimeout) clearTimeout(greetingSplitTimeout);
    greetingSplitTimeout = setTimeout(() => {
      greetingSplitTimeout = null;
      show();
    }, delay);
  }

  /** The introduction's "how this works" link. */
  function notifyGreetingCta() {
    notify(
      {
        link: {
          href: '/howthisworks',
          ctaKey: 'kimchi.greeting_cta',
          labelKey: 'kimchi.greeting_link',
        },
      },
      GREETING_DURATION,
      { ambient: 'intro' }
    );
  }

  /** No greeting again in this tab session, and a short "welcome back" on later visits (D1). */
  function markGreeted() {
    writeSessionJson(GREETED_SESSION_KEY, true);
    writeJson(GREETED_STORAGE_KEY, true);
  }

  /**
   * First visit in this browser: the introduction (D2's version after an item link), then a
   * second later its "how this works" link. On a 404 the link gives way to the 404 line (D9),
   * and on /howthisworks there is no link.
   */
  async function notifyIntroduction({ deepLink, pagePath }) {
    const id = await notifyWhenIdle(
      { textKey: deepLink ? 'kimchi.deep_link_welcome' : 'kimchi.greeting' },
      GREETING_DURATION,
      { ambient: 'intro' }
    );
    if (id === -1) return;

    markGreeted();
    if (!isKnownAppPath(pagePath)) {
      scheduleGreetingFollowUp(() => notifyNotFound(pagePath));
    } else if (!isHowThisWorksRoute(pagePath)) {
      scheduleGreetingFollowUp(notifyGreetingCta);
    }
  }

  /** A short line for a visitor this browser has met before (D1). Resolves the bubble id. */
  function notifyReturningGreeting() {
    const lines = translateKey('kimchi.greeting_returning');
    const count = Array.isArray(lines) ? lines.length : 0;
    if (count === 0) return Promise.resolve(-1);

    const index = Math.floor(Math.random() * count);
    return notifyWhenIdle(
      { textKey: `kimchi.greeting_returning.${index}` },
      RETURNING_GREETING_DURATION,
      { ambient: true }
    );
  }

  /**
   * Today's calendar line (D14), at most once per Montréal day in this browser, once
   * nothing would hide it. Returns null when there is nothing to try (an ordinary day,
   * already said today, or no storage to remember that by), else a promise of the id.
   */
  function notifyCalendarDay() {
    const today = libraryTodayKey();
    const textKey = calendarLineKey(today);
    if (!textKey || isDayFlagToday(CALENDAR_DAY_FLAG, today) || !storageAvailable()) {
      return null;
    }

    // On a day of remembrance (a quiet day) this line is the only ambient bubble allowed.
    return notifyWhenIdle({ textKey }, DAY_LINE_DURATION, {
      ambient: true,
      allowOnQuietDay: true,
    }).then((id) => {
      if (id !== -1) setDayFlag(CALENDAR_DAY_FLAG, today);
      return id;
    });
  }

  /**
   * Signed-out visitor (D1): nothing new in the same tab session; the introduction on a
   * first visit; otherwise one short line, which on a calendar day is the day's line
   * (D14; the 60 s ambient gap would refuse it right after a "welcome back").
   */
  async function greetVisitor({ deepLink, pagePath }) {
    const onUnknownPage = !isKnownAppPath(pagePath);

    if (readSessionJson(GREETED_SESSION_KEY, false)) {
      if (onUnknownPage) notifyNotFound(pagePath);
      else notifyCalendarDay();
      return;
    }

    if (!readJson(GREETED_STORAGE_KEY, false)) {
      await notifyIntroduction({ deepLink, pagePath });
      return;
    }

    const id = await (notifyCalendarDay() ?? notifyReturningGreeting());
    if (id !== -1) markGreeted();
    if (onUnknownPage) {
      scheduleGreetingFollowUp(
        () => notifyNotFound(pagePath),
        id === -1 ? 0 : GREETING_SPLIT_DELAY
      );
    }
  }

  /** The year the member joined, when today (Montréal) is their library-versary (D12). */
  function anniversaryJoinYear(user, today) {
    const joined = user?.created_at ? libraryTodayKey(new Date(user.created_at)) : '';
    if (!joined || !today) return null;

    const joinYear = Number(joined.slice(0, 4));
    const year = Number(today.slice(0, 4));
    if (!(year > joinYear)) return null;

    // Members who joined on Feb 29 celebrate on Feb 28 in common years.
    const joinedOn = joined.slice(5);
    const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const celebratedOn = joinedOn === '02-29' && !leapYear ? '02-28' : joinedOn;
    return celebratedOn === today.slice(5) ? joinYear : null;
  }

  /** Library-versary (D12): once per member per year, held while a dialog is open. */
  async function notifyAnniversary(userId) {
    const today = libraryTodayKey();
    const joinYear = anniversaryJoinYear(get(session)?.user, today);
    const year = today.slice(0, 4);
    if (joinYear == null || hasSeen(userId, 'anniversary', year)) return -1;

    const id = await notifyWhenIdle(
      { textKey: 'kimchi.anniversary', vars: { year: joinYear } },
      GREETING_DURATION,
      { ambient: true }
    );
    if (id !== -1) markSeen(userId, 'anniversary', year);
    return id;
  }

  /**
   * Signed-in member on load: "your email is confirmed" after the confirmation link (A4),
   * else their library-versary (D12), else "you're logged in" at most once an hour. Then
   * the 404 line (D9), or today's calendar line stacked above it if the ambient budget
   * allows (D14; otherwise a later load today says it).
   */
  async function welcomeMember(userId, { pagePath }) {
    let id = -1;

    if (signupConfirmedPending) {
      signupConfirmedPending = false;
      id = await notifyWhenIdle({ textKey: 'kimchi.email_confirmed' }, GREETING_DURATION);
      if (id === -1) announce('kimchi.email_confirmed');
    } else {
      id = await notifyAnniversary(userId);
      if (id === -1 && !loggedInShownRecently(userId)) {
        id = await notifyWhenIdle({ textKey: 'kimchi.logged_in' }, LOGGED_IN_DURATION);
      }
    }

    if (id !== -1) {
      writeLoggedInShown(userId);
      markGreeted();
    }

    if (!isKnownAppPath(pagePath)) {
      scheduleGreetingFollowUp(
        () => notifyNotFound(pagePath),
        id === -1 ? 0 : GREETING_SPLIT_DELAY
      );
    } else {
      notifyCalendarDay();
    }
  }

  /**
   * The load's welcome: on the first auth check, or for a deep link once the item overlay
   * has closed (D2), so it isn't lost behind the dialog.
   */
  function greetOnLoad(userId, { deepLink = false } = {}) {
    const pagePath = get(path);
    if (userId) welcomeMember(userId, { pagePath });
    else greetVisitor({ deepLink, pagePath });
  }

  /** D2: greet a little after the deep-linked item overlay closes. */
  function scheduleDeepLinkGreeting() {
    if (deepLinkGreetingTimeout) clearTimeout(deepLinkGreetingTimeout);
    deepLinkGreetingTimeout = setTimeout(() => {
      deepLinkGreetingTimeout = null;
      if (isItemDetailRoute(get(path))) {
        // Straight into another item: wait for that overlay to close instead.
        deepLinkGreetingPending = true;
        return;
      }
      if (agreementPendingUserId) return;
      greetOnLoad(get(session)?.user?.id ?? null, { deepLink: true });
    }, DEEP_LINK_GREETING_DELAY);
  }

  /** D9: the not-found page, once per unknown path per load. Never repeats the path. */
  function notifyNotFound(pagePath) {
    if (notFoundShownPaths.has(pagePath) || get(path) !== pagePath) return;
    const id = notify({ textKey: 'kimchi.not_found' }, NOT_FOUND_DURATION, { kind: 'not_found' });
    if (id !== -1) notFoundShownPaths.add(pagePath);
  }

  /** A2: the member agreement just went through (Finish sign-up, or saved after OAuth). */
  async function notifySignupComplete(userId) {
    const id = await notifyWhenIdle({ textKey: 'kimchi.signup_complete' }, GREETING_DURATION, {
      // Closing an item overlay under the agreement dialog changes the path; keep waiting.
      cancelOnPathChange: false,
      timeoutMs: SIGNUP_COMPLETE_WAIT_MS,
    });
    if (id === -1) {
      announce('kimchi.signup_complete');
      return;
    }
    writeLoggedInShown(userId);
    markGreeted();
  }

  /**
   * Put a welcome on the hidden status line when its bubble couldn't show (Kimchi asleep),
   * so screen readers still hear it. The line sits outside every dialog, and is filled after
   * the update that closed the agreement dialog so it isn't inert when it changes.
   */
  async function announce(textKey) {
    statusText = '';
    await tick();
    statusText = translateKey(textKey);
  }

  /**
   * A bubble that holds focus is leaving (timer, ×, `dismiss`, `dismissKind`,
   * `clearNotifications`). The queue changes before the DOM does, so focus is still in
   * the bubble here: hand it to the avatar instead of letting it drop to <body>.
   */
  function keepFocusOffLeavingBubble(items) {
    const bubble = document.activeElement?.closest?.('[data-kimchi-bubble-id]');
    if (!bubble) return;

    const id = Number(bubble.getAttribute('data-kimchi-bubble-id'));
    if (items.some((item) => item.id === id)) return;
    avatarButton?.focus({ preventScroll: true });
  }

  /** B7: mention a lost connection only once it has lasted a couple of seconds. */
  function handleOffline() {
    if (offlineTimeout) clearTimeout(offlineTimeout);
    offlineTimeout = setTimeout(() => {
      offlineTimeout = null;
      if (navigator.onLine || offlineNoticeShown) return;

      const now = Date.now();
      if (now - lastOfflineNoticeAt < OFFLINE_REPEAT_MS) return;
      const id = notify({ textKey: 'kimchi.offline' }, OFFLINE_DURATION, { kind: 'offline' });
      if (id === -1) return;
      offlineNoticeShown = true;
      lastOfflineNoticeAt = now;
    }, OFFLINE_CONFIRM_MS);
  }

  /** B7: "back online" only follows an outage Kimchi mentioned, stacked above its notice. */
  function handleOnline() {
    if (offlineTimeout) {
      clearTimeout(offlineTimeout);
      offlineTimeout = null;
    }
    if (!offlineNoticeShown) return;

    offlineNoticeShown = false;
    notify({ textKey: 'kimchi.back_online' }, BACK_ONLINE_DURATION, { kind: 'back_online' });
  }

  onMount(() => {
    const stopFocusGuard = notifications.subscribe(keepFocusOffLeavingBubble);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      stopFocusGuard();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      if (offlineTimeout) clearTimeout(offlineTimeout);
    };
  });

  onDestroy(() => {
    if (greetingSplitTimeout) clearTimeout(greetingSplitTimeout);
    if (deepLinkGreetingTimeout) clearTimeout(deepLinkGreetingTimeout);
  });

  function readLoggedInShown() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOGGED_IN_STORAGE_KEY) ?? 'null');
      return saved && typeof saved === 'object' ? saved : null;
    } catch {
      return null;
    }
  }

  function writeLoggedInShown(userId) {
    try {
      if (userId) {
        localStorage.setItem(LOGGED_IN_STORAGE_KEY, JSON.stringify({ userId, at: Date.now() }));
      } else {
        localStorage.removeItem(LOGGED_IN_STORAGE_KEY);
      }
    } catch {
      // Storage blocked: the bubble just shows on every load, as before.
    }
  }

  function loggedInShownRecently(userId) {
    const saved = readLoggedInShown();
    if (!saved || saved.userId !== userId || !Number.isFinite(saved.at)) return false;
    const age = Date.now() - saved.at;
    return age >= 0 && age < LOGGED_IN_REPEAT_MS;
  }

  function notifyLoggedIn(userId) {
    const id = notify({ textKey: 'kimchi.logged_in' }, LOGGED_IN_DURATION);
    if (id !== -1) writeLoggedInShown(userId);
  }

  /** The first element matching `selector` once it renders (lazy pages mount after navigation), or null. */
  function waitForElement(selector, timeoutMs = LINK_TARGET_WAIT_MS) {
    const found = document.querySelector(selector);
    if (found) return Promise.resolve(found);

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) finish(element);
      });
      const timeout = setTimeout(() => finish(null), timeoutMs);

      function finish(element) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(element);
      }

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  /** Bring a `#id` link target into view and focus it, so the jump is announced. */
  async function focusHashTarget(id) {
    const target = await waitForElement(`#${CSS.escape(id)}`);
    if (!target) return;

    if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) {
      target.setAttribute('tabindex', '-1');
    }
    target.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion.current ? 'auto' : 'smooth',
    });
    target.focus({ preventScroll: true });
  }

  /** A plain `/path` link: focus the new page's heading once its lazy chunk renders. */
  async function focusPageHeading() {
    const heading = await waitForElement('#main-content h1');
    if (!heading) return;

    // Most page headings have no tabindex, and focus() does nothing without one.
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  /**
   * In-app bubble links start the next page like a fresh load (`navigateToPage`). A
   * `/path#id` link then scrolls to `#id` and focuses it; a plain `/path` link focuses the
   * new page's heading once it renders. The bubble then closes. Modifier clicks keep the
   * browser's own new tab / new window behaviour (and the bubble).
   */
  async function handleLinkClick(event, href, bubbleId) {
    if (!href?.startsWith('/') || href.startsWith('//')) return;
    if (!isPlainLeftClick(event)) return;

    event.preventDefault();
    const hashIndex = href.indexOf('#');
    const pagePath = hashIndex === -1 ? href : href.slice(0, hashIndex);
    const targetId = hashIndex === -1 ? '' : href.slice(hashIndex + 1);

    await navigateToPage(pagePath || window.location.pathname);
    if (targetId) await focusHashTarget(targetId);
    else await focusPageHeading();
    // The link has done its job. Focus has left the bubble (or the focus guard hands it
    // to the avatar), so F2's pause can't keep a stale bubble on the new page.
    dismiss(bubbleId);
  }

  /**
   * The × on a bubble (timer expiry goes straight to `dismiss`). Three of these within two
   * minutes while Kimchi is awake point out the nap dot, once per browser (D5).
   */
  function handleUserClose(id) {
    dismiss(id);
    if (!isAwake) return;

    const now = Date.now();
    recentCloses = [...recentCloses.filter((at) => now - at < NAP_HINT_WINDOW_MS), now];
    if (recentCloses.length < NAP_HINT_CLOSES || hasSeen(null, 'hints', 'nap')) return;

    recentCloses = [];
    const hintId = notify({ textKey: 'kimchi.nap_hint' }, NAP_HINT_DURATION, { kind: 'nap_hint' });
    if (hintId !== -1) markSeen(null, 'hints', 'nap');
  }

  let tapShuffledIndices = [];
  let tapShufflePos = 0;

  /** Index into `kimchi.taps` (shuffled, no repeat until every line has shown), or null. */
  function getNextTapIndex() {
    const taps = translateKey('kimchi.taps');
    const count = Array.isArray(taps) ? taps.length : 0;
    if (count === 0) return null;

    if (tapShufflePos >= tapShuffledIndices.length || tapShuffledIndices.length !== count) {
      tapShuffledIndices = [...Array(count).keys()].sort(() => Math.random() - 0.5);
      tapShufflePos = 0;
    }

    return tapShuffledIndices[tapShufflePos++];
  }

  /** A random tap line, stacked on whatever Kimchi is already saying. */
  function notifyRandomTap() {
    const index = getNextTapIndex();
    if (index == null) return;
    notify({ textKey: `kimchi.taps.${index}` }, TAP_DURATION, { kind: 'tap' });
  }

  function readTapSpamShown() {
    const saved = readSessionJson(TAP_SPAM_SESSION_KEY, []);
    return Array.isArray(saved) ? saved.filter(Number.isInteger) : [];
  }

  /** The highest rapid-tap level just reached and not yet shown this tab session, or -1. */
  function rapidTapLevel(now) {
    for (let level = TAP_SPAM_LEVELS.length - 1; level >= 0; level -= 1) {
      const { taps, withinMs } = TAP_SPAM_LEVELS[level];
      const count = recentTaps.filter((at) => now - at < withinMs).length;
      if (count >= taps && !tapSpamShown.includes(level)) return level;
    }
    return -1;
  }

  /** D3: an awake tap. Lots of them quickly get a rapid-tap line (each level once a session). */
  function handleAwakeTap() {
    const now = Date.now();
    const longestWindow = TAP_SPAM_LEVELS[TAP_SPAM_LEVELS.length - 1].withinMs;
    recentTaps = [...recentTaps.filter((at) => now - at < longestWindow), now];

    const level = rapidTapLevel(now);
    if (level !== -1) {
      const id = notify({ textKey: `kimchi.tap_spam.${level}` }, TAP_DURATION, { kind: 'tap' });
      if (id !== -1) {
        tapSpamBubbleId = id;
        tapSpamShown = [...tapSpamShown, level];
        writeSessionJson(TAP_SPAM_SESSION_KEY, tapSpamShown);
      }
      return;
    }

    if (tapSpamBubbleId != null && get(notifications).some((item) => item.id === tapSpamBubbleId)) {
      return;
    }
    notifyRandomTap();
  }

  /** D4: a tap on a sleeping Kimchi. Forced, at most once per 20 s and 3 times per nap. */
  function notifySleepTalk() {
    const now = Date.now();
    if (sleepTalk.nap !== sleptAt) sleepTalk = { nap: sleptAt, count: 0, lastAt: 0 };
    if (sleepTalk.count >= SLEEP_TALK_PER_NAP || now - sleepTalk.lastAt < SLEEP_TALK_GAP_MS) {
      return;
    }

    const id = notify({ textKey: 'kimchi.sleep_talk' }, SLEEP_TALK_DURATION, {
      force: true,
      kind: 'sleep_talk',
    });
    if (id !== -1) sleepTalk = { ...sleepTalk, count: sleepTalk.count + 1, lastAt: now };
  }

  function handleAvatarClick() {
    if (!isAwake) {
      notifySleepTalk();
      return;
    }
    handleAwakeTap();
  }

  /** D7: the wake-up line for a nap of `napMs` (unknown length → the normal line). */
  function wakeLineKey(napMs) {
    if (!Number.isFinite(napMs) || napMs < 0) return 'kimchi.wake.normal';
    if (napMs < WAKE_SHORT_NAP_MS) return 'kimchi.wake.short';
    if (napMs > WAKE_LONG_NAP_MS) return 'kimchi.wake.long';
    return 'kimchi.wake.normal';
  }

  function handleStatusClick() {
    if (isAwake) {
      clearNotifications();
      notify({ textKey: 'kimchi.sleep' }, SLEEP_ZZZ_DURATION, { force: true, kind: 'sleep' });
      isAwake = false;
      setKimchiNotificationsEnabled(false);
      sleptAt = getKimchiAsleepSince() ?? Date.now();
      return;
    }

    const napMs = sleptAt == null ? NaN : Date.now() - sleptAt;
    isAwake = true;
    setKimchiNotificationsEnabled(true);
    sleptAt = null;
    notify({ textKey: wakeLineKey(napMs) }, TAP_DURATION, { kind: 'wake' });
  }

  $effect(() => {
    if (supabaseConfigured && !$authReady) return;

    const userId = $session?.user?.id ?? null;
    // A2: no welcome while the member agreement is pending; its signing gets one instead.
    const agreementPending = $needsMemberAgreement;

    if (!authGreetingHandled) {
      authGreetingHandled = true;
      previousUserId = userId;
      if (agreementPending) {
        agreementPendingUserId = userId;
      } else if (isItemDetailRoute(get(path))) {
        // D2: opened on an item link. Greet once the overlay closes, not behind it.
        deepLinkGreetingPending = true;
      } else {
        greetOnLoad(userId, { deepLink: landedOnItem });
      }
      return;
    }

    if (userId && userId === agreementPendingUserId && !agreementPending) {
      agreementPendingUserId = null;
      notifySignupComplete(userId);
    } else if (!previousUserId && userId) {
      if (agreementPending) {
        // Hold `logged_in`: CompleteSignupModal is up, and signing it gets "you're all set".
        agreementPendingUserId = userId;
      } else {
        notifyLoggedIn(userId);
      }
    } else if (previousUserId && !userId) {
      // Signed out: the next login (including an OAuth redirect) confirms again.
      agreementPendingUserId = null;
      writeLoggedInShown(null);
    }

    previousUserId = userId;
  });

  $effect(() => {
    const currentPath = $path;
    const firstRun = !pathEffectPrimed;
    pathEffectPrimed = true;

    if (deepLinkGreetingPending && !isItemDetailRoute(currentPath)) {
      deepLinkGreetingPending = false;
      scheduleDeepLinkGreeting();
    }

    // D9: an in-app move onto a 404. A cold landing gets its line with the welcome.
    if (!firstRun && authGreetingHandled && !isKnownAppPath(currentPath)) {
      notifyNotFound(currentPath);
    }
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
          onClose={handleUserClose}
          onLinkClick={handleLinkClick}
        />
      </div>
    {/each}
  </div>

  <div class="kimchi-widget__avatar-wrap">
    <button
      bind:this={avatarButton}
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
    >
      <span class="kimchi-widget__status-dot" aria-hidden="true"></span>
    </button>
  </div>
</div>

<!-- Outside every dialog. Filled only when a welcome couldn't show as a bubble (asleep). -->
<p class="visually-hidden" role="status">{statusText}</p>

<style>
  .kimchi-widget {
    position: fixed;
    right: calc(1rem + env(safe-area-inset-right, 0px));
    bottom: var(--corner-widget-bottom);
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

  /* Two-tone ring (Mint line, white halo outside it): the widget floats over
     page content such as the Mint Reserve buttons, so one tone always reaches
     3:1 against whatever is underneath. */
  .kimchi-widget__avatar:focus-visible {
    outline: 2px solid var(--color-mint, #024238);
    outline-offset: 0;
    box-shadow:
      0 0 0 4px #fff,
      0 4px 14px rgba(30, 30, 30, 0.25);
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

  /* Sleep / wake toggle: a 24 px target over the avatar's lower-right corner, around a
     smaller visible dot (-6px centres the dot where the old 14 px button sat). It comes
     after the avatar in the DOM, so it takes clicks where the two overlap. */
  .kimchi-widget__status {
    position: absolute;
    right: -6px;
    bottom: -6px;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }

  /* Green "online" presence dot, like a chat app status indicator. A soft drop shadow
     (no outline ring) lifts its white border off the avatar and light page backgrounds;
     the pulse stops repeat it. */
  .kimchi-widget__status-dot {
    width: 0.875rem;
    height: 0.875rem;
    box-sizing: border-box;
    border-radius: 50%;
    background: #34c759;
    border: 2.5px solid #fff;
    box-shadow: 0 1px 4px rgba(30, 30, 30, 0.4);
    animation: kimchi-online-pulse 2.4s ease-in-out infinite;
    transition: transform 0.15s ease;
  }

  .kimchi-widget__status:hover .kimchi-widget__status-dot {
    transform: scale(1.12);
  }

  /* Same two-tone ring as the avatar, around the whole target. The pulse animates
     box-shadow, so it stops while focused or it would paint over the white halo. */
  .kimchi-widget__status:focus-visible {
    outline: 2px solid var(--color-mint, #024238);
    outline-offset: 0;
    box-shadow: 0 0 0 4px #fff;
  }

  .kimchi-widget__status:focus-visible .kimchi-widget__status-dot {
    animation: none;
  }

  .kimchi-widget__status--offline .kimchi-widget__status-dot {
    background: #9e9e9e;
    animation: none;
  }

  @keyframes kimchi-online-pulse {
    0%,
    100% {
      box-shadow:
        0 1px 4px rgba(30, 30, 30, 0.4),
        0 0 0 0 rgba(52, 199, 89, 0.45);
    }
    50% {
      box-shadow:
        0 1px 4px rgba(30, 30, 30, 0.4),
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

  /* Reduced motion: no wiggle, pulse or hover growth; the hover glow stays. */
  @media (prefers-reduced-motion: reduce) {
    .kimchi-widget__avatar--talking,
    .kimchi-widget__status-dot {
      animation: none;
    }

    .kimchi-widget__avatar {
      transition: box-shadow 0.15s ease;
    }

    .kimchi-widget__status-dot {
      transition: none;
    }

    .kimchi-widget__avatar:hover,
    .kimchi-widget__status:hover .kimchi-widget__status-dot {
      transform: none;
    }
  }

  @media (max-width: 600px) {
    .kimchi-widget {
      right: calc(0.75rem + env(safe-area-inset-right, 0px));
    }
  }

  /* Short viewports (landscape phones, 400% zoom): a smaller Kimchi, narrower bubbles and
     only the newest one (plus an older one that holds keyboard focus, so focus never sits
     on a hidden bubble), so she covers less of the page. The dot keeps its 24 px target. */
  @media (max-height: 500px) {
    .kimchi-widget {
      gap: 0.375rem;
    }

    .kimchi-widget__bubble-area {
      width: min(15rem, calc(100vw - 2rem));
    }

    .kimchi-bubble-slot:not(:last-child):not(:focus-within) {
      display: none;
    }

    .kimchi-widget__avatar {
      width: 2.75rem;
      height: 2.75rem;
      border-width: 2px;
    }
  }
</style>
