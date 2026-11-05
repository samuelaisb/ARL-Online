<script>
  import { tick } from 'svelte';
  import {
    bookFollowUpConsultation,
    cancelConsultation,
    rescheduleConsultation,
    scheduleConsultation,
  } from '../lib/inventory.js';
  import { FOLLOW_UP_NOTE_MAX } from '../lib/expertise-fields.js';
  import { navigate } from '../lib/router.js';
  import { locale, t } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import { stickerFor, timingStickerFor, TOOL_KINDS } from '../lib/agenda.js';
  import { rowKey } from '../lib/consultation-notices.js';
  import {
    cancelFeedbackFor,
    cancelLabelKeys,
    formatDateKey,
    formatMeetingClock,
    formatMeetingTime,
    meetingTimeErrorKey,
    MESSAGE_TOOLS,
    otherSideTold,
    toolLabelKey,
    toolPanelId,
  } from '../lib/agenda-consultation.js';
  import MeetingTimePicker, { parseMeetingTimeInput, toLocalInputValue } from './MeetingTimePicker.svelte';
  import ConfirmationMessage from './ConfirmationMessage.svelte';
  import InlineConfirm from './InlineConfirm.svelte';
  import MoreMenu from './MoreMenu.svelte';
  import ReservationMessageForm from './ReservationMessageForm.svelte';

  // One consultation on /account's agenda (AccountAgenda), in either role. `section` picks the
  // card: 'needsYou' (a mentor's request to pick a time for: the form sits in the card),
  // 'waiting' (the member's request), 'upcoming' (a scheduled meeting on the timeline), or
  // 'recent' / 'earlier' (closed, compact). The page owns the data and the one-at-a-time state
  // (busyKey, the open menu, panel and question); the card runs its own requests and tells the
  // page through the setters and mutators. `entry` comes from buildAgenda, so its tools,
  // timing and follow-up rule already follow the minute clock. `headingLevel` is the title's
  // level under the page's section, week and day headings.
  let {
    entry,
    section,
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
    replaceConsultation,
    appendConsultation,
    rememberStatuses,
  } = $props();

  // Per-row maps keyed by the consultation's id, as on the old page: they start empty, so the
  // first bound value is undefined (MeetingTimePicker and ConfirmationMessage have no fallbacks).
  let meetingTimes = $state({});
  let meetingTimeErrors = $state({});
  /** Optional message to the member, sent with Schedule. */
  let scheduleMessages = $state({});
  let rescheduleTimes = $state({});
  let rescheduleTimeErrors = $state({});
  let rescheduleMessages = $state({});
  let followUpTimes = $state({});
  let followUpTimeErrors = $state({});
  let followUpNotes = $state({});
  // The request this card runs: 'schedule' | 'cancel' | 'reschedule' | 'follow-up' |
  // 'message'. The page's busyKey holds every other button while it runs; only this one shows busy.
  let running = $state('');
  let actionError = $state('');
  // Which action failed: a follow-up's or a new time's error shows in its panel, the others
  // under the card's buttons.
  let actionErrorKind = $state('');
  /** The time the open question names: Yes books exactly that, whatever the field says now. */
  let questionMeetingAt = $state('');
  let detailsOpen = $state(false);

  let titleLink = $state(null);
  let moreMenu = $state(null);
  let scheduleButton = $state(null);
  let rescheduleButton = $state(null);
  let followUpButton = $state(null);
  let meetingPicker = $state(null);
  let reschedulePicker = $state(null);
  let followUpPicker = $state(null);
  let messageForm = $state(null);

  const row = $derived(entry.row);
  const cardId = $derived(`agenda-${entry.key.replace(/[^\w-]/g, '-')}`);
  const titleId = $derived(`${cardId}-title`);
  const busy = $derived(Boolean(busyKey));
  const past = $derived(section === 'recent' || section === 'earlier');
  const sticker = $derived(stickerFor(entry));
  const timingSticker = $derived(timingStickerFor(entry.timing));
  // A tool the server no longer allows (a meeting that started) closes its panel.
  const activeTool = $derived(
    openPanel?.key === entry.key && entry.tools.includes(openPanel.tool) ? openPanel.tool : '',
  );
  const question = $derived(confirmState?.key === entry.key ? confirmState.action : '');
  const summaryLabelKey = $derived(
    row.isFollowUp ? 'account_consultations.follow_up_note_label' : 'account_consultations.summary_label',
  );
  // On the timeline the summary stays in view (it's what the meeting is about); everywhere
  // else, what the member wrote waits behind "Show request details".
  const summaryShown = $derived(section === 'upcoming' && Boolean(row.requestSummary));
  const hasDetails = $derived(Boolean(row.timeSlots) || (Boolean(row.requestSummary) && !summaryShown));
  // Who it's with: the member for the mentor, the mentor (when they have an email) for the
  // member. A deleted member's rows stay in the records without their email.
  const otherEmail = $derived(row.role === 'expert' ? row.memberEmail : row.expertEmail);
  const withText = $derived(
    otherEmail
      ? $t('account_agenda.with_member', { email: otherEmail })
      : row.role === 'expert'
        ? $t('account_consultations.member_deleted')
        : '',
  );
  const when = $derived(
    section === 'upcoming'
      ? formatMeetingClock(row.meetingAt, $locale)
      : row.status === 'reserved' && row.meetingAt
        ? formatMeetingTime(row.meetingAt, $locale)
        : $t('account_consultations.requested_on', { date: formatDateKey(row.requestedOn, $locale) }),
  );
  const metaRest = $derived(
    [
      withText,
      section === 'upcoming' && row.zoomJoinUrl && row.zoomPassword
        ? $t('account_consultations.passcode', { code: row.zoomPassword })
        : '',
      row.status === 'cancelled' && row.cancelledBy ? $t(`account_consultations.cancelled_by_${row.cancelledBy}`) : '',
    ].filter(Boolean),
  );
  // The Lavender strip at the card's foot: what happens next, when there's something to say.
  const stripText = $derived(
    section === 'waiting'
      ? $t('account_consultations.pending_member_hint')
      : section === 'upcoming' && !row.zoomJoinUrl
        ? $t('account_consultations.no_zoom_link')
        : '',
  );
  const menuItems = $derived(
    entry.tools.map((tool) => ({
      id: tool,
      label: $t(toolLabelKey(tool, row)),
      danger: TOOL_KINDS[tool] === 'confirm',
      onselect: () => chooseTool(tool),
    })),
  );

  // The page focuses this title after an action that keeps the consultation listed. A card
  // that moves to another section registers the same key again from its new place, so the old
  // one never unregisters.
  $effect(() => {
    if (titleLink) {
      registerTitle?.(entry.key, titleLink);
    }
  });

  function isBusy(kind) {
    return busyKey === entry.key && running === kind;
  }

  /** F8's status line: what happened, then who was emailed when that's known to be true. */
  function statusLine(key, vars = {}, toldKey = '') {
    return toldKey ? `${$t(key, vars)} ${$t(toldKey)}` : $t(key, vars);
  }

  function clearError() {
    actionError = '';
    actionErrorKind = '';
  }

  // Only this card's menu closes here: another card's menu can open right after this one closes.
  function toggleMenu(open) {
    if (open) {
      setOpenMenu?.(entry.key);
    } else if (openMenuKey === entry.key) {
      setOpenMenu?.(null);
    }
  }

  /** A More item: a tool opens its panel in the card; Cancel (Withdraw, Decline) asks first. */
  function chooseTool(tool) {
    if (TOOL_KINDS[tool] === 'confirm') {
      askCancel();
    } else {
      showTool(tool);
    }
  }

  async function showTool(tool) {
    setConfirm?.(null);
    setOpenPanel?.({ key: entry.key, tool });
    clearError();

    // Starts from the current time, so a small move is a small change.
    if (tool === 'reschedule' && !rescheduleTimes[row.id] && row.meetingAt) {
      rescheduleTimes[row.id] = toLocalInputValue(row.meetingAt);
    }

    await tick();
    (tool === 'reschedule' ? reschedulePicker : tool === 'follow-up' ? followUpPicker : messageForm)?.focus();
  }

  /** Closes this card's panel (sent, cancelled or hidden) and puts focus back on More. */
  async function closeTool() {
    if (openPanel?.key === entry.key) {
      setOpenPanel?.(null);
    }
    if (confirmState?.key === entry.key) {
      setConfirm?.(null);
    }
    await tick();
    moreMenu?.focusTrigger();
  }

  /** What asked a question: Keep it and a failed request put focus back there. */
  function focusAsker(action) {
    if (action === 'cancel') {
      moreMenu?.focusTrigger();
    } else {
      ({ schedule: scheduleButton, reschedule: rescheduleButton, 'follow-up': followUpButton })[action]?.focus();
    }
  }

  async function keep(action) {
    setConfirm?.(null);
    await tick();
    focusAsker(action);
  }

  function handleMessageBusy(isSending) {
    running = isSending ? 'message' : '';
    setBusy?.(isSending ? entry.key : null);
    if (isSending) {
      announce?.('');
    }
  }

  function handleMessageSent(tool) {
    announce?.($t(MESSAGE_TOOLS[tool].status));
    notify({ textKey: MESSAGE_TOOLS[tool].kimchi }, DEFAULT_NOTIFICATION_DURATION);
    closeTool();
  }

  function askSchedule() {
    if (busyKey) {
      return;
    }

    const parsed = parseMeetingTimeInput(meetingTimes[row.id]);
    // iOS doesn't enforce min in its picker, so check for a past time here, before the question.
    const timeError = meetingTimeErrorKey(parsed, Date.now());
    meetingTimeErrors[row.id] = timeError ? $t(timeError) : '';
    if (timeError) {
      meetingPicker?.focus();
      return;
    }

    clearError();
    questionMeetingAt = parsed.toISOString();
    setConfirm?.({ key: entry.key, action: 'schedule' });
  }

  async function handleSchedule() {
    if (busyKey) {
      return;
    }

    const { key } = entry;
    const { id, role } = row;
    const meetingAt = questionMeetingAt;
    running = 'schedule';
    setBusy?.(key);
    clearError();
    announce?.('');
    let failed = false;

    try {
      const { consultation, emailSent } = await scheduleConsultation(id, meetingAt, scheduleMessages[id] ?? '');
      scheduleMessages[id] = '';
      setConfirm?.(null);
      replaceConsultation?.(consultation, role);
      rememberStatuses?.();
      // Only claim the invitations went out when the server didn't say otherwise.
      const emailed = emailSent !== false;
      announce?.(
        statusLine(
          'account_consultations.scheduled_status',
          { time: formatMeetingTime(meetingAt, $locale) },
          emailed && 'account_consultations.invitations_sent_status',
        ),
      );
      notify(
        { textKey: emailed ? 'kimchi.consultation_scheduled' : 'kimchi.consultation_scheduled_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      setConfirm?.(null);
      actionErrorKind = 'schedule';
      actionError = error.message || $t('account_consultations.schedule_error');
    } finally {
      running = '';
      setBusy?.(null);
    }

    // On success the meeting moves to the timeline, so focus its title there; on failure, Schedule.
    await tick();
    if (failed) {
      scheduleButton?.focus();
    } else {
      focusAfter?.(key);
    }
  }

  function askCancel() {
    if (busyKey) {
      return;
    }

    clearError();
    if (openPanel?.key === entry.key) {
      setOpenPanel?.(null);
    }
    setConfirm?.({ key: entry.key, action: 'cancel' });
  }

  async function handleCancel() {
    if (busyKey) {
      return;
    }

    const { key } = entry;
    const { id, role, itemTitle } = row;
    const feedback = cancelFeedbackFor(row);
    running = 'cancel';
    setBusy?.(key);
    clearError();
    announce?.('');
    let failed = false;

    try {
      const result = await cancelConsultation(id);
      setConfirm?.(null);
      replaceConsultation?.(result.consultation, role);
      rememberStatuses?.();
      const told = otherSideTold(role, result);
      announce?.(statusLine(feedback.status, {}, told && feedback.toldStatus));
      notify(
        { textKey: told ? feedback.told : feedback.plain, vars: { title: itemTitle } },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      setConfirm?.(null);
      actionErrorKind = 'cancel';
      actionError = error.message || $t('account_consultations.cancel_error');
    } finally {
      running = '';
      setBusy?.(null);
    }

    // On success the consultation moved to Earlier, so focus its toggle; on failure, More.
    await tick();
    if (failed) {
      moreMenu?.focusTrigger();
    } else {
      focusAfter?.('earlier');
    }
  }

  function askReschedule() {
    if (busyKey) {
      return;
    }

    const parsed = parseMeetingTimeInput(rescheduleTimes[row.id]);
    // The picker has minutes, so the same minute as now is no change.
    const timeError = meetingTimeErrorKey(parsed, Date.now(), row.meetingAt ?? '');
    rescheduleTimeErrors[row.id] = timeError ? $t(timeError) : '';
    if (timeError) {
      reschedulePicker?.focus();
      return;
    }

    clearError();
    questionMeetingAt = parsed.toISOString();
    setConfirm?.({ key: entry.key, action: 'reschedule' });
  }

  async function handleReschedule() {
    if (busyKey) {
      return;
    }

    const { key } = entry;
    const { id, role } = row;
    const meetingAt = questionMeetingAt;
    running = 'reschedule';
    setBusy?.(key);
    clearError();
    announce?.('');
    let failed = false;

    try {
      const { consultation, emailSent } = await rescheduleConsultation(id, meetingAt, rescheduleMessages[id] ?? '');
      setConfirm?.(null);
      replaceConsultation?.(consultation, role);
      setOpenPanel?.(null);
      rescheduleTimes[id] = '';
      rescheduleMessages[id] = '';
      const emailed = emailSent !== false;
      announce?.(
        statusLine(
          'account_consultations.rescheduled_status',
          { time: formatMeetingTime(meetingAt, $locale) },
          emailed && 'account_consultations.rescheduled_emailed_status',
        ),
      );
      notify(
        { textKey: emailed ? 'kimchi.consultation_rescheduled' : 'kimchi.consultation_rescheduled_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      failed = true;
      setConfirm?.(null);
      actionErrorKind = 'reschedule';
      actionError = error.message || $t('account_consultations.reschedule_error');
    } finally {
      running = '';
      setBusy?.(null);
    }

    // On success the panel closes (the card may move to another day), so focus the title; on
    // failure, Move meeting.
    await tick();
    if (failed) {
      rescheduleButton?.focus();
    } else {
      focusAfter?.(key);
    }
  }

  function askFollowUp() {
    if (busyKey) {
      return;
    }

    const parsed = parseMeetingTimeInput(followUpTimes[row.id]);
    const timeError = meetingTimeErrorKey(parsed, Date.now());
    followUpTimeErrors[row.id] = timeError ? $t(timeError) : '';
    if (timeError) {
      followUpPicker?.focus();
      return;
    }

    clearError();
    questionMeetingAt = parsed.toISOString();
    setConfirm?.({ key: entry.key, action: 'follow-up' });
  }

  async function handleFollowUp() {
    if (busyKey) {
      return;
    }

    const { key } = entry;
    const { id } = row;
    const meetingAt = questionMeetingAt;
    running = 'follow-up';
    setBusy?.(key);
    clearError();
    announce?.('');
    let bookedKey = '';

    try {
      const { consultation, emailSent } = await bookFollowUpConsultation(id, meetingAt, followUpNotes[id] ?? '');
      const booked = { ...consultation, role: 'expert' };
      setConfirm?.(null);
      appendConsultation?.(booked);
      bookedKey = `con:${rowKey(booked)}`;
      rememberStatuses?.();
      setOpenPanel?.(null);
      followUpTimes[id] = '';
      followUpNotes[id] = '';
      const emailed = emailSent !== false;
      announce?.(
        statusLine(
          'account_consultations.follow_up_booked_status',
          { time: formatMeetingTime(meetingAt, $locale) },
          emailed && 'account_consultations.invitations_sent_status',
        ),
      );
      notify(
        { textKey: emailed ? 'kimchi.follow_up_booked' : 'kimchi.follow_up_booked_plain' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      setConfirm?.(null);
      actionErrorKind = 'follow-up';
      actionError = error.message || $t('account_consultations.follow_up_error');
    } finally {
      running = '';
      setBusy?.(null);
    }

    // On success the form closes, so focus the new meeting on the timeline; on failure, Book.
    await tick();
    if (bookedKey) {
      focusAfter?.(bookedKey);
    } else {
      followUpButton?.focus();
    }
  }

  /** Cancel's question, worded like its Yes: withdraw (member) or decline (mentor) a pending request, else cancel the meeting. */
  function cancelQuestion(vars) {
    if (row.status === 'pending') {
      if (row.role === 'member') {
        return $t('account_agenda.withdraw_request_confirm', { title: vars.title });
      }
      return vars.email
        ? $t('account_agenda.decline_request_confirm', { title: vars.title, email: vars.email })
        : $t('account_agenda.decline_request_confirm_no_email', { title: vars.title });
    }
    return row.role === 'expert'
      ? $t('account_consultations.cancel_confirm_expert', { title: vars.title, email: vars.email })
      : $t('account_consultations.cancel_confirm_member', { title: vars.title });
  }

  /** The open question's words and buttons: the same *_confirm strings window.confirm asked. */
  function questionFor(action) {
    const vars = {
      title: row.itemTitle,
      email: row.memberEmail ?? '',
      time: formatMeetingTime(questionMeetingAt, $locale),
    };

    if (action === 'cancel') {
      const labels = cancelLabelKeys(row);
      return {
        message: cancelQuestion(vars),
        confirmLabel: $t(labels.label),
        busyLabel: $t(labels.busyLabel),
        tone: 'danger',
        onconfirm: handleCancel,
      };
    }
    if (action === 'reschedule') {
      return {
        message: $t('account_consultations.reschedule_confirm', vars),
        confirmLabel: $t('account_consultations.reschedule'),
        busyLabel: $t('account_consultations.rescheduling'),
        tone: 'primary',
        onconfirm: handleReschedule,
      };
    }
    if (action === 'follow-up') {
      return {
        message: $t('account_consultations.follow_up_confirm', vars),
        confirmLabel: $t('account_consultations.follow_up_book'),
        busyLabel: $t('account_consultations.follow_up_booking'),
        tone: 'primary',
        onconfirm: handleFollowUp,
      };
    }
    return {
      message: $t('account_consultations.schedule_confirm', vars),
      confirmLabel: $t('account_consultations.schedule'),
      busyLabel: $t('account_consultations.scheduling'),
      tone: 'primary',
      onconfirm: handleSchedule,
    };
  }

  function openItem(event) {
    event.preventDefault();
    navigate(row.itemPath);
  }
</script>

{#snippet ask(action)}
  {@const words = questionFor(action)}
  <InlineConfirm
    id="{cardId}-confirm"
    message={words.message}
    confirmLabel={words.confirmLabel}
    busyLabel={words.busyLabel}
    busy={isBusy(action)}
    tone={words.tone}
    onconfirm={words.onconfirm}
    oncancel={() => keep(action)}
  />
{/snippet}

{#snippet more()}
  {#if entry.tools.length > 0}
    <MoreMenu
      bind:this={moreMenu}
      id="{cardId}-more"
      label={$t('account_agenda.more')}
      ariaLabel={$t('account_agenda.more_aria', { title: entry.title })}
      items={menuItems}
      open={openMenuKey === entry.key}
      ontoggle={toggleMenu}
      disabled={busy}
    />
  {/if}
{/snippet}

{#snippet field(labelKey, value)}
  <div class="consultation-field">
    <span class="consultation-field__label">{$t(labelKey)}</span>
    <span class="consultation-field__value">{value}</span>
  </div>
{/snippet}

{#snippet cardError()}
  {#if actionError && (actionErrorKind === 'schedule' || actionErrorKind === 'cancel')}
    <p class="admin-status admin-status-error agenda-entry__error" role="alert">{actionError}</p>
  {/if}
{/snippet}

{#snippet panelError(kind)}
  {#if actionError && actionErrorKind === kind}
    <p class="admin-status admin-status-error" role="alert">{actionError}</p>
  {/if}
{/snippet}

{#snippet panels(extraClass)}
  {@const asking = question === 'cancel' && entry.tools.includes('cancel')}
  {#if activeTool || asking}
    <div class="agenda-entry__panel {extraClass}">
      {#if asking}
        {@render ask('cancel')}
      {:else if MESSAGE_TOOLS[activeTool]}
        <ReservationMessageForm
          bind:this={messageForm}
          reservationId={row.id}
          kind={MESSAGE_TOOLS[activeTool].kind}
          as={MESSAGE_TOOLS[activeTool].as}
          idPrefix={toolPanelId(row, activeTool)}
          label={$t(MESSAGE_TOOLS[activeTool].label)}
          hint={$t(MESSAGE_TOOLS[activeTool].hint)}
          placeholder={MESSAGE_TOOLS[activeTool].placeholder ? $t(MESSAGE_TOOLS[activeTool].placeholder) : ''}
          disabled={busy}
          onbusy={handleMessageBusy}
          onsent={() => handleMessageSent(activeTool)}
          oncancel={closeTool}
        />
      {:else if activeTool === 'reschedule'}
        <div id={toolPanelId(row, 'reschedule')} class="consultation-follow-up">
          <p class="admin-consultation-detail">{$t('account_consultations.reschedule_intro')}</p>
          <MeetingTimePicker
            bind:this={reschedulePicker}
            bind:value={rescheduleTimes[row.id]}
            bind:error={rescheduleTimeErrors[row.id]}
            label={$t('account_consultations.reschedule_time_label')}
            hint={$t('account_consultations.meeting_time_hint')}
          />
          {#if row.memberEmail}
            <ConfirmationMessage
              bind:value={rescheduleMessages[row.id]}
              label={$t('account_consultations.reschedule_message_label')}
            />
          {/if}
          {#if question === 'reschedule'}
            {@render ask('reschedule')}
          {:else}
            <div class="agenda-entry__actions agenda-entry__actions--start">
              <button
                bind:this={rescheduleButton}
                type="button"
                class="action-btn action-btn--primary"
                disabled={busy}
                onclick={askReschedule}
              >
                {$t('account_consultations.reschedule')}
              </button>
              <button type="button" class="action-btn" disabled={busy} onclick={closeTool}>
                {$t('account_consultations.reschedule_close')}
              </button>
            </div>
          {/if}
          {@render panelError('reschedule')}
        </div>
      {:else if activeTool === 'follow-up'}
        <div id={toolPanelId(row, 'follow-up')} class="consultation-follow-up">
          <p class="admin-consultation-detail">
            {$t('account_consultations.follow_up_intro', { email: row.memberEmail ?? '' })}
          </p>
          <MeetingTimePicker
            bind:this={followUpPicker}
            bind:value={followUpTimes[row.id]}
            bind:error={followUpTimeErrors[row.id]}
            label={$t('account_consultations.meeting_time_label')}
            hint={$t('account_consultations.meeting_time_hint')}
          />
          <label class="consultation-field__label" for="consultation-follow-up-note-{row.id}">
            {$t('account_consultations.follow_up_note_input_label')}
          </label>
          <textarea
            id="consultation-follow-up-note-{row.id}"
            class="consultation-follow-up__note"
            rows="3"
            maxlength={FOLLOW_UP_NOTE_MAX}
            bind:value={followUpNotes[row.id]}
          ></textarea>
          {#if question === 'follow-up'}
            {@render ask('follow-up')}
          {:else}
            <div class="agenda-entry__actions agenda-entry__actions--start">
              <button
                bind:this={followUpButton}
                type="button"
                class="action-btn action-btn--primary"
                disabled={busy}
                onclick={askFollowUp}
              >
                {$t('account_consultations.follow_up_book')}
              </button>
              <button type="button" class="action-btn" disabled={busy} onclick={closeTool}>
                {$t('account_consultations.follow_up_close')}
              </button>
            </div>
          {/if}
          {@render panelError('follow-up')}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#if section === 'needsYou'}
  <!-- A mentor's request: their words on the left, the time to pick on the right. -->
  <article id={cardId} class="agenda-entry agenda-entry--consultation f-card needs-you" aria-labelledby={titleId}>
    <div class="needs-you__band">
      <svelte:element this={`h${headingLevel}`} id={titleId} class="needs-you__title">
        {row.memberEmail
          ? $t('account_agenda.pick_time_for', { email: row.memberEmail })
          : $t('account_agenda.pick_time_for_request')}
      </svelte:element>
      <p class="needs-you__meta">
        {#if row.isFollowUp}
          <span class="consultation-status consultation-status--follow-up">
            {$t('account_consultations.follow_up_badge')}
          </span>
        {/if}
        <span>{$t('account_consultations.requested_on', { date: formatDateKey(row.requestedOn, $locale) })}</span>
        <span aria-hidden="true">·</span>
        <a bind:this={titleLink} href={row.itemPath} onclick={openItem}>{row.itemTitle}</a>
      </p>
    </div>

    <div class="needs-you__body">
      <div class="needs-you__words">
        {#if row.timeSlots}
          {@render field('account_consultations.slots_label', row.timeSlots)}
        {/if}
        {#if row.requestSummary}
          {@render field(summaryLabelKey, row.requestSummary)}
        {/if}
      </div>

      <div class="needs-you__form">
        <MeetingTimePicker
          bind:this={meetingPicker}
          bind:value={meetingTimes[row.id]}
          bind:error={meetingTimeErrors[row.id]}
          label={$t('account_consultations.meeting_time_label')}
          hint={$t('account_consultations.meeting_time_hint')}
        />
        {#if row.memberEmail}
          <ConfirmationMessage
            bind:value={scheduleMessages[row.id]}
            label={$t('account_consultations.schedule_message_label')}
            hint={$t('account_consultations.schedule_message_hint')}
          />
        {/if}
        {#if question === 'schedule'}
          {@render ask('schedule')}
        {:else}
          <div class="agenda-entry__actions agenda-entry__actions--start">
            <button
              bind:this={scheduleButton}
              type="button"
              class="action-btn action-btn--primary"
              disabled={busy}
              onclick={askSchedule}
            >
              {$t('account_consultations.schedule')}
            </button>
            {@render more()}
          </div>
        {/if}
        {@render cardError()}
      </div>

      {@render panels('needs-you__panel')}
    </div>
  </article>
{:else}
  <article
    id={cardId}
    class="agenda-entry agenda-entry--consultation f-card"
    class:agenda-entry--past={past}
    aria-labelledby={titleId}
  >
    <div class="agenda-entry__top">
      <div class="agenda-entry__main">
        <p class="agenda-entry__meta">
          {#if sticker}
            <span class="consultation-status consultation-status--{sticker.modifier}">{$t(sticker.labelKey)}</span>
          {/if}
          {#if timingSticker}
            <!-- B6: Kimchi's "starting soon" nudge, kept on the card for when she's asleep. -->
            <span class="consultation-status consultation-status--{timingSticker.modifier}">
              {$t(timingSticker.labelKey, timingSticker.vars)}
            </span>
          {/if}
          {#if row.isFollowUp}
            <span class="consultation-status consultation-status--follow-up">
              {$t('account_consultations.follow_up_badge')}
            </span>
          {/if}
          <span class="agenda-entry__meta-text">
            <strong class="agenda-entry__when">{when}</strong>{#each metaRest as part (part)}<span aria-hidden="true"
                >{'\u00a0·'}</span
              >{' '}{part}{/each}
          </span>
        </p>
        <svelte:element this={`h${headingLevel}`} id={titleId} class="agenda-entry__title">
          <a bind:this={titleLink} href={row.itemPath} onclick={openItem}>{row.itemTitle}</a>
        </svelte:element>
      </div>

      {#if entry.primary === 'join' || entry.tools.length > 0}
        <div class="agenda-entry__actions">
          {#if entry.primary === 'join'}
            <a class="action-btn action-btn--primary" href={row.zoomJoinUrl} target="_blank" rel="noopener noreferrer">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.25"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <rect x="2.5" y="6" width="13" height="12" rx="2" />
                <path d="M15.5 10.5l6-3.5v10l-6-3.5z" />
              </svg>
              <span>
                {$t('account_consultations.join_zoom')}
                <span class="visually-hidden">{$t('account_agenda.join_zoom_context', { title: row.itemTitle })}</span>
              </span>
            </a>
          {/if}
          {@render more()}
        </div>
      {/if}
    </div>

    {#if summaryShown || hasDetails}
      <div class="agenda-entry__body">
        {#if summaryShown}
          {@render field(summaryLabelKey, row.requestSummary)}
        {/if}
        {#if hasDetails}
          <button
            type="button"
            class="f-disclosure f-disclosure--sm"
            aria-expanded={detailsOpen}
            aria-controls="{cardId}-details"
            onclick={() => (detailsOpen = !detailsOpen)}
          >
            <svg class="f-disclosure__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3.5 12h17" />
              <path class="f-disclosure__stem" d="M12 3.5v17" />
            </svg>
            <span class="f-disclosure__text">
              {$t(detailsOpen ? 'account_agenda.request_details_hide' : 'account_agenda.request_details_show')}
            </span>
          </button>
          <div id="{cardId}-details" class="agenda-entry__details" hidden={!detailsOpen}>
            {#if row.timeSlots}
              {@render field('account_consultations.slots_label', row.timeSlots)}
            {/if}
            {#if row.requestSummary && !summaryShown}
              {@render field(summaryLabelKey, row.requestSummary)}
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {@render cardError()}
    {@render panels('')}

    {#if stripText}
      <p class="f-strip f-strip--in-card agenda-entry__strip">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
          <path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
        </svg>
        <span>{stripText}</span>
      </p>
    {/if}
  </article>
{/if}
