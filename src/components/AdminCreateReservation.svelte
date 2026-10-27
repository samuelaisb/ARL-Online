<script>
  import { onMount, tick } from 'svelte';
  import { trackBookingRequestSent } from '../lib/analytics.js';
  import { createStaffReservation, fetchAdminUsers } from '../lib/inventory.js';
  import { compareDateKeys, getBlockingReservations, libraryTodayKey, parseDateKey } from '../lib/calendar.js';
  import { CONFIRMATION_MESSAGE_MAX } from '../lib/expertise-fields.js';
  import { addDays, getBlockEndDate, isConsultationHeld, isFixedBlockTag } from '../lib/reservation-rules.js';
  import { locale, t } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import BusyLabel from './BusyLabel.svelte';
  import { parseMeetingTimeInput, toLocalInputValue } from './MeetingTimePicker.svelte';
  import Skeleton from './Skeleton.svelte';

  // `items`: AdminPanel's admin inventory (reservations carry their emails). `oncreated(itemId,
  // result)` folds the new booking into it, so the booked list below updates at once.
  let {
    items = [],
    loading = false,
    hasLoaded = false,
    loadError = '',
    todayKey = libraryTodayKey(),
    now = Date.now(),
    oncreated,
  } = $props();

  // Mentors (expertise) come last: they take a meeting time instead of dates.
  const TAGS = ['equipment', 'books', 'rooms', 'expertise'];
  // STAFF_RESERVATION_MAX_DAYS in server.js.
  const MAX_DAYS = 366;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // CONSULTATION_SUMMARY_MAX in server.js, as in the member's consultation form.
  const SUMMARY_MAX = 2000;
  // Same check as the server's isValidEmailAddress.
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // As in AdminPanel: Kimchi bubbles that say more than a short line (mentor without email).
  const LONG_NOTIFICATION_DURATION = 9000;

  let itemId = $state('');
  let email = $state('');
  let startDate = $state('');
  let endDate = $state('');
  // Until staff pick an end date themselves, it follows the start date (the item's usual block).
  let endTouched = false;
  // A mentor's meeting: the datetime-local value (device time zone) and what it's about.
  let meetingTime = $state('');
  let summary = $state('');
  let message = $state('');
  let submitting = $state(false);
  // `open`: the address already has an open consultation with the picked mentor.
  let errors = $state({ item: '', email: '', open: '', dates: '', meeting: '' });
  let formError = $state('');
  let doneMessage = $state('');
  // Accounts for the email suggestions and the member hint; empty if they didn't load.
  let users = $state([]);

  let itemSelect = $state();
  let emailInput = $state();
  let startInput = $state();
  let meetingInput = $state();

  const groups = $derived(
    TAGS.map((tag) => ({
      tag,
      items: items
        .filter((item) => item.tag === tag)
        .sort((a, b) => a.title.localeCompare(b.title, $locale === 'fr' ? 'fr-CA' : 'en-CA')),
    })).filter((group) => group.items.length > 0),
  );

  const selectedItem = $derived(items.find((item) => item.id === itemId) ?? null);
  const isConsultation = $derived(selectedItem?.tag === 'expertise');
  // Only the member is emailed; staff send the mentor the Zoom link, as when approving.
  const mentorEmailMissing = $derived(isConsultation && !selectedItem.expertEmail);

  // Pending requests block dates too, as on the server.
  const booked = $derived(
    selectedItem && !isConsultation
      ? getBlockingReservations(selectedItem.reservations ?? [])
          .filter((entry) => compareDateKeys(entry.endDate, todayKey) >= 0)
          .sort((a, b) => compareDateKeys(a.startDate, b.startDate))
      : [],
  );

  // A mentor has no dates to clash, so staff see their diary instead: meetings not held yet (by
  // time), then requests waiting for one.
  const mentorEntries = $derived(
    isConsultation
      ? [
          ...(selectedItem.reservations ?? [])
            .filter((entry) => entry.status === 'reserved' && !isConsultationHeld(entry, now))
            .sort((a, b) => Date.parse(a.meetingAt ?? '') - Date.parse(b.meetingAt ?? '')),
          ...(selectedItem.reservations ?? [])
            .filter((entry) => entry.status === 'pending')
            .sort((a, b) => compareDateKeys(a.startDate, b.startDate)),
        ]
      : [],
  );

  const datesInOrder = $derived(
    Boolean(parseDateKey(startDate) && parseDateKey(endDate)) && compareDateKeys(startDate, endDate) <= 0,
  );

  const overlapping = $derived(
    datesInOrder
      ? booked.filter(
          (entry) =>
            compareDateKeys(entry.startDate, endDate) <= 0 && compareDateKeys(startDate, entry.endDate) <= 0,
        )
      : [],
  );

  const normalizedEmail = $derived(email.trim().toLowerCase());
  const matchedUser = $derived(
    normalizedEmail ? (users.find((user) => user.email?.toLowerCase() === normalizedEmail) ?? null) : null,
  );
  const suggestions = $derived(users.filter((user) => user.email && !user.suspended));

  // One open consultation per member and mentor, as on the server.
  const openWithMentor = $derived(
    normalizedEmail ? mentorEntries.filter((entry) => entry.userEmail?.toLowerCase() === normalizedEmail) : [],
  );

  const meetingMin = $derived(toLocalInputValue(now));
  // Keeps Chrome's year segment to 4 digits, as in MeetingTimePicker.
  const meetingMax = $derived(toLocalInputValue(now + MAX_DAYS * DAY_MS));

  const emailHint = $derived.by(() => {
    if (!EMAIL_PATTERN.test(normalizedEmail) || users.length === 0) {
      return $t('admin.create_reservation_email_hint');
    }
    if (!matchedUser || !matchedUser.confirmed) {
      return $t('admin.create_reservation_new_hint');
    }
    return $t('admin.create_reservation_member_hint', { name: matchedUser.name || matchedUser.email });
  });

  const datesHint = $derived(
    selectedItem && isFixedBlockTag(selectedItem.tag)
      ? $t(`admin.create_reservation_dates_hint_${selectedItem.tag}`)
      : $t('admin.create_reservation_dates_hint'),
  );

  onMount(async () => {
    try {
      users = await fetchAdminUsers();
    } catch {
      // Only the suggestions and the member hint are lost; the server still checks the account.
    }
  });

  function formatDateKey(key) {
    const date = parseDateKey(key);
    if (!date) {
      return key ?? '';
    }

    const localeCode = $locale === 'fr' ? 'fr-CA' : 'en-CA';
    return new Intl.DateTimeFormat(localeCode, { dateStyle: 'medium' }).format(date);
  }

  function formatRange(start, end) {
    return start === end
      ? formatDateKey(start)
      : $t('admin.reservation_dates', { start: formatDateKey(start), end: formatDateKey(end) });
  }

  function formatMeetingTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value ?? '';
    }

    const localeCode = $locale === 'fr' ? 'fr-CA' : 'en-CA';
    return new Intl.DateTimeFormat(localeCode, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  /** The end date the item's usual block gives (a one-day booking for rooms). */
  function suggestedEnd(start) {
    if (!parseDateKey(start)) {
      return '';
    }
    return selectedItem && isFixedBlockTag(selectedItem.tag) ? getBlockEndDate(selectedItem.tag, start) : start;
  }

  function handleItemChange(event) {
    itemId = event.target.value;
    errors.item = '';
    errors.open = '';
    errors.dates = '';
    errors.meeting = '';
    if (!endTouched && startDate) {
      endDate = suggestedEnd(startDate);
    }
  }

  function handleStartChange(event) {
    startDate = event.target.value;
    errors.dates = '';
    if (!endTouched || !endDate || compareDateKeys(endDate, startDate) < 0) {
      endTouched = false;
      endDate = suggestedEnd(startDate);
    }
  }

  function handleEndChange(event) {
    endDate = event.target.value;
    endTouched = Boolean(endDate);
    errors.dates = '';
  }

  // Both events, as in MeetingTimePicker: some mobile pickers only fire change.
  function handleMeetingInput(event) {
    meetingTime = event.target.value;
    errors.meeting = '';
  }

  function validate() {
    const next = { item: '', email: '', open: '', dates: '', meeting: '' };

    if (!selectedItem) {
      next.item = $t('admin.create_reservation_item_required');
    }

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      next.email = $t('admin.create_reservation_email_invalid');
    } else if (matchedUser?.suspended) {
      next.email = $t('admin.create_reservation_suspended');
    } else if (openWithMentor.length > 0) {
      next.open = $t('admin.create_reservation_consultation_open');
    }

    if (isConsultation) {
      // Browsers don't enforce min in every picker (iOS), so a past time is caught here.
      const meeting = parseMeetingTimeInput(meetingTime);
      if (!meeting) {
        next.meeting = $t('admin.create_reservation_meeting_required');
      } else if (meeting.getTime() <= Date.now()) {
        next.meeting = $t('admin.meeting_time_past');
      }
    } else if (!startDate || !endDate) {
      next.dates = $t('admin.create_reservation_dates_required');
    } else if (!datesInOrder) {
      next.dates = $t('admin.create_reservation_dates_invalid');
    } else if (compareDateKeys(endDate, todayKey) < 0) {
      next.dates = $t('admin.create_reservation_dates_past');
    } else if (compareDateKeys(endDate, addDays(startDate, MAX_DAYS - 1)) > 0) {
      next.dates = $t('admin.create_reservation_dates_too_long');
    } else if (overlapping.length > 0) {
      next.dates = $t('admin.create_reservation_collision');
    }

    return next;
  }

  /**
   * A booked consultation, said like approving one in Pending (A3): who was emailed, and for a
   * mentor without an email, that staff send the meeting details (the Zoom link is in Edit
   * Reservations). Without the email claim when the response says an email didn't go out.
   */
  function announceConsultation(item, to, meetingAt, result, noMentorEmail) {
    const zoomJoinUrl = result.reservation?.zoomJoinUrl;
    let doneKey = 'admin.create_consultation_done';
    let bubbleKey = 'kimchi.consultation_scheduled';
    if (result.emailSent === false) {
      doneKey = 'admin.create_consultation_done_no_email';
      bubbleKey = 'kimchi.consultation_scheduled_plain';
    } else if (noMentorEmail) {
      doneKey = 'admin.create_consultation_done_no_expert_email';
      bubbleKey = zoomJoinUrl
        ? 'kimchi.consultation_scheduled_no_expert_email'
        : 'kimchi.consultation_scheduled_no_expert_email_no_zoom';
    }

    const done = $t(doneKey, { title: item.title, time: formatMeetingTime(meetingAt), email: to });
    doneMessage = noMentorEmail && zoomJoinUrl ? `${done} ${$t('admin.status_zoom_link_here')}` : done;
    notify(
      { textKey: bubbleKey },
      noMentorEmail && result.emailSent !== false ? LONG_NOTIFICATION_DURATION : DEFAULT_NOTIFICATION_DURATION,
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    doneMessage = '';
    formError = '';
    errors = validate();

    let firstInvalid = null;
    if (errors.item) {
      firstInvalid = itemSelect;
    } else if (errors.email || errors.open) {
      firstInvalid = emailInput;
    } else if (errors.dates) {
      firstInvalid = startInput;
    } else if (errors.meeting) {
      firstInvalid = meetingInput;
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const item = selectedItem;
    const to = email.trim();
    const consultation = isConsultation;
    const noMentorEmail = mentorEmailMissing;
    const meetingAt = consultation ? parseMeetingTimeInput(meetingTime).toISOString() : '';
    let confirmText;
    if (consultation) {
      confirmText = $t(
        noMentorEmail ? 'admin.create_consultation_confirm_no_expert_email' : 'admin.create_consultation_confirm',
        { title: item.title, time: formatMeetingTime(meetingAt), email: to },
      );
    } else {
      confirmText = $t('admin.create_reservation_confirm', {
        title: item.title,
        dates: formatRange(startDate, endDate),
        email: to,
      });
    }

    if (!window.confirm(confirmText)) {
      return;
    }

    submitting = true;

    try {
      const result = await createStaffReservation(
        item.id,
        consultation ? { email: to, meetingAt, summary, message } : { email: to, startDate, endDate, message },
      );
      // When queued, the server sends GA's event an hour from now, unless the booking was a test.
      if (!result.gaEventQueued) {
        trackBookingRequestSent(item, { bookedByStaff: true });
      }
      oncreated?.(item.id, result);

      if (consultation) {
        announceConsultation(item, to, meetingAt, result, noMentorEmail);
      } else {
        let doneKey = 'admin.create_reservation_done';
        if (result.emailSent === false) {
          doneKey = 'admin.create_reservation_done_no_email';
        } else if (result.hasAccount === false) {
          doneKey = 'admin.create_reservation_done_invited';
        }
        doneMessage = $t(doneKey, { title: item.title, email: to });
        notify(
          { textKey: result.emailSent === false ? 'kimchi.reservation_created_plain' : 'kimchi.reservation_created' },
          DEFAULT_NOTIFICATION_DURATION,
        );
      }

      // The item stays picked, so its booked list shows the new booking.
      email = '';
      startDate = '';
      endDate = '';
      endTouched = false;
      meetingTime = '';
      summary = '';
      message = '';
      await tick();
      emailInput?.focus();
    } catch (error) {
      formError = error.message || $t('admin.create_reservation_error');
    } finally {
      submitting = false;
    }
  }
</script>

<section id="admin-create-reservation" class="admin-create-reservation" aria-labelledby="admin-create-reservation-heading">
  <h3 id="admin-create-reservation-heading" class="admin-subheading admin-create-reservation__heading">
    {$t('admin.create_reservation_heading')}
  </h3>
  <p class="admin-create-reservation__intro">{$t('admin.create_reservation_intro')}</p>

  {#if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {/if}

  {#if loading && !hasLoaded}
    <Skeleton count={3} label={$t('admin.loading')} />
  {:else if hasLoaded && groups.length === 0}
    <p class="empty-state">{$t('admin.create_reservation_no_items')}</p>
  {:else if hasLoaded}
    <form class="admin-create-reservation__form" novalidate onsubmit={handleSubmit}>
      <label for="admin-create-reservation-item">{$t('admin.create_reservation_item_label')}</label>
      <select
        bind:this={itemSelect}
        id="admin-create-reservation-item"
        class="admin-create-reservation__select"
        value={itemId}
        aria-invalid={errors.item ? 'true' : undefined}
        aria-describedby={errors.item ? 'admin-create-reservation-item-error' : undefined}
        onchange={handleItemChange}
      >
        <option value="" disabled>{$t('admin.create_reservation_item_placeholder')}</option>
        {#each groups as group (group.tag)}
          <optgroup label={$t(`add_item.tag_${group.tag}`)}>
            {#each group.items as item (item.id)}
              <option value={item.id}>{item.title}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
      {#if errors.item}
        <p id="admin-create-reservation-item-error" class="admin-create-reservation__error">{errors.item}</p>
      {/if}

      {#if selectedItem}
        <div class="admin-create-reservation__booked">
          {#if isConsultation}
            {#if mentorEmailMissing}
              <p class="admin-create-reservation__mentor-note">
                <span class="consultation-status consultation-status--no-email">{$t('admin.no_mentor_email')}</span>
                {$t('admin.create_reservation_no_mentor_email_hint')}
              </p>
            {/if}
            {#if mentorEntries.length > 0}
              <p class="admin-create-reservation__booked-label">{$t('admin.create_reservation_meetings_label')}</p>
              <ul>
                {#each mentorEntries as entry (entry.id)}
                  <li class:admin-create-reservation__clash={openWithMentor.includes(entry)}>
                    {#if entry.status === 'pending'}
                      {$t('admin.consultation_requested_on', { date: formatDateKey(entry.startDate) })}
                      · {$t('admin.create_reservation_status_pending')}
                    {:else}
                      {formatMeetingTime(entry.meetingAt)} · {$t('admin.create_reservation_status_scheduled')}
                    {/if}
                    {#if entry.userEmail}· {entry.userEmail}{/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="admin-create-reservation__booked-label">{$t('admin.create_reservation_meetings_none')}</p>
            {/if}
          {:else if booked.length > 0}
            <p class="admin-create-reservation__booked-label">{$t('admin.create_reservation_booked_label')}</p>
            <ul>
              {#each booked as entry (entry.id)}
                <li class:admin-create-reservation__clash={overlapping.includes(entry)}>
                  {formatRange(entry.startDate, entry.endDate)}
                  · {$t(entry.status === 'pending' ? 'admin.create_reservation_status_pending' : 'admin.create_reservation_status_reserved')}
                  {#if entry.userEmail}· {entry.userEmail}{/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="admin-create-reservation__booked-label">{$t('admin.create_reservation_booked_none')}</p>
          {/if}
        </div>
      {/if}

      <label for="admin-create-reservation-email">{$t('admin.create_reservation_email_label')}</label>
      <input
        bind:this={emailInput}
        id="admin-create-reservation-email"
        type="email"
        autocomplete="off"
        spellcheck="false"
        list={suggestions.length > 0 ? 'admin-create-reservation-members' : undefined}
        maxlength="254"
        bind:value={email}
        aria-invalid={errors.email || errors.open ? 'true' : undefined}
        aria-describedby="admin-create-reservation-email-hint{errors.email ? ' admin-create-reservation-email-error' : ''}{errors.open ? ' admin-create-reservation-open-error' : ''}"
        oninput={() => {
          errors.email = '';
          errors.open = '';
        }}
      />
      {#if suggestions.length > 0}
        <datalist id="admin-create-reservation-members">
          {#each suggestions as user (user.id)}
            <option value={user.email}>{user.name ?? ''}</option>
          {/each}
        </datalist>
      {/if}
      {#if errors.email}
        <p id="admin-create-reservation-email-error" class="admin-create-reservation__error">{errors.email}</p>
      {/if}
      {#if errors.open}
        <p id="admin-create-reservation-open-error" class="admin-create-reservation__error">{errors.open}</p>
      {/if}
      <p id="admin-create-reservation-email-hint" class="field-hint admin-create-reservation__hint">{emailHint}</p>

      {#if isConsultation}
        <label for="admin-create-reservation-meeting">{$t('admin.meeting_time_label')}</label>
        <input
          bind:this={meetingInput}
          id="admin-create-reservation-meeting"
          class="admin-create-reservation__date admin-create-reservation__meeting"
          type="datetime-local"
          min={meetingMin}
          max={meetingMax}
          value={meetingTime}
          aria-invalid={errors.meeting ? 'true' : undefined}
          aria-describedby="admin-create-reservation-meeting-hint{errors.meeting ? ' admin-create-reservation-meeting-error' : ''}"
          oninput={handleMeetingInput}
          onchange={handleMeetingInput}
        />
        {#if errors.meeting}
          <p id="admin-create-reservation-meeting-error" class="admin-create-reservation__error">{errors.meeting}</p>
        {/if}
        <p id="admin-create-reservation-meeting-hint" class="field-hint admin-create-reservation__hint">
          {$t('admin.meeting_time_hint')}
        </p>

        <label for="admin-create-reservation-summary">{$t('admin.create_reservation_summary_label')}</label>
        <textarea
          id="admin-create-reservation-summary"
          class="admin-create-reservation__message"
          rows="3"
          maxlength={SUMMARY_MAX}
          aria-describedby="admin-create-reservation-summary-hint"
          bind:value={summary}
        ></textarea>
        <p id="admin-create-reservation-summary-hint" class="field-hint">{$t('admin.create_reservation_summary_hint')}</p>
      {:else}
        <div class="admin-create-reservation__dates">
          <div>
            <label for="admin-create-reservation-start">{$t('admin.create_reservation_start_label')}</label>
            <input
              bind:this={startInput}
              id="admin-create-reservation-start"
              class="admin-create-reservation__date"
              type="date"
              min={todayKey}
              value={startDate}
              aria-invalid={errors.dates ? 'true' : undefined}
              aria-describedby="admin-create-reservation-dates-hint{errors.dates ? ' admin-create-reservation-dates-error' : ''}"
              onchange={handleStartChange}
            />
          </div>
          <div>
            <label for="admin-create-reservation-end">{$t('admin.create_reservation_end_label')}</label>
            <input
              id="admin-create-reservation-end"
              class="admin-create-reservation__date"
              type="date"
              min={startDate || todayKey}
              value={endDate}
              aria-invalid={errors.dates ? 'true' : undefined}
              aria-describedby="admin-create-reservation-dates-hint{errors.dates ? ' admin-create-reservation-dates-error' : ''}"
              onchange={handleEndChange}
            />
          </div>
        </div>
        {#if errors.dates}
          <p id="admin-create-reservation-dates-error" class="admin-create-reservation__error">{errors.dates}</p>
        {/if}
        <p id="admin-create-reservation-dates-hint" class="field-hint admin-create-reservation__hint">{datesHint}</p>
      {/if}

      <label for="admin-create-reservation-message">{$t('admin.create_reservation_message_label')}</label>
      <textarea
        id="admin-create-reservation-message"
        class="admin-create-reservation__message"
        rows="3"
        maxlength={CONFIRMATION_MESSAGE_MAX}
        aria-describedby="admin-create-reservation-message-hint"
        bind:value={message}
      ></textarea>
      <p id="admin-create-reservation-message-hint" class="field-hint">
        {$t(isConsultation ? 'admin.create_reservation_message_hint_consultation' : 'admin.create_reservation_message_hint')}
      </p>

      {#if formError}
        <p class="admin-status admin-status-error" role="alert">{formError}</p>
      {/if}

      <div class="admin-mentor-actions">
        <button type="submit" class="btn-primary" disabled={submitting}>
          <BusyLabel
            label={$t(isConsultation ? 'admin.create_consultation_submit' : 'admin.create_reservation_submit')}
            busyLabel={$t(isConsultation ? 'admin.create_consultation_submitting' : 'admin.create_reservation_submitting')}
            busy={submitting}
          />
        </button>
      </div>
    </form>
  {/if}

  <!-- Always in the page, so the result is announced (Kimchi may be asleep). -->
  <p class="admin-status admin-create-reservation__done" role="status">{doneMessage}</p>
</section>
