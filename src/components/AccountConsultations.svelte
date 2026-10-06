<script>
  import { onDestroy, onMount } from 'svelte';
  import {
    cancelConsultation,
    fetchAccountConsultations,
    scheduleConsultation,
  } from '../lib/inventory.js';
  import { navigate } from '../lib/router.js';
  import { isConsultationHeld } from '../lib/reservation-rules.js';
  import { locale, t, translateKey } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import {
    availabilityNow,
    subscribeAvailabilityClock,
    unsubscribeAvailabilityClock,
  } from '../lib/availability-clock.js';
  import MeetingTimePicker, { parseMeetingTimeInput } from './MeetingTimePicker.svelte';

  const STATUS_ORDER = { pending: 0, reserved: 1, cancelled: 2, refused: 3 };

  let loading = $state(true);
  let loadError = $state('');
  let asMember = $state([]);
  let asExpert = $state([]);
  let meetingTimes = $state({});
  let meetingTimeErrors = $state({});
  const meetingPickers = {};
  let actionId = $state('');
  let actionError = $state('');
  let actionErrorId = $state('');
  let showExpertPast = $state(false);
  let showMemberPast = $state(false);

  /** Same held rule as the server, which refuses to cancel a meeting that has already ended. */
  function isEntryClosed(entry, now) {
    return entry.status === 'cancelled' || entry.status === 'refused' || isConsultationHeld(entry, now);
  }

  function splitEntries(entries, now) {
    const active = [];
    const past = [];

    for (const entry of entries) {
      if (isEntryClosed(entry, now)) {
        past.push(entry);
      } else {
        active.push(entry);
      }
    }

    past.sort((a, b) => {
      const aKey = a.meetingAt ?? a.requestedOn ?? '';
      const bKey = b.meetingAt ?? b.requestedOn ?? '';
      return bKey.localeCompare(aKey);
    });

    return { active: sortEntries(active), past };
  }

  function sortEntries(entries) {
    return [...entries].sort((a, b) => {
      const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      if (byStatus !== 0) {
        return byStatus;
      }
      const aKey = a.meetingAt ?? a.requestedOn ?? '';
      const bKey = b.meetingAt ?? b.requestedOn ?? '';
      return a.status === 'reserved' ? aKey.localeCompare(bKey) : bKey.localeCompare(aKey);
    });
  }

  function formatMeetingTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value ?? '';
    }

    // dateStyle + timeZoneName throws in Chrome and Safari and blanks this list.
    return new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  }

  function formatDateKey(dateKey) {
    const [year, month, day] = (dateKey ?? '').split('-').map(Number);
    if (!year || !month || !day) {
      return dateKey ?? '';
    }

    return new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', {
      dateStyle: 'medium',
    }).format(new Date(year, month - 1, day));
  }

  function replaceEntry(updated) {
    const swap = (entries) => entries.map((entry) => (entry.id === updated.id ? { ...entry, ...updated, role: entry.role } : entry));
    asMember = swap(asMember);
    asExpert = swap(asExpert);
  }

  async function load() {
    loading = true;
    loadError = '';

    try {
      const result = await fetchAccountConsultations();
      asMember = result.asMember;
      asExpert = result.asExpert;
    } catch (error) {
      loadError = error.message || $t('account_consultations.load_error');
    } finally {
      loading = false;
    }
  }

  async function handleSchedule(entry) {
    if (actionId) {
      return;
    }

    const parsed = parseMeetingTimeInput(meetingTimes[entry.id]);
    // iOS doesn't enforce min in its picker, so check for a past time here, before the confirm.
    const timeError = !parsed
      ? $t('account_consultations.meeting_time_required')
      : parsed.getTime() <= Date.now()
        ? $t('account_consultations.meeting_time_past')
        : '';

    meetingTimeErrors[entry.id] = timeError;
    if (timeError) {
      meetingPickers[entry.id]?.focus();
      return;
    }

    actionError = '';
    actionErrorId = '';

    const meetingAt = parsed.toISOString();
    const confirmed = window.confirm(
      $t('account_consultations.schedule_confirm', {
        title: entry.itemTitle,
        email: entry.memberEmail ?? '',
        time: formatMeetingTime(meetingAt),
      }),
    );

    if (!confirmed) {
      return;
    }

    actionId = entry.id;
    actionError = '';
    actionErrorId = '';

    try {
      replaceEntry(await scheduleConsultation(entry.id, meetingAt));
      notify(translateKey('kimchi.consultation_scheduled'), DEFAULT_NOTIFICATION_DURATION);
    } catch (error) {
      actionErrorId = `${entry.role}:${entry.id}`;
      actionError = error.message || $t('account_consultations.schedule_error');
    } finally {
      actionId = '';
    }
  }

  async function handleCancel(entry) {
    if (actionId) {
      return;
    }

    const confirmed = window.confirm(
      entry.role === 'expert'
        ? $t('account_consultations.cancel_confirm_expert', {
            title: entry.itemTitle,
            email: entry.memberEmail ?? '',
          })
        : $t('account_consultations.cancel_confirm_member', { title: entry.itemTitle }),
    );

    if (!confirmed) {
      return;
    }

    actionId = entry.id;
    actionError = '';
    actionErrorId = '';

    try {
      replaceEntry(await cancelConsultation(entry.id));
      notify(translateKey('kimchi.consultation_cancelled'), DEFAULT_NOTIFICATION_DURATION);
    } catch (error) {
      actionErrorId = `${entry.role}:${entry.id}`;
      actionError = error.message || $t('account_consultations.cancel_error');
    } finally {
      actionId = '';
    }
  }

  function openPath(event, path) {
    event.preventDefault();
    navigate(path);
  }

  onMount(() => {
    subscribeAvailabilityClock();
    load();
  });

  onDestroy(unsubscribeAvailabilityClock);

  const now = $derived.by(() => Math.max($availabilityNow, Date.now()));
  const memberLists = $derived(splitEntries(asMember, now));
  const expertLists = $derived(splitEntries(asExpert, now));
</script>

{#snippet consultationRow(entry)}
  {@const closed = isEntryClosed(entry, now)}
  {@const statusKey = closed && entry.status === 'reserved' ? 'completed' : entry.status}
  <li class="admin-item-row admin-item-row--pending consultation-row" class:consultation-row--inactive={closed}>
    <div class="admin-reservation-details">
      <span class="consultation-row__heading">
        <a href={entry.itemPath} class="consultation-row__title" onclick={(event) => openPath(event, entry.itemPath)}>
          {entry.itemTitle}
        </a>
        <span class="consultation-status consultation-status--{statusKey}">
          {$t(`account_consultations.status_${statusKey}`)}
        </span>
      </span>

      {#if entry.status === 'reserved' && entry.meetingAt}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.meeting_label')}</span>
          <span class="consultation-field__value">{formatMeetingTime(entry.meetingAt)}</span>
        </span>
        {#if entry.zoomJoinUrl}
          <a class="consultation-row__zoom" href={entry.zoomJoinUrl} target="_blank" rel="noopener noreferrer">
            {$t('account_consultations.join_zoom')}
          </a>
          {#if entry.zoomPassword}
            <span class="admin-consultation-detail">
              {$t('account_consultations.passcode', { code: entry.zoomPassword })}
            </span>
          {/if}
        {:else}
          <span class="admin-consultation-detail">{$t('account_consultations.no_zoom_link')}</span>
        {/if}
      {:else}
        <span class="admin-reservation-dates">
          {$t('account_consultations.requested_on', { date: formatDateKey(entry.requestedOn) })}
        </span>
      {/if}

      {#if entry.role === 'expert' && entry.memberEmail}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.member_label')}</span>
          <span class="consultation-field__value">{entry.memberEmail}</span>
        </span>
      {/if}
      {#if entry.role === 'member' && entry.expertEmail}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.expert_label')}</span>
          <span class="consultation-field__value">{entry.expertEmail}</span>
        </span>
      {/if}
      {#if entry.timeSlots}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.slots_label')}</span>
          <span class="consultation-field__value">{entry.timeSlots}</span>
        </span>
      {/if}
      {#if entry.requestSummary}
        <span class="consultation-field">
          <span class="consultation-field__label">{$t('account_consultations.summary_label')}</span>
          <span class="consultation-field__value">{entry.requestSummary}</span>
        </span>
      {/if}

      {#if entry.status === 'pending' && entry.role === 'member'}
        <span class="admin-consultation-detail">{$t('account_consultations.pending_member_hint')}</span>
      {/if}
      {#if entry.status === 'cancelled' && entry.cancelledBy}
        <span class="admin-consultation-detail">
          {$t(`account_consultations.cancelled_by_${entry.cancelledBy}`)}
        </span>
      {/if}

      {#if entry.status === 'pending' && entry.role === 'expert'}
        <MeetingTimePicker
          bind:this={meetingPickers[entry.id]}
          bind:value={meetingTimes[entry.id]}
          bind:error={meetingTimeErrors[entry.id]}
          label={$t('account_consultations.meeting_time_label')}
          hint={$t('account_consultations.meeting_time_hint')}
        />
      {/if}
    </div>

    {#if !closed}
      <div class="consultation-row__actions">
        <div class="admin-pending-actions">
          {#if entry.status === 'pending' && entry.role === 'expert'}
            <button
              type="button"
              class="btn-approve"
              disabled={Boolean(actionId)}
              onclick={() => handleSchedule(entry)}
            >
              {actionId === entry.id ? $t('account_consultations.scheduling') : $t('account_consultations.schedule')}
            </button>
          {/if}
          <button
            type="button"
            class="btn-remove"
            disabled={Boolean(actionId)}
            onclick={() => handleCancel(entry)}
          >
            {actionId === entry.id ? $t('account_consultations.cancelling') : $t('account_consultations.cancel')}
          </button>
        </div>
        {#if actionError && actionErrorId === `${entry.role}:${entry.id}`}
          <p class="admin-status admin-status-error consultation-row__error" role="alert">{actionError}</p>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

{#snippet pastConsultations(entries, open, listId, toggle)}
  {#if entries.length > 0}
    <div class="consultation-history">
      <button
        type="button"
        class="btn-header btn-header--secondary consultation-history__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onclick={toggle}
      >
        {$t(open ? 'account_consultations.past_hide' : 'account_consultations.past_show')}
        <span class="admin-pending-count">({entries.length})</span>
      </button>
      {#if open}
        <ul id={listId} class="admin-item-list consultation-history__list">
          {#each entries as entry (`past-${entry.role}-${entry.id}`)}
            {@render consultationRow(entry)}
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
{/snippet}

<section class="account-consultations" aria-labelledby="account-consultations-heading">
  <h2 id="account-consultations-heading" class="visually-hidden">{$t('account_consultations.heading')}</h2>

  {#if loading}
    <p class="admin-status" role="status">{$t('account_consultations.loading')}</p>
  {:else if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {:else}
    {#if expertLists.active.length > 0 || expertLists.past.length > 0}
      <h3 class="admin-subheading">{$t('account_consultations.heading_expert')}</h3>
      {#if expertLists.active.length > 0}
        <ul class="admin-item-list">
          {#each expertLists.active as entry (`expert-${entry.id}`)}
            {@render consultationRow(entry)}
          {/each}
        </ul>
      {:else}
        <p class="admin-status">{$t('account_consultations.active_empty')}</p>
      {/if}
      {@render pastConsultations(
        expertLists.past,
        showExpertPast,
        'account-consultations-expert-past',
        () => (showExpertPast = !showExpertPast),
      )}
    {/if}

    <h3 class="admin-subheading">{$t('account_consultations.heading_member')}</h3>
    {#if memberLists.active.length > 0}
      <ul class="admin-item-list">
        {#each memberLists.active as entry (`member-${entry.id}`)}
          {@render consultationRow(entry)}
        {/each}
      </ul>
    {:else if memberLists.past.length === 0}
      <p class="empty-state">
        {$t('account_consultations.member_empty')}
        <a href="/expertise" onclick={(event) => openPath(event, '/expertise')}>
          {$t('account_consultations.browse_expertise')}
        </a>
      </p>
    {:else}
      <p class="admin-status">{$t('account_consultations.active_empty')}</p>
    {/if}
    {@render pastConsultations(
      memberLists.past,
      showMemberPast,
      'account-consultations-member-past',
      () => (showMemberPast = !showMemberPast),
    )}

  {/if}
</section>
