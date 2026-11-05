<script module>
  /** B6 nudges shown in this tab (`id:phase`), kept here too in case sessionStorage is blocked. */
  const meetingNudgesShown = new Set();
</script>

<script>
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import {
    fetchAccountConsultations,
    fetchAccountReservations,
    fetchHostedReservations,
  } from '../lib/inventory.js';
  import { isApathyAdmin, session } from '../lib/auth.js';
  import { navigate } from '../lib/router.js';
  import { libraryTodayKey } from '../lib/calendar.js';
  import { locale, t } from '../lib/i18n.js';
  import { dismiss, dismissKind, isKimchiAwake, notifyWhenIdle } from '../lib/notification-store.js';
  import {
    hasSeen,
    markSeen,
    readSessionJson,
    readSnapshot,
    writeSessionJson,
    writeSnapshot,
  } from '../lib/kimchi-memory.js';
  import {
    availabilityNow,
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import { buildAgenda, dayParts, pluralKey, weekLabelParts } from '../lib/agenda.js';
  import {
    findClosedByOthers,
    heldStatusesFor,
    meetingNudgeAt,
    meetingNudgeKey,
    meetingNudgeMessage,
    MEETING_NUDGE_DURATION,
    MEETING_NUDGE_SESSION_KEY,
    PANEL_BUBBLE_KIND,
    pickLoadBubble,
    rowKey,
    statusSnapshot,
    STATUS_SNAPSHOT,
  } from '../lib/consultation-notices.js';
  import { formatDateKey } from '../lib/agenda-consultation.js';
  import AgendaBookingCard from './AgendaBookingCard.svelte';
  import AgendaConsultationCard from './AgendaConsultationCard.svelte';
  import Skeleton from './Skeleton.svelte';

  // /account's agenda (design F): the member's own bookings, the bookings of the items they
  // host and their consultations in both roles, in one list of sections (src/lib/agenda.js).
  // This page loads the three lists, owns the clock and the one-at-a-time state (one action,
  // one open More menu, one tool panel and one question on the whole agenda), and keeps
  // AccountConsultations' load-time notices: the status snapshot, "Changed since your last
  // visit" (B4) and at most one Kimchi bubble per visit (B6 > B4 > B5 > C8). The cards run
  // their own requests and report back through the setters and mutators below.

  /** The timeline's sticker legend, in the board's order. */
  const LEGEND = [
    { modifier: 'progress', labelKey: 'account_agenda.sticker_in_progress' },
    { modifier: 'scheduled', labelKey: 'account_consultations.status_reserved' },
    { modifier: 'reserved', labelKey: 'account_reservations.status_reserved' },
    { modifier: 'pending', labelKey: 'account_reservations.status_pending' },
  ];
  const EARLIER_LIST_ID = 'agenda-earlier-list';

  let loading = $state(true);
  // One error per list, as the three old sections had; the hosted one is shown to staff only.
  let reservationsError = $state('');
  let hostedError = $state('');
  let consultationsError = $state('');
  let reservations = $state([]);
  let hosted = $state([]);
  let asMember = $state([]);
  let asExpert = $state([]);

  // The key of the entry whose request is running: every other action waits.
  let busyKey = $state(null);
  let openMenuKey = $state(null);
  // The one open tool panel, `{ key, tool }`, or null. Opening one closes the others.
  let openPanel = $state(null);
  // The one question waiting for Yes or Keep it, `{ key, action }`, or null.
  let confirmState = $state(null);
  // F8: actions remove or disable the pressed button and Kimchi may be asleep, so the
  // outcome is announced here too.
  let statusMessage = $state('');
  let showEarlier = $state(false);
  let earlierToggle = $state(null);
  let agendaHeading = $state(null);
  /** Each entry's title link by entry key, for focus after an action moves the entry. */
  const titles = {};
  /** Row keys someone else cancelled or declined since this browser last looked (B4). */
  let recentlyClosed = $state([]);
  /** B4 rows whose bubble hasn't shown yet, `{ [rowKey]: status before }`: the snapshot keeps that status so a later visit finds them again. */
  let heldStatuses = {};
  let destroyed = false;
  let meetingNudgeWaiting = false;

  const now = $derived.by(() => Math.max($availabilityNow, Date.now()));
  const todayKey = $derived(libraryTodayKey(new Date(now)));
  const agenda = $derived(
    buildAgenda({ reservations, hosted, asMember, asExpert, now, todayKey, recentKeys: recentlyClosed }),
  );
  const showHostedError = $derived(Boolean(hostedError) && isApathyAdmin($session));
  // An empty agenda only says so when every list it shows has loaded.
  const showEmpty = $derived(agenda.isEmpty && !reservationsError && !consultationsError && !showHostedError);
  const hasComingUp = $derived(agenda.waiting.length > 0 || agenda.weeks.length > 0);

  async function loadList(fetchList, fallbackKey) {
    try {
      return { rows: await fetchList(), error: '' };
    } catch (error) {
      return { rows: null, error: error.message || $t(fallbackKey) };
    }
  }

  async function load() {
    loading = true;

    const [own, items, consultations] = await Promise.all([
      loadList(fetchAccountReservations, 'account_reservations.load_error'),
      loadList(fetchHostedReservations, 'account_hosted.load_error'),
      loadList(fetchAccountConsultations, 'account_consultations.load_error'),
    ]);

    reservations = own.rows ?? [];
    reservationsError = own.error;
    hosted = items.rows ?? [];
    hostedError = items.error;
    asMember = consultations.rows?.asMember ?? [];
    asExpert = consultations.rows?.asExpert ?? [];
    consultationsError = consultations.error;
    loading = false;

    if (!consultationsError) {
      announceAfterLoad();
    }
  }

  // --- What the cards call ------------------------------------------------------------------

  function setBusy(key) {
    busyKey = key;
  }

  function setOpenMenu(key) {
    openMenuKey = key;
  }

  function setOpenPanel(panel) {
    openPanel = panel;
  }

  function setConfirm(state) {
    confirmState = state;
  }

  function announce(text) {
    statusMessage = text;
  }

  /**
   * A card's title link, by entry key. A card unmounting passes its link as `previous`: the key
   * is forgotten only if it still points there, since a card that moves section can mount its
   * new copy first.
   */
  function registerTitle(key, el, previous) {
    if (el) {
      titles[key] = el;
    } else if (!previous || titles[key] === previous) {
      delete titles[key];
    }
  }

  /**
   * After an action: the entry's title (`key`), the Earlier toggle (`'earlier'`), or the agenda's
   * heading (`'agenda'`, and whenever the target is gone).
   */
  async function focusAfter(target) {
    await tick();
    const el = target === 'earlier' ? earlierToggle : target === 'agenda' ? null : titles[target];
    (el?.isConnected ? el : agendaHeading)?.focus();
  }

  function replaceReservation(updated) {
    if (!updated?.id) {
      return;
    }
    reservations = reservations.map((row) => (row.id === updated.id ? { ...row, ...updated } : row));
  }

  function replaceHosted(updated) {
    if (!updated?.id) {
      return;
    }
    hosted = hosted.map((row) => (row.id === updated.id ? { ...row, ...updated } : row));
  }

  /** The same consultation can be listed under both roles: update both, each keeping its role. */
  function replaceConsultation(updated) {
    const swap = (rows) => rows.map((row) => (row.id === updated.id ? { ...row, ...updated, role: row.role } : row));
    asMember = swap(asMember);
    asExpert = swap(asExpert);
  }

  /** A follow-up the mentor just booked (the row already carries `role: 'expert'`). */
  function appendConsultation(row) {
    asExpert = [...asExpert, row];
  }

  /** Remember every consultation's status for this user, so the next visit can tell what changed (B4). */
  function rememberStatuses() {
    const userId = $session?.user?.id;
    if (!userId) {
      return;
    }
    writeSnapshot(userId, STATUS_SNAPSHOT, statusSnapshot([...asMember, ...asExpert], heldStatuses));
  }

  // --- Kimchi after the consultations load ----------------------------------------------------

  /** Waits until nothing would hide the bubble; one that lands after the page is gone is dropped. */
  async function sendPanelBubble(message, duration) {
    const id = await notifyWhenIdle(message, duration, { kind: PANEL_BUBBLE_KIND });
    if (id !== -1 && destroyed) {
      dismiss(id);
      return -1;
    }
    return id;
  }

  /**
   * After the consultations load: keep what others closed since the last visit in view (B4's
   * "Changed since your last visit"), then at most one Kimchi bubble for this visit, in the
   * order B6 > B4 > B5 > C8.
   */
  async function announceAfterLoad() {
    const userId = $session?.user?.id;
    if (!userId || destroyed) {
      return;
    }

    const isSeen = (scope, id) => hasSeen(userId, scope, id);
    const previous = readSnapshot(userId, STATUS_SNAPSHOT);
    const closedByOthers = findClosedByOthers([...asMember, ...asExpert], previous);
    recentlyClosed = closedByOthers.map(rowKey);
    // An unannounced B4 row keeps its old status until its bubble really shows (B6 or a busy
    // page can take this visit). Asleep, the inline list is the carrier, so the snapshot moves on.
    heldStatuses = isKimchiAwake() ? heldStatusesFor(closedByOthers, previous, isSeen) : {};
    rememberStatuses();

    // A meeting about to start takes this visit's bubble; the clock effect below sends it.
    if (meetingNudgeAt([...asMember, ...asExpert], Date.now(), meetingNudgeShown)) {
      return;
    }

    const pick = pickLoadBubble({
      closedByOthers,
      asMember,
      asExpert,
      todayKey: libraryTodayKey(),
      isSeen,
      formatDate: (dateKey) => formatDateKey(dateKey, $locale),
    });
    if (!pick || (await sendPanelBubble(pick.message, pick.duration)) === -1) {
      return;
    }

    pick.seen.ids.forEach((id) => markSeen(userId, pick.seen.scope, id));
    if (pick.kind === 'closed') {
      delete heldStatuses[pick.seen.ids[0]];
      rememberStatuses();
    }
  }

  function meetingNudgeShown(key) {
    const shown = readSessionJson(MEETING_NUDGE_SESSION_KEY, []);
    return meetingNudgesShown.has(key) || (Array.isArray(shown) && shown.includes(key));
  }

  function rememberMeetingNudge(nudge) {
    const key = meetingNudgeKey(nudge);
    const shown = readSessionJson(MEETING_NUDGE_SESSION_KEY, []);
    meetingNudgesShown.add(key);
    writeSessionJson(MEETING_NUDGE_SESSION_KEY, [...(Array.isArray(shown) ? shown : []), key].slice(-50));
  }

  /** Never puts the Zoom link in the bubble: it points at the entry's Join link and chip. */
  async function sendMeetingNudge(nudge) {
    if (meetingNudgeWaiting) {
      return;
    }

    meetingNudgeWaiting = true;
    const id = await sendPanelBubble(meetingNudgeMessage(nudge), MEETING_NUDGE_DURATION);
    meetingNudgeWaiting = false;

    if (id !== -1) {
      rememberMeetingNudge(nudge);
    }
  }

  // --- Page -----------------------------------------------------------------------------------

  /** "Due back: A, B and C", in the page's language. */
  function dueTitles(names) {
    return new Intl.ListFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', { type: 'conjunction' }).format(names);
  }

  function openPath(event, path) {
    event.preventDefault();
    navigate(path);
  }

  onMount(() => {
    subscribeAvailabilityClock();
    load();
  });

  onDestroy(() => {
    destroyed = true;
    unsubscribeAvailabilityClock();
    // "On this page" / "below" stop being true once the agenda is gone.
    dismissKind(PANEL_BUBBLE_KIND);
  });

  // B6: the shared minute clock re-checks the window, so a page left open still gets the nudge.
  $effect(() => {
    if (loading || consultationsError) {
      return;
    }

    const nudge = meetingNudgeAt([...asMember, ...asExpert], now, meetingNudgeShown);
    if (nudge) {
      untrack(() => sendMeetingNudge(nudge));
    }
  });
</script>

{#snippet card(entry, section, headingLevel)}
  {#if entry.type === 'consultation'}
    <AgendaConsultationCard
      {entry}
      {section}
      {headingLevel}
      {busyKey}
      {setBusy}
      {openMenuKey}
      {setOpenMenu}
      {openPanel}
      {setOpenPanel}
      {confirmState}
      {setConfirm}
      {announce}
      {registerTitle}
      {focusAfter}
      {replaceConsultation}
      {appendConsultation}
      {rememberStatuses}
    />
  {:else}
    <AgendaBookingCard
      {entry}
      {section}
      {todayKey}
      {headingLevel}
      {busyKey}
      {setBusy}
      {openMenuKey}
      {setOpenMenu}
      {openPanel}
      {setOpenPanel}
      {confirmState}
      {setConfirm}
      {announce}
      {registerTitle}
      {focusAfter}
      {replaceReservation}
      {replaceHosted}
    />
  {/if}
{/snippet}

<!-- One day of the timeline: the weekday and date on the rail, then a node on the line beside
     each entry. The rail is drawn for the eye; the hidden heading names the day. -->
{#snippet timelineDay(day)}
  {@const parts = dayParts(day.dayKey, $locale)}
  <li class="agenda-day">
    <h4 class="visually-hidden">
      {day.isToday ? $t('account_agenda.today_marker', { date: parts.full }) : parts.full}
    </h4>
    <div class="agenda-day__rail" aria-hidden="true">
      <span class="f-label">{parts.weekday}</span>
      <span class="agenda-day__num" class:agenda-day__num--today={day.isToday}>{parts.day}</span>
    </div>
    <div class="agenda-day__line" aria-hidden="true"></div>
    <ul class="agenda-day__entries">
      {#if day.entries.length === 0}
        <li class="agenda-day__item agenda-today">
          <span class="consultation-status consultation-status--starts-today">
            {$t('account_agenda.today_marker', { date: parts.short })}
          </span>
        </li>
      {/if}
      {#each day.entries as entry (entry.key)}
        <li class="agenda-day__item">
          <span class="agenda-node agenda-node--{entry.phase}" aria-hidden="true"></span>
          {#if entry.type === 'due'}
            <p class="agenda-due">
              {$t('account_agenda.due_back_title', { titles: dueTitles(entry.titles) })}
              <span class="agenda-due__sub">{$t('calendar.pickup_dropoff_hours')}</span>
            </p>
          {:else}
            {@render card(entry, 'upcoming', 5)}
          {/if}
        </li>
      {/each}
    </ul>
  </li>
{/snippet}

<section class="agenda" aria-labelledby="agenda-heading">
  <h2 bind:this={agendaHeading} id="agenda-heading" class="visually-hidden" tabindex="-1">
    {$t('account_agenda.heading')}
  </h2>
  <p class="visually-hidden" role="status">{statusMessage}</p>

  {#if loading}
    <Skeleton heading count={3} label={$t('account_agenda.loading')} />
  {:else}
    {#if reservationsError}
      <p class="admin-status admin-status-error" role="alert">{reservationsError}</p>
    {/if}
    <!-- Only staff create rooms, equipment and books, so only they can host any: a member who
         hosts nothing isn't shown an error about a list they never see. -->
    {#if showHostedError}
      <p class="admin-status admin-status-error" role="alert">{hostedError}</p>
    {/if}
    {#if consultationsError}
      <p class="admin-status admin-status-error" role="alert">{consultationsError}</p>
    {/if}

    {#if showEmpty}
      <p class="empty-state">
        {$t('account_agenda.empty')}
        <a href="/" onclick={(event) => openPath(event, '/')}>{$t('account_reservations.browse')}</a>
        ·
        <a href="/expertise" onclick={(event) => openPath(event, '/expertise')}>
          {$t('account_consultations.browse_expertise')}
        </a>
      </p>
    {:else if !agenda.isEmpty}
      {#if agenda.needsYou.length > 0}
        <section class="agenda-section" aria-labelledby="agenda-needs-heading">
          <div class="agenda-section__head">
            <h2 id="agenda-needs-heading" class="f-title">{$t('account_agenda.needs_you_heading')}</h2>
            <span class="consultation-status consultation-status--needs-you">
              {$t(pluralKey('account_agenda.needs_you_count', agenda.needsYou.length), {
                count: agenda.needsYou.length,
              })}
            </span>
          </div>
          <ul class="agenda-list">
            {#each agenda.needsYou as entry (entry.key)}
              <li>{@render card(entry, 'needsYou', 3)}</li>
            {/each}
          </ul>
        </section>
      {/if}

      <section class="agenda-section" aria-labelledby="agenda-coming-heading">
        <div class="agenda-section__head">
          <h2 id="agenda-coming-heading" class="f-title">{$t('account_agenda.coming_up_heading')}</h2>
          {#if agenda.weeks.length > 0}
            <ul class="agenda-legend" aria-label={$t('account_agenda.legend_aria')}>
              {#each LEGEND as sticker (sticker.modifier)}
                <li><span class="consultation-status consultation-status--{sticker.modifier}">{$t(sticker.labelKey)}</span></li>
              {/each}
            </ul>
          {/if}
        </div>
        <p class="agenda-section__intro">
          {$t(hasComingUp ? 'account_agenda.coming_up_intro' : 'account_agenda.coming_up_empty')}
        </p>

        {#if agenda.waiting.length > 0}
          <h3 class="agenda-week f-label">{$t('account_agenda.waiting_heading')}</h3>
          <ul class="agenda-list">
            {#each agenda.waiting as entry (entry.key)}
              <li>{@render card(entry, 'waiting', 4)}</li>
            {/each}
          </ul>
        {/if}

        {#each agenda.weeks as week (week.key)}
          {@const label = weekLabelParts(week.start, agenda.timelineTodayKey, $locale)}
          <h3 class="agenda-week f-label">{$t(label.labelKey, label.vars)}</h3>
          <ol class="agenda-days">
            {#each week.days as day (day.key)}
              {@render timelineDay(day)}
            {/each}
          </ol>
        {/each}
      </section>

      <!-- B4: cancelled or declined by someone else since the last visit, outside the collapsed Earlier list. -->
      {#if agenda.recent.length > 0}
        <section class="agenda-section" aria-labelledby="agenda-recent-heading">
          <h2 id="agenda-recent-heading" class="agenda-week f-label">{$t('account_consultations.recent_heading')}</h2>
          <ul class="agenda-list">
            {#each agenda.recent as entry (entry.key)}
              <li>{@render card(entry, 'recent', 3)}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if agenda.earlier.length > 0}
        <section class="agenda-section" aria-labelledby="agenda-earlier-heading">
          <h2 id="agenda-earlier-heading" class="agenda-week f-label">{$t('account_agenda.earlier_heading')}</h2>
          <button
            bind:this={earlierToggle}
            type="button"
            class="f-disclosure"
            aria-expanded={showEarlier}
            aria-controls={EARLIER_LIST_ID}
            onclick={() => (showEarlier = !showEarlier)}
          >
            <svg class="f-disclosure__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3.5 12h17" />
              <path class="f-disclosure__stem" d="M12 3.5v17" />
            </svg>
            <span class="f-disclosure__text">
              {showEarlier
                ? $t('account_agenda.earlier_hide')
                : $t(pluralKey('account_agenda.earlier_show', agenda.earlier.length), { count: agenda.earlier.length })}
            </span>
          </button>
          <div id={EARLIER_LIST_ID}>
            {#if showEarlier}
              <ul class="agenda-earlier__list">
                {#each agenda.earlier as entry (entry.key)}
                  <li>{@render card(entry, 'earlier', 3)}</li>
                {/each}
              </ul>
            {/if}
          </div>
        </section>
      {/if}
    {/if}
  {/if}
</section>
