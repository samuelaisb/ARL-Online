<script>
  import { tick } from 'svelte';
  import {
    approveHostedReservation,
    cancelAccountReservation,
    cancelHostedReservation,
    refuseHostedReservation,
    rescheduleHostedReservation,
  } from '../lib/inventory.js';
  import { compareDateKeys, parseDateKey } from '../lib/calendar.js';
  import { describeRoomTimes } from '../lib/reservation-rules.js';
  import { itemToPath, navigateToItem } from '../lib/router.js';
  import { locale, t } from '../lib/i18n.js';
  import {
    locationAddressLine,
    locationAreaLine,
    transitAppUrl,
  } from '../lib/item-location.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import { dayParts, pluralKey, progressFor, startsInParts, stickerFor, TOOL_KINDS } from '../lib/agenda.js';
  import {
    agendaDomId,
    BOOKING_TOOL_LABELS,
    CANCELLED_BY_KEYS,
    canCancelReservation,
    checkHostedReschedule,
    isActiveHosted,
    moveDraftStart,
    rescheduleDraftFor,
    RESERVATION_TOOL_PANELS,
  } from '../lib/agenda-booking.js';
  import ConfirmationMessage from './ConfirmationMessage.svelte';
  import InlineConfirm from './InlineConfirm.svelte';
  import LocationMapPanel from './LocationMapPanel.svelte';
  import MoreMenu from './MoreMenu.svelte';
  import ReservationMessageForm from './ReservationMessageForm.svelte';

  // One booking on the /account agenda: the member's own (`source: 'res'`), several of their own
  // with the same dates (`type: 'group'`), or a booking of an item they host (`source: 'host'`).
  // In Needs you a host's request is a Lemon "Approve a booking for …" card; in the timeline a
  // card with its More menu; in Earlier a compact past card. The actions, checks, messages and
  // Kimchi lines are AccountReservations' and AccountHostedReservations', with window.confirm
  // replaced by InlineConfirm (the same *_confirm questions). AccountAgenda owns the data and
  // the page-wide state (one action, one menu, one panel and one question at a time), passed in
  // as values plus setters. Everything is keyed by the entry key; a group's items by their own.
  let {
    entry,
    section = 'upcoming',
    todayKey,
    headingLevel = 3,
    busyKey = null,
    setBusy,
    openMenuKey = null,
    setOpenMenu,
    openPanel = null,
    setOpenPanel,
    confirmState = null,
    setConfirm,
    announce,
    registerTitle,
    focusAfter,
    replaceReservation,
    replaceHosted,
  } = $props();

  // This card's running request, `{ key, kind }` ('approve' | 'refuse' | 'cancel' | 'withdraw' |
  // 'reschedule' | 'message'), for the busy labels. `busyKey` (the page's) disables every button.
  let running = $state(null);
  // The last failed action, `{ key, kind, message }`: a failed new-dates save shows in its panel,
  // the others under the entry's buttons.
  let failure = $state(null);
  /** Optional message to the member, sent with Approve. */
  let approveMessages = $state({});
  /** "Choose new dates" fields per key `{ startDate, endDate, startTime, endTime }`, filled on open. */
  let rescheduleDrafts = $state({});
  /** Their errors per key, `{ dates, times }` (translated). */
  let rescheduleErrors = $state({});
  let rescheduleMessages = $state({});
  /** New dates that passed the checks and wait on their confirmation, per key. */
  let rescheduleChecked = $state({});
  // Map id → its map is open.
  let openMaps = $state({});
  let approveButton = $state(null);
  // Per key, for focus after an action or a panel.
  let menus = $state({});
  let confirms = $state({});
  let messageForms = $state({});
  let saveButtons = $state({});
  let startDateInputs = $state({});
  let startTimeInputs = $state({});

  const localeCode = $derived($locale === 'fr' ? 'fr-CA' : 'en-CA');
  const anyBusy = $derived(Boolean(busyKey));
  const domId = $derived(agendaDomId(entry.key));
  const items = $derived(entry.type === 'group' ? entry.items : [entry]);
  const variant = $derived(
    entry.type === 'group'
      ? 'group'
      : entry.needs === 'approve'
        ? 'approve'
        : section === 'earlier' || entry.phase === 'past'
          ? 'past'
          : 'timeline',
  );

  // One error on the page at a time, as in each old list: another entry's action clears this one's.
  $effect(() => {
    if (busyKey && !items.some((item) => item.key === busyKey)) {
      failure = null;
    }
  });

  /**
   * Registers a title link with the page, so focus can find the entry after it moves section.
   * Unmounting passes the element too: the page forgets the key only if it still points there
   * (the moved card's new copy may have registered first).
   */
  function titleLink(node, key) {
    let current = key;
    registerTitle?.(current, node);
    return {
      update(next) {
        if (next !== current) {
          registerTitle?.(current, null, node);
          current = next;
          registerTitle?.(current, node);
        }
      },
      destroy() {
        registerTitle?.(current, null, node);
      },
    };
  }

  function formatDateKey(dateKey, options = { dateStyle: 'medium' }) {
    const date = parseDateKey(dateKey);
    if (!date) {
      return dateKey ?? '';
    }

    return new Intl.DateTimeFormat(localeCode, options).format(date);
  }

  /** The confirmations' dates, as the old lists wrote them. */
  function formatDates(row) {
    const start = formatDateKey(row.startDate);
    if (!row.endDate || row.endDate === row.startDate) {
      return start;
    }

    return $t('account_reservations.dates', { start, end: formatDateKey(row.endDate) });
  }

  /** Room hours after a comma: French starts them with a capital ("De 18 h 00 à 21 h 00"). */
  function midSentence(text) {
    return text ? text.charAt(0).toLocaleLowerCase(localeCode) + text.slice(1) : text;
  }

  /** Dates, plus a room's hours, for the host's confirmations. */
  function describeWhen(row) {
    const times = midSentence(describeRoomTimes(row, $t, localeCode));
    return times ? `${formatDates(row)}, ${times}` : formatDates(row);
  }

  /** A card's short dates ("Nov 3 to Nov 10", the year only when it isn't this one), plus a room's hours. */
  function cardWhen(row) {
    const short = (dateKey) =>
      formatDateKey(dateKey, {
        month: 'short',
        day: 'numeric',
        ...(String(dateKey).slice(0, 4) !== String(todayKey).slice(0, 4) ? { year: 'numeric' } : {}),
      });
    const dates =
      !row.endDate || row.endDate === row.startDate
        ? short(row.startDate)
        : $t('account_reservations.dates', { start: short(row.startDate), end: short(row.endDate) });
    const times = midSentence(describeRoomTimes(row, $t, localeCode));
    return times ? `${dates}, ${times}` : dates;
  }

  /** The muted rest of a card's meta line: kind, when it starts, who booked or cancelled it. */
  function metaRest(item) {
    const { row } = item;
    const parts = [$t(`inventory.filter_${row.tag}`)];
    const startsIn = item.phase === 'confirmed' ? startsInParts(row.startDate, todayKey) : null;
    if (startsIn) {
      parts.push($t(startsIn.labelKey, startsIn.vars));
    }
    if (item.source === 'host' && !item.needs) {
      // A deleted member's rows stay in the records without their email.
      parts.push(
        row.memberEmail
          ? $t('account_agenda.booked_by', { email: row.memberEmail })
          : $t('account_agenda.booked_by_deleted'),
      );
    }
    const cancelledByKey = item.source === 'host' && row.status === 'cancelled' ? CANCELLED_BY_KEYS[row.cancelledBy] : '';
    if (cancelledByKey) {
      parts.push($t(cancelledByKey));
    }
    // A no-break space before each dot keeps it on the line it follows when the meta wraps.
    return parts.join('\u00a0· ');
  }

  /** What happened, then "the member has been told" when that's known to be true. */
  function statusLine(key, told) {
    return told ? `${$t(key)} ${$t('account_consultations.member_told_status')}` : $t(key);
  }

  function openItem(event, row) {
    event.preventDefault();
    // Marks the overlay entry, so closing it steps back to /account.
    navigateToItem({ tag: row.tag, slug: row.slug, title: row.title });
  }

  function isRunning(item, kind) {
    return running?.key === item.key && running.kind === kind;
  }

  /** The item's open tool panel ('' when none), only for a tool it still has. */
  function openToolOf(item) {
    return openPanel?.key === item.key && item.tools.includes(openPanel.tool) && TOOL_KINDS[openPanel.tool] === 'panel'
      ? openPanel.tool
      : '';
  }

  /** The question waiting on the item ('' when none): 'approve', 'refuse', 'cancel', 'withdraw', 'reschedule'. */
  function askingOf(item) {
    return confirmState?.key === item.key ? confirmState.action : '';
  }

  function clearFailure(item) {
    if (failure?.key === item.key) {
      failure = null;
    }
  }

  function toolLabel(item, tool) {
    if (tool === 'reschedule' && openToolOf(item) === 'reschedule') {
      return $t('account_hosted.reschedule_close');
    }
    return $t(BOOKING_TOOL_LABELS[item.source][tool]);
  }

  function menuItemsFor(item) {
    return item.tools.map((tool) => ({
      id: tool,
      label: toolLabel(item, tool),
      danger: TOOL_KINDS[tool] === 'confirm',
      onselect: () => (TOOL_KINDS[tool] === 'confirm' ? ask(item, tool) : openTool(item, tool)),
    }));
  }

  function toggleMenu(item, open) {
    if (open) {
      setOpenMenu?.(item.key);
      // Opening More puts away a question that was waiting on this entry.
      if (askingOf(item) && !running) {
        setConfirm?.(null);
      }
    } else if (openMenuKey === item.key) {
      setOpenMenu?.(null);
    }
  }

  function ensureDraft(item) {
    rescheduleDrafts[item.key] ??= rescheduleDraftFor(item.row);
    rescheduleErrors[item.key] ??= { dates: '', times: '' };
    return rescheduleDrafts[item.key];
  }

  async function focusToolField(item, tool) {
    await tick();
    if (tool === 'reschedule') {
      startDateInputs[item.key]?.focus();
    } else {
      messageForms[item.key]?.focus();
    }
  }

  /** Opens a tool's panel (one on the page), focused on its first field. */
  async function openTool(item, tool) {
    if (busyKey || running) {
      return;
    }

    const open = openToolOf(item);
    if (open === tool) {
      // "Hide new dates"; a message panel closes with its own Cancel.
      if (tool === 'reschedule') {
        closeTool(item);
      } else {
        focusToolField(item, tool);
      }
      return;
    }

    clearFailure(item);
    if (askingOf(item)) {
      setConfirm?.(null);
    }
    if (tool === 'reschedule') {
      rescheduleDrafts[item.key] = rescheduleDraftFor(item.row);
      rescheduleErrors[item.key] = { dates: '', times: '' };
    }
    setOpenPanel?.({ key: item.key, tool });
    await focusToolField(item, tool);
  }

  /** Closes the item's panel (sent, cancelled or hidden) and puts focus back on its More button. */
  async function closeTool(item) {
    if (openPanel?.key === item.key) {
      setOpenPanel?.(null);
    }
    await tick();
    menus[item.key]?.focusTrigger();
  }

  function closeToolsOf(item) {
    if (openPanel?.key === item.key) {
      setOpenPanel?.(null);
    }
  }

  /** Asks the action's question in the card (Approve, Save new dates, or a More item). */
  async function ask(item, action) {
    if (busyKey || running) {
      return;
    }

    clearFailure(item);
    // A More question takes the panel's place; Approve and Save ask beside theirs.
    if (action !== 'approve' && action !== 'reschedule') {
      closeToolsOf(item);
    }
    setConfirm?.({ key: item.key, action });
    await tick();
    confirms[item.key]?.focus();
  }

  /** Keep it: the question goes, focus returns to what asked it. */
  async function keep(item, action) {
    setConfirm?.(null);
    await tick();
    focusOpener(item, action);
  }

  function focusOpener(item, action) {
    if (action === 'approve') {
      approveButton?.focus();
    } else if (action === 'reschedule') {
      saveButtons[item.key]?.focus();
    } else {
      menus[item.key]?.focusTrigger();
    }
  }

  /** Starts a request: the page holds every other button until it's done. */
  function begin(item, kind) {
    running = { key: item.key, kind };
    failure = null;
    setBusy?.(item.key);
    announce?.('');
  }

  function finish() {
    running = null;
    setBusy?.(null);
  }

  function fail(item, kind, message) {
    setConfirm?.(null);
    failure = { key: item.key, kind, message };
  }

  function handleMessageBusy(item, busy) {
    running = busy ? { key: item.key, kind: 'message' } : null;
    setBusy?.(busy ? item.key : null);
    if (busy) {
      announce?.('');
    }
  }

  function handleMessageSent(item, tool) {
    const own = item.source === 'res';
    announce?.($t(own ? RESERVATION_TOOL_PANELS[tool].status : 'reservation_message.sent_status'));
    notify(
      { textKey: own ? RESERVATION_TOOL_PANELS[tool].kimchi : 'kimchi.message_sent' },
      DEFAULT_NOTIFICATION_DURATION,
    );
    closeTool(item);
  }

  /** The member withdraws a request or cancels a booking before its first day. */
  async function handleCancelReservation(item) {
    if (busyKey || running) {
      return;
    }

    const pending = item.row.status === 'pending';
    const kind = pending ? 'withdraw' : 'cancel';
    begin(item, kind);
    let failed = false;

    try {
      const updated = await cancelAccountReservation(item.row.id);
      setConfirm?.(null);
      closeToolsOf(item);
      replaceReservation?.(updated);
      announce?.($t(pending ? 'account_reservations.withdrawn_status' : 'account_reservations.cancelled_status'));
      notify(
        { textKey: pending ? 'kimchi.reservation_withdrawn' : 'kimchi.reservation_cancelled' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      fail(item, kind, error.message || $t('account_reservations.cancel_error'));
    } finally {
      finish();
    }

    // The disabled buttons dropped focus. On success the entry moved to Earlier, so its toggle;
    // on failure the More button the question came from.
    await tick();
    if (failed) {
      menus[item.key]?.focusTrigger();
    } else {
      focusAfter?.('earlier');
    }
  }

  async function handleApprove(item) {
    if (busyKey || running) {
      return;
    }

    const { row } = item;
    begin(item, 'approve');
    let failed = false;
    let movedToPast = false;

    try {
      const { reservation, emailSent } = await approveHostedReservation(row.id, approveMessages[item.key] ?? '');
      setConfirm?.(null);
      if (reservation?.id) {
        replaceHosted?.(reservation);
      }
      approveMessages[item.key] = '';
      movedToPast = !isActiveHosted({ ...row, ...reservation }, todayKey);
      const told = emailSent !== false && Boolean(row.memberEmail);
      announce?.(statusLine('account_hosted.approved_status', told));
      notify(
        { textKey: told ? 'kimchi.reservation_approved' : 'kimchi.reservation_approved_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      fail(item, 'approve', error.message || $t('account_hosted.approve_error'));
    } finally {
      finish();
    }

    // On success the entry left Needs you: focus its title in the timeline, or the Earlier toggle
    // when the request's dates had already ended; on failure, Approve.
    await tick();
    if (failed) {
      approveButton?.focus();
    } else {
      focusAfter?.(movedToPast ? 'earlier' : item.key);
    }
  }

  async function handleRefuse(item) {
    if (busyKey || running) {
      return;
    }

    const { row } = item;
    begin(item, 'refuse');
    let failed = false;

    try {
      const { reservation, emailSent } = await refuseHostedReservation(row.id);
      setConfirm?.(null);
      closeToolsOf(item);
      if (reservation?.id) {
        replaceHosted?.(reservation);
      }
      const told = emailSent !== false && Boolean(row.memberEmail);
      announce?.(statusLine('account_hosted.refused_status', told));
      notify(
        { textKey: told ? 'kimchi.reservation_refused' : 'kimchi.reservation_refused_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      fail(item, 'refuse', error.message || $t('account_hosted.refuse_error'));
    } finally {
      finish();
    }

    // On success the entry moved to Earlier; on failure, back to More.
    await tick();
    if (failed) {
      menus[item.key]?.focusTrigger();
    } else {
      focusAfter?.('earlier');
    }
  }

  async function handleHostedCancel(item) {
    if (busyKey || running) {
      return;
    }

    const { row } = item;
    begin(item, 'cancel');
    let failed = false;

    try {
      const { reservation, emailSent } = await cancelHostedReservation(row.id);
      setConfirm?.(null);
      closeToolsOf(item);
      if (reservation?.id) {
        replaceHosted?.(reservation);
      }
      const told = emailSent !== false && Boolean(row.memberEmail);
      announce?.(statusLine('account_hosted.cancelled_status', told));
      notify(
        { textKey: told ? 'kimchi.reservation_cancelled_owner' : 'kimchi.reservation_cancelled_owner_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      fail(item, 'cancel', error.message || $t('account_hosted.cancel_error'));
    } finally {
      finish();
    }

    await tick();
    if (failed) {
      menus[item.key]?.focusTrigger();
    } else {
      focusAfter?.('earlier');
    }
  }

  function setDraftStart(item, value) {
    moveDraftStart(ensureDraft(item), value);
    rescheduleErrors[item.key] = { ...rescheduleErrors[item.key], dates: '' };
    dropRescheduleQuestion(item);
  }

  function setDraftField(item, field, value) {
    ensureDraft(item)[field] = value;
    const errorField = field === 'endDate' ? 'dates' : 'times';
    rescheduleErrors[item.key] = { ...rescheduleErrors[item.key], [errorField]: '' };
    dropRescheduleQuestion(item);
  }

  // The question names the dates it checked: changing them puts it away until Save asks again.
  function dropRescheduleQuestion(item) {
    if (askingOf(item) === 'reschedule' && !running) {
      setConfirm?.(null);
    }
  }

  /** Save new dates: the checks first (focus on the first bad field), then the question. */
  function checkReschedule(item) {
    if (busyKey || running) {
      return;
    }

    const checked = checkHostedReschedule(item.row, ensureDraft(item), todayKey);
    const errors = {
      dates: checked.datesError ? $t(checked.datesError) : '',
      times: checked.timesError ? $t(checked.timesError) : '',
    };
    rescheduleErrors[item.key] = errors;
    if (errors.dates || errors.times) {
      (errors.dates ? startDateInputs[item.key] : startTimeInputs[item.key])?.focus();
      return;
    }

    rescheduleChecked[item.key] = checked;
    ask(item, 'reschedule');
  }

  async function handleReschedule(item) {
    const checked = rescheduleChecked[item.key];
    if (busyKey || running || !checked) {
      return;
    }

    const { row } = item;
    begin(item, 'reschedule');
    let failed = false;

    try {
      const { reservation, emailSent } = await rescheduleHostedReservation(row.id, {
        startDate: checked.startDate,
        endDate: checked.endDate,
        startTime: checked.startTime,
        endTime: checked.endTime,
        message: rescheduleMessages[item.key] ?? '',
      });
      setConfirm?.(null);
      closeToolsOf(item);
      if (reservation?.id) {
        replaceHosted?.(reservation);
      }
      rescheduleMessages[item.key] = '';
      const told = emailSent !== false && Boolean(row.memberEmail);
      announce?.(statusLine('account_hosted.rescheduled_status', told));
      notify(
        { textKey: told ? 'kimchi.reservation_rescheduled' : 'kimchi.reservation_rescheduled_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      fail(item, 'reschedule', error.message || $t('account_hosted.reschedule_error'));
    } finally {
      finish();
    }

    // On success the panel closes and the entry keeps its place: its title; on failure, Save.
    await tick();
    if (failed) {
      saveButtons[item.key]?.focus();
    } else {
      focusAfter?.(item.key);
    }
  }

  /** The question for an action: the old window.confirm text, then Yes (the action's own label). */
  function questionFor(item, action) {
    const { row } = item;
    const own = item.source === 'res';
    const vars = own
      ? { title: row.title, dates: formatDates(row) }
      : { title: row.title, email: row.memberEmail ?? '', dates: describeWhen(row) };

    if (action === 'approve') {
      return {
        message: $t('account_hosted.approve_confirm', vars),
        label: $t('account_hosted.approve'),
        busyLabel: $t('account_hosted.approving'),
        tone: 'primary',
        run: () => handleApprove(item),
      };
    }
    if (action === 'reschedule') {
      const checked = rescheduleChecked[item.key];
      return {
        message: $t('account_hosted.reschedule_confirm', {
          ...vars,
          dates: describeWhen({
            ...row,
            startDate: checked.startDate,
            endDate: checked.endDate,
            timeSlots: checked.timeSlots,
          }),
        }),
        label: $t('account_hosted.reschedule_save'),
        busyLabel: $t('account_hosted.reschedule_saving'),
        tone: 'primary',
        run: () => handleReschedule(item),
      };
    }
    if (action === 'refuse') {
      return {
        message: $t('account_hosted.refuse_confirm', vars),
        label: $t('account_hosted.refuse'),
        busyLabel: $t('account_hosted.refusing'),
        tone: 'danger',
        run: () => handleRefuse(item),
      };
    }
    if (action === 'withdraw') {
      return {
        message: $t('account_reservations.withdraw_confirm', vars),
        label: $t('account_reservations.withdraw'),
        busyLabel: $t('account_reservations.withdrawing'),
        tone: 'danger',
        run: () => handleCancelReservation(item),
      };
    }
    return {
      message: $t(own ? 'account_reservations.cancel_confirm' : 'account_hosted.cancel_confirm', vars),
      label: $t(own ? 'account_reservations.cancel' : 'account_hosted.cancel'),
      busyLabel: $t(own ? 'account_reservations.cancelling' : 'account_hosted.cancelling'),
      tone: 'danger',
      run: () => (own ? handleCancelReservation(item) : handleHostedCancel(item)),
    };
  }
</script>

{#snippet question(item, action)}
  {@const asked = questionFor(item, action)}
  <InlineConfirm
    bind:this={confirms[item.key]}
    id="{agendaDomId(item.key)}-confirm"
    message={asked.message}
    confirmLabel={asked.label}
    busyLabel={asked.busyLabel}
    busy={isRunning(item, action)}
    tone={asked.tone}
    onconfirm={asked.run}
    oncancel={() => keep(item, action)}
  />
{/snippet}

<!-- A failed action's error: the new-dates one inside its panel, the others under the entry. -->
{#snippet failureLine(item, inPanel)}
  {#if failure && failure.key === item.key && (failure.kind === 'reschedule') === inPanel}
    <p class="admin-status admin-status-error agenda-entry__error" role="alert">{failure.message}</p>
  {/if}
{/snippet}

{#snippet moreMenu(item)}
  <MoreMenu
    bind:this={menus[item.key]}
    id="{agendaDomId(item.key)}-more"
    label={$t('account_agenda.more')}
    ariaLabel={$t('account_agenda.more_aria', { title: `${item.title}, ${cardWhen(item.row)}` })}
    items={menuItemsFor(item)}
    open={openMenuKey === item.key}
    ontoggle={(open) => toggleMenu(item, open)}
    disabled={anyBusy}
  />
{/snippet}

{#snippet stickers(item)}
  {@const sticker = stickerFor(item)}
  {#if sticker && !item.needs}
    <span class="consultation-status consultation-status--{sticker.modifier}">{$t(sticker.labelKey)}</span>
  {/if}
  {#if item.source === 'host' && !item.needs}
    <span class="consultation-status consultation-status--your-item">{$t('account_agenda.sticker_your_item')}</span>
  {/if}
  {#if item.row?.bookedByStaff}
    <span class="consultation-status consultation-status--staff">{$t('account_hosted.booked_by_staff')}</span>
  {/if}
{/snippet}

<!-- "Day 4 of 8 · due back Tue, Nov 10" while a booking is under way (a room has nothing to bring back). -->
{#snippet progressRow(item)}
  {@const progress = progressFor(item, todayKey)}
  {#if progress}
    <div class="agenda-progress-row">
      <div class="agenda-progress" aria-hidden="true">
        <div class="agenda-progress__fill" style:width="{progress.pct}%"></div>
      </div>
      <span class="agenda-progress__text">
        {$t('account_agenda.day_of', { day: progress.day, total: progress.total })}{#if item.tag !== 'rooms'}{' · '}<strong
            class="f-hl">{$t('account_agenda.due_back', { date: dayParts(item.endDate, $locale).short })}</strong
          >{/if}
      </span>
    </div>
  {/if}
{/snippet}

{#snippet purposeField(row)}
  {#if row.purpose}
    <span class="consultation-field">
      <span class="consultation-field__label">{$t('account_reservations.purpose_label')}</span>
      <span class="consultation-field__value">{row.purpose}</span>
    </span>
  {/if}
{/snippet}

<!-- The server sends the full address only for a confirmed reservation that hasn't ended. -->
{#snippet location(row, place, mapId)}
  {@const address = locationAddressLine(place, $locale)}
  {@const transitUrl = transitAppUrl(place, $locale)}
  {@const hasMap = typeof place.latitude === 'number' && typeof place.longitude === 'number'}
  <div class="reservation-location agenda-location">
    <span class="consultation-field">
      <span class="consultation-field__label">{$t('account_reservations.location_label')}</span>
      <span class="agenda-location__address">{place.name ? `${place.name}, ${address}` : address}</span>
    </span>
    {#if row.tag !== 'rooms'}
      <span class="admin-consultation-detail">{$t('calendar.pickup_dropoff_hours')}</span>
    {/if}
    {#if place.directionsUrl || transitUrl}
      <span class="reservation-location__links">
        {#if place.directionsUrl}
          <a class="consultation-row__zoom" href={place.directionsUrl} target="_blank" rel="noopener noreferrer">
            {$t('account_reservations.get_directions')}<span class="visually-hidden"> {$t('account_reservations.directions_new_tab')}</span>
          </a>
        {/if}
        {#if transitUrl}
          <a class="consultation-row__zoom" href={transitUrl} target="_blank" rel="noopener noreferrer">
            {$t('account_reservations.open_in_transit')}<span class="visually-hidden"> {$t('account_reservations.transit_new_tab')}</span>
          </a>
        {/if}
      </span>
    {/if}
    {#if hasMap}
      <button
        type="button"
        class="f-disclosure f-disclosure--sm"
        aria-expanded={Boolean(openMaps[mapId])}
        aria-controls={mapId}
        onclick={() => (openMaps = { ...openMaps, [mapId]: !openMaps[mapId] })}
      >
        <svg class="f-disclosure__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3.5 12h17" /><path class="f-disclosure__stem" d="M12 3.5v17" />
        </svg>
        <span class="f-disclosure__text">{$t(openMaps[mapId] ? 'map.hide' : 'map.show')}</span>
      </button>
      {#if openMaps[mapId]}
        <LocationMapPanel
          id={mapId}
          latitude={place.latitude}
          longitude={place.longitude}
          stations={place.stations ?? []}
          label={$t('account_reservations.location_map_aria', { address })}
        />
      {/if}
    {/if}
  </div>
{/snippet}

<!-- What a member's own booking shows under its title: purpose, the area of a request, the address. -->
{#snippet ownDetails(row, mapId)}
  {#if row.status === 'pending' && row.location}
    <span class="admin-consultation-detail">
      {$t('account_reservations.location_pending', { area: locationAreaLine(row.location, $locale) })}
    </span>
  {/if}
  {#if row.status === 'reserved' && row.location?.streetAddress}
    {@render location(row, row.location, mapId)}
  {/if}
{/snippet}

<!-- A Lavender band along the card's bottom: what happens next, or how to change it. -->
{#snippet strip(text)}
  <p class="f-strip f-strip--in-card f-strip--icon">
    <svg class="f-strip__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="5.5" width="18" height="13" rx="1.5" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
    </svg>
    <span>{text}</span>
  </p>
{/snippet}

<!-- "Choose new dates". A start already past (a loan under way) stays pickable; the end can't be. -->
{#snippet reschedulePanel(item)}
  {@const row = item.row}
  {@const draft = rescheduleDrafts[item.key] ?? rescheduleDraftFor(row)}
  {@const errors = rescheduleErrors[item.key] ?? {}}
  {@const panelId = `${agendaDomId(item.key)}-reschedule`}
  {@const startMin = compareDateKeys(row.startDate, todayKey) < 0 ? row.startDate : todayKey}
  {@const endMin = parseDateKey(draft.startDate) && compareDateKeys(draft.startDate, todayKey) > 0 ? draft.startDate : todayKey}
  <div id={panelId} class="consultation-follow-up hosted-reschedule">
    <p class="admin-consultation-detail">{$t('account_hosted.reschedule_intro')}</p>
    <div class="hosted-reschedule__pair">
      <div class="hosted-reschedule__field">
        <label class="consultation-field__label" for="{panelId}-start">{$t('account_hosted.start_date_label')}</label>
        <input
          bind:this={startDateInputs[item.key]}
          id="{panelId}-start"
          type="date"
          class="admin-create-reservation__date hosted-reschedule__input"
          min={startMin}
          value={draft.startDate}
          aria-invalid={errors.dates ? 'true' : undefined}
          aria-describedby={errors.dates ? `${panelId}-dates-error` : undefined}
          oninput={(event) => setDraftStart(item, event.currentTarget.value)}
        />
      </div>
      <div class="hosted-reschedule__field">
        <label class="consultation-field__label" for="{panelId}-end">{$t('account_hosted.end_date_label')}</label>
        <input
          id="{panelId}-end"
          type="date"
          class="admin-create-reservation__date hosted-reschedule__input"
          min={endMin}
          value={draft.endDate}
          aria-invalid={errors.dates ? 'true' : undefined}
          aria-describedby={errors.dates ? `${panelId}-dates-error` : undefined}
          oninput={(event) => setDraftField(item, 'endDate', event.currentTarget.value)}
        />
      </div>
    </div>
    {#if errors.dates}
      <span id="{panelId}-dates-error" class="meeting-time-picker__error" role="alert">{errors.dates}</span>
    {/if}

    {#if row.tag === 'rooms'}
      <div class="hosted-reschedule__pair">
        <div class="hosted-reschedule__field">
          <label class="consultation-field__label" for="{panelId}-start-time">{$t('account_hosted.start_time_label')}</label>
          <input
            bind:this={startTimeInputs[item.key]}
            id="{panelId}-start-time"
            type="time"
            class="item-calendar__time-input hosted-reschedule__input"
            step="900"
            value={draft.startTime}
            aria-invalid={errors.times ? 'true' : undefined}
            aria-describedby="{panelId}-times-hint{errors.times ? ` ${panelId}-times-error` : ''}"
            oninput={(event) => setDraftField(item, 'startTime', event.currentTarget.value)}
          />
        </div>
        <div class="hosted-reschedule__field">
          <label class="consultation-field__label" for="{panelId}-end-time">{$t('account_hosted.end_time_label')}</label>
          <input
            id="{panelId}-end-time"
            type="time"
            class="item-calendar__time-input hosted-reschedule__input"
            step="900"
            value={draft.endTime}
            aria-invalid={errors.times ? 'true' : undefined}
            aria-describedby="{panelId}-times-hint{errors.times ? ` ${panelId}-times-error` : ''}"
            oninput={(event) => setDraftField(item, 'endTime', event.currentTarget.value)}
          />
        </div>
      </div>
      <span id="{panelId}-times-hint" class="meeting-time-picker__hint">{$t('calendar.room_times_hint')}</span>
      {#if errors.times}
        <span id="{panelId}-times-error" class="meeting-time-picker__error" role="alert">{errors.times}</span>
      {/if}
    {/if}

    {#if row.memberEmail}
      <ConfirmationMessage
        bind:value={rescheduleMessages[item.key]}
        label={$t('account_hosted.reschedule_message_label')}
      />
    {/if}
    <div class="admin-pending-actions">
      <button
        bind:this={saveButtons[item.key]}
        type="button"
        class="action-btn action-btn--primary"
        disabled={anyBusy}
        onclick={() => checkReschedule(item)}
      >
        {$t('account_hosted.reschedule_save')}
      </button>
      <button type="button" class="action-btn" disabled={anyBusy} onclick={() => closeTool(item)}>
        {$t('account_hosted.reschedule_close')}
      </button>
    </div>
    {#if askingOf(item) === 'reschedule' && rescheduleChecked[item.key]}
      {@render question(item, 'reschedule')}
    {/if}
    {@render failureLine(item, true)}
  </div>
{/snippet}

<!-- The open tool's panel, or a More question, under the entry. -->
{#snippet panel(item)}
  {@const tool = openToolOf(item)}
  {@const asking = askingOf(item)}
  {#if tool === 'reschedule'}
    <div class="agenda-entry__panel">{@render reschedulePanel(item)}</div>
  {:else if tool === 'message' || tool === 'new_time'}
    {@const own = item.source === 'res'}
    <div class="agenda-entry__panel">
      <ReservationMessageForm
        bind:this={messageForms[item.key]}
        reservationId={item.row.id}
        kind={tool}
        as={own ? 'member' : 'owner'}
        idPrefix="{agendaDomId(item.key)}-{tool}"
        label={$t(own ? RESERVATION_TOOL_PANELS[tool].label : 'account_hosted.message_label')}
        hint={$t(own ? RESERVATION_TOOL_PANELS[tool].hint : 'account_hosted.message_hint')}
        placeholder={own && RESERVATION_TOOL_PANELS[tool].placeholder ? $t(RESERVATION_TOOL_PANELS[tool].placeholder) : ''}
        disabled={anyBusy}
        onbusy={(busy) => handleMessageBusy(item, busy)}
        onsent={() => handleMessageSent(item, tool)}
        oncancel={() => closeTool(item)}
      />
    </div>
  {/if}
  {#if asking === 'refuse' || asking === 'cancel' || asking === 'withdraw'}
    <div class="agenda-entry__panel">{@render question(item, asking)}</div>
  {/if}
{/snippet}

{#if variant === 'approve'}
  {@const row = entry.row}
  {@const startsIn = startsInParts(row.startDate, todayKey)}
  <!-- A request for the viewer's item: their dates and words on the left, Approve on the right. -->
  <article id={domId} class="agenda-entry f-card needs-you" aria-labelledby="{domId}-title">
    <div class="needs-you__band">
      <svelte:element this={`h${headingLevel}`} id="{domId}-title" class="needs-you__title">
        {row.memberEmail
          ? $t('account_agenda.approve_booking_for', { email: row.memberEmail })
          : $t('account_agenda.approve_booking')}
      </svelte:element>
      <p class="needs-you__meta">
        <a use:titleLink={entry.key} href={itemToPath(row)} onclick={(event) => openItem(event, row)}>{entry.title}</a>
        · {$t(`inventory.filter_${row.tag}`)}
      </p>
    </div>
    <div class="needs-you__body">
      <div class="needs-you__request">
        <div class="agenda-entry__meta">
          {@render stickers(entry)}
          <span class="agenda-entry__when">{cardWhen(row)}</span>
          {#if startsIn}
            <span>{$t(startsIn.labelKey, startsIn.vars)}</span>
          {/if}
        </div>
        {@render purposeField(row)}
      </div>
      <div class="needs-you__answer">
        <!-- Hidden while the new dates panel (with its own message) is open; the text is kept. -->
        {#if row.memberEmail && openToolOf(entry) !== 'reschedule'}
          <ConfirmationMessage
            bind:value={approveMessages[entry.key]}
            label={$t('account_hosted.approve_message_label')}
            hint={$t('account_hosted.approve_message_hint')}
          />
        {/if}
        <div class="agenda-entry__actions">
          <button
            bind:this={approveButton}
            type="button"
            class="action-btn action-btn--primary"
            disabled={anyBusy}
            onclick={() => ask(entry, 'approve')}
          >
            {$t('account_hosted.approve')}
          </button>
          {#if entry.tools.length > 0}
            {@render moreMenu(entry)}
          {/if}
        </div>
        {#if askingOf(entry) === 'approve'}
          {@render question(entry, 'approve')}
        {/if}
        {@render failureLine(entry, false)}
      </div>
      {@render panel(entry)}
    </div>
  </article>
{:else if variant === 'group'}
  {@const first = entry.items[0]}
  {@const started = first.row.status === 'reserved' && !canCancelReservation(first.row, todayKey)}
  <!-- Own bookings with the same dates, hours and place: one card, a row (and More) per item. -->
  <article id={domId} class="agenda-entry f-card agenda-entry--group">
    <div class="agenda-entry__top">
      <div class="agenda-entry__main">
        <div class="agenda-entry__meta">
          {@render stickers(entry)}
          <span class="agenda-entry__when">{cardWhen(first.row)}</span>
          <span>{metaRest(first)}</span>
        </div>
        <svelte:element this={`h${headingLevel}`} class="agenda-entry__title">
          {$t(pluralKey('account_agenda.items_count', entry.items.length), { count: entry.items.length })}
        </svelte:element>
      </div>
    </div>
    {#if entry.phase === 'progress'}
      {@render progressRow(entry)}
    {/if}
    {#if first.row.location?.streetAddress && first.row.status === 'reserved'}
      <div class="agenda-entry__body">{@render ownDetails(first.row, `${domId}-map`)}</div>
    {/if}
    <ul class="agenda-entry__items">
      {#each entry.items as item (item.key)}
        <li class="agenda-entry__item">
          <p class="agenda-entry__item-title">
            <a use:titleLink={item.key} href={itemToPath(item.row)} onclick={(event) => openItem(event, item.row)}>
              {item.title}
            </a>
          </p>
          {#if item.tools.length > 0}
            {@render moreMenu(item)}
          {/if}
          {@render purposeField(item.row)}
          {@render failureLine(item, false)}
          {@render panel(item)}
        </li>
      {/each}
    </ul>
    {#if started}
      {@render strip($t('account_reservations.started_hint'))}
    {/if}
  </article>
{:else}
  {@const row = entry.row}
  {@const past = variant === 'past'}
  {@const own = entry.source === 'res'}
  {@const pendingHint = own && !past && row.status === 'pending'}
  {@const startedHint = own && !past && entry.statusKey === 'reserved' && !canCancelReservation(row, todayKey)}
  <!-- A past card stays compact: its meta, title and More only. -->
  {@const hasBody =
    !past &&
    (Boolean(row.purpose) ||
      (own && ((row.status === 'pending' && row.location) || (row.status === 'reserved' && row.location?.streetAddress))))}
  <article id={domId} class="agenda-entry f-card" class:agenda-entry--past={past}>
    <div class="agenda-entry__top">
      <div class="agenda-entry__main">
        <div class="agenda-entry__meta">
          {@render stickers(entry)}
          <span class="agenda-entry__when">{cardWhen(row)}</span>
          <span>{metaRest(entry)}</span>
        </div>
        <svelte:element this={`h${headingLevel}`} class="agenda-entry__title">
          <a use:titleLink={entry.key} href={itemToPath(row)} onclick={(event) => openItem(event, row)}>{entry.title}</a>
        </svelte:element>
      </div>
      {#if entry.tools.length > 0}
        <div class="agenda-entry__actions">{@render moreMenu(entry)}</div>
      {/if}
    </div>
    {#if entry.phase === 'progress'}
      {@render progressRow(entry)}
    {/if}
    {#if hasBody}
      <div class="agenda-entry__body">
        {@render purposeField(row)}
        {#if own}
          {@render ownDetails(row, `${domId}-map`)}
        {/if}
      </div>
    {/if}
    {@render failureLine(entry, false)}
    {@render panel(entry)}
    {#if pendingHint}
      {@render strip($t('account_reservations.pending_hint'))}
    {:else if startedHint}
      {@render strip($t('account_reservations.started_hint'))}
    {/if}
  </article>
{/if}
