<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    deleteAdminUser,
    fetchAdminUsers,
    sendAdminUserPasswordReset,
    setAdminUserSuspended,
    updateAdminUser,
  } from '../lib/inventory.js';
  import { OAUTH_PROVIDER_NAMES } from '../lib/auth.js';
  import { compareDateKeys, libraryTodayKey, parseDateKey } from '../lib/calendar.js';
  import { EXPERT_NAME_MAX } from '../lib/expertise-fields.js';
  import { isConsultationHeld } from '../lib/reservation-rules.js';
  import { locale, t } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import BusyLabel from './BusyLabel.svelte';
  import Skeleton from './Skeleton.svelte';

  // `items`: AdminPanel's admin inventory. Reservations carry only the member's email, so
  // each member's bookings are joined here by email. `itemsLoaded` stays false until that
  // inventory first lands; until then booking counts are unknown, so Delete (whose confirm
  // states them) waits. `onchanged`: refetch the inventory after a delete cancelled bookings.
  let {
    items = [],
    itemsLoaded = false,
    now = Date.now(),
    todayKey = libraryTodayKey(),
    onchanged,
  } = $props();

  const PAGE_SIZE = 50;
  const LONG_NOTIFICATION_DURATION = 9000;
  // Brand fills that carry Dark text (Mint carries Light); picked from the id so a member
  // keeps their colour. Initials only: the CSP blocks Google and Discord photos.
  const AVATAR_TONES = ['lavender', 'pear', 'mint', 'lemon'];
  const FILTER_LABELS = {
    all: 'admin.users_filter_all',
    active: 'admin.users_filter_active',
    suspended: 'admin.users_filter_suspended',
  };
  const FILTERS = Object.keys(FILTER_LABELS);

  let users = $state([]);
  let loading = $state(true);
  let hasLoaded = $state(false);
  let loadError = $state('');

  let query = $state('');
  let filter = $state('all');
  let visibleCount = $state(PAGE_SIZE);

  let bookingsOpen = $state({});
  let editingId = $state('');
  let editName = $state('');
  let editError = $state('');
  // One action at a time across the list: `{ id, kind: 'save'|'reset'|'suspend'|'delete' }`.
  let actionState = $state(null);
  let rowError = $state({ id: '', message: '' });
  // A delete that stopped half way (user_delete_incomplete): the row stays listed with its
  // error after the refresh, even once it no longer matches the filter (its bookings were
  // cancelled). Cleared by an action on another row or a new search or filter.
  let pinnedId = $state('');
  // Announced even when Kimchi is asleep (its bubbles are the only other confirmation).
  let statusMessage = $state('');

  let rowRefs = $state({});
  let editButtons = $state({});
  let nameInput = $state();
  let heading = $state();

  // Bumped by every in-place change, so a list fetched while one landed is fetched again.
  let editVersion = 0;
  let destroyed = false;

  function emailKey(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
  }

  function displayName(user) {
    return user.name || user.email || '';
  }

  function initials(user) {
    const name = (user.name || '').trim();
    const words = (name ? name.split(/\s+/) : (user.email || '').split('@')[0].split(/[._+-]+/)).filter(
      Boolean,
    );
    const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
    const letters = picked.map((word) => Array.from(word)[0]).join('');
    return letters ? letters.toLocaleUpperCase() : '?';
  }

  function avatarTone(id) {
    let hash = 0;
    for (const char of String(id)) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return AVATAR_TONES[hash % AVATAR_TONES.length];
  }

  /** The rows the server cancels, with emails, when the account is deleted (it also cancels
   *  stale pending requests whose dates have passed, silently, so they don't count here). */
  function isActiveBooking({ item, reservation }) {
    if (item.tag === 'expertise') {
      return (
        reservation.status === 'pending' ||
        (reservation.status === 'reserved' && !isConsultationHeld(reservation, now))
      );
    }
    return (
      (reservation.status === 'pending' || reservation.status === 'reserved') &&
      compareDateKeys(reservation.endDate, todayKey) >= 0
    );
  }

  function newestFirst(a, b) {
    return (
      compareDateKeys(b.reservation.startDate, a.reservation.startDate) ||
      compareDateKeys(b.reservation.meetingAt ?? '', a.reservation.meetingAt ?? '')
    );
  }

  const bookingsByEmail = $derived.by(() => {
    const byEmail = new Map();
    for (const item of items) {
      for (const reservation of item.reservations ?? []) {
        const key = emailKey(reservation.userEmail);
        if (!key || reservation.status === 'available') {
          continue;
        }
        if (!byEmail.has(key)) {
          byEmail.set(key, []);
        }
        byEmail.get(key).push({ item, reservation });
      }
    }
    for (const bookings of byEmail.values()) {
      bookings.sort(newestFirst);
    }
    return byEmail;
  });

  const mentorsByEmail = $derived.by(() => {
    const byEmail = new Map();
    for (const item of items) {
      const key = item.tag === 'expertise' ? emailKey(item.expertEmail) : '';
      if (key && !byEmail.has(key)) {
        byEmail.set(key, item);
      }
    }
    return byEmail;
  });

  const rows = $derived(
    users.map((user) => {
      const key = emailKey(user.email);
      const bookings = (key && bookingsByEmail.get(key)) || [];
      return {
        user,
        bookings,
        activeCount: bookings.filter(isActiveBooking).length,
        mentor: (key && mentorsByEmail.get(key)) || null,
        // Staff and the signed-in admin: the server refuses to suspend or delete them.
        isProtected: Boolean(user.isSelf || user.isAdmin),
      };
    }),
  );

  const searchedRows = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return rows;
    }
    return rows.filter(
      ({ user }) =>
        (user.email ?? '').toLowerCase().includes(needle) ||
        (user.name ?? '').toLowerCase().includes(needle),
    );
  });

  function matchesFilter(row, kind) {
    if (kind === 'active') {
      return row.activeCount > 0;
    }
    if (kind === 'suspended') {
      return row.user.suspended;
    }
    return true;
  }

  // The chips count within the current search, so each one says what its filter would show.
  const filterCounts = $derived(
    Object.fromEntries(
      FILTERS.map((kind) => [kind, searchedRows.filter((row) => matchesFilter(row, kind)).length]),
    ),
  );
  const filteredRows = $derived(
    searchedRows.filter((row) => row.user.id === pinnedId || matchesFilter(row, filter)),
  );
  const visibleRows = $derived(filteredRows.slice(0, visibleCount));

  // The row being edited left the list (search, filter, refetch): drop its form, or every
  // Edit button would stay disabled with nothing on screen to say why.
  $effect(() => {
    if (editingId && !visibleRows.some((row) => row.user.id === editingId)) {
      editingId = '';
      editError = '';
    }
  });

  // One formatter each per locale, shared by every row.
  const localeCode = $derived($locale === 'fr' ? 'fr-CA' : 'en-CA');
  const numberFormat = $derived(new Intl.NumberFormat(localeCode));
  const dayFormat = $derived(new Intl.DateTimeFormat(localeCode, { dateStyle: 'medium' }));
  const meetingFormat = $derived(
    new Intl.DateTimeFormat(localeCode, { dateStyle: 'medium', timeStyle: 'short' }),
  );

  function formatNumber(value) {
    return numberFormat.format(value);
  }

  /** An ISO timestamp (sign-up, last sign-in) as a date; '' when missing. */
  function formatDay(value) {
    const date = new Date(value ?? '');
    if (!value || Number.isNaN(date.getTime())) {
      return '';
    }
    return dayFormat.format(date);
  }

  function formatDateKey(key) {
    const date = parseDateKey(key);
    if (!date) {
      return key ?? '';
    }
    return dayFormat.format(date);
  }

  function formatMeetingTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value ?? '';
    }
    return meetingFormat.format(date);
  }

  function providerLabel(provider) {
    if (!provider || provider === 'email') {
      return $t('admin.users_provider_email');
    }
    return OAUTH_PROVIDER_NAMES[provider] ?? provider;
  }

  /** Joined · Last sign-in · how they log in, each kept whole when the line wraps. */
  function accountFacts(user) {
    const joined = formatDay(user.createdAt);
    const lastSignIn = formatDay(user.lastSignInAt);
    return [
      joined && $t('admin.users_joined', { date: joined }),
      lastSignIn ? $t('admin.users_last_sign_in', { date: lastSignIn }) : $t('admin.users_never_signed_in'),
      providerLabel(user.provider),
    ].filter(Boolean);
  }

  /** The member's own wording from /account: held → Completed, a past loan → Ended. */
  function bookingStatus({ item, reservation }) {
    if (item.tag === 'expertise') {
      const key = isConsultationHeld(reservation, now) ? 'completed' : reservation.status;
      return { key, label: $t(`account_consultations.status_${key}`) };
    }
    const key =
      reservation.status === 'reserved' && compareDateKeys(reservation.endDate, todayKey) < 0
        ? 'ended'
        : reservation.status;
    return { key, label: $t(`account_reservations.status_${key}`) };
  }

  function bookingWhen({ item, reservation }) {
    if (item.tag === 'expertise') {
      return reservation.meetingAt
        ? $t('admin.consultation_meeting', { time: formatMeetingTime(reservation.meetingAt) })
        : $t('admin.consultation_requested_on', { date: formatDateKey(reservation.startDate) });
    }
    const start = formatDateKey(reservation.startDate);
    if (!reservation.endDate || reservation.endDate === reservation.startDate) {
      return start;
    }
    return $t('account_reservations.dates', { start, end: formatDateKey(reservation.endDate) });
  }

  async function load() {
    loading = true;

    try {
      let version;
      let fetched;
      do {
        version = editVersion;
        fetched = await fetchAdminUsers();
      } while (version !== editVersion && !destroyed);
      users = fetched;
      hasLoaded = true;
      loadError = '';
    } catch (error) {
      loadError = error.message || $t('admin.users_load_error');
    } finally {
      loading = false;
    }
  }

  function replaceUser(id, changes) {
    editVersion += 1;
    users = users.map((user) => (user.id === id ? { ...user, ...changes } : user));
  }

  function resetPaging() {
    visibleCount = PAGE_SIZE;
    pinnedId = '';
  }

  function selectFilter(kind) {
    filter = kind;
    resetPaging();
  }

  async function showMore() {
    const firstNew = filteredRows[visibleCount];
    visibleCount += PAGE_SIZE;
    await tick();
    if (firstNew) {
      rowRefs[firstNew.user.id]?.focus();
    }
  }

  function toggleBookings(id) {
    bookingsOpen[id] = !bookingsOpen[id];
  }

  function isBusy(id, kind) {
    return actionState?.id === id && actionState.kind === kind;
  }

  function startAction(id, kind) {
    actionState = { id, kind };
    rowError = { id: '', message: '' };
    statusMessage = '';
    // Acting on the pinned row itself (retry, lift suspension) keeps it in place.
    if (pinnedId !== id) {
      pinnedId = '';
    }
  }

  function indexOfRow(id) {
    return visibleRows.findIndex((row) => row.user.id === id);
  }

  // Focus is only moved if it's still where the action left it (the pressed button, or the
  // page once that button was disabled): an admin who moved on keeps their place.
  function canMoveFocus(trigger) {
    const active = document.activeElement;
    return !active || active === document.body || active === trigger;
  }

  /**
   * After an action, once the DOM has settled: to `target()` (by default the pressed button,
   * disabled while the request ran). If that left the list (the member was deleted, or no
   * longer matches the filter), to the row now in its place, else to the heading.
   */
  async function settleFocus(trigger, index, target = () => trigger) {
    await tick();
    if (!canMoveFocus(trigger)) {
      return;
    }
    const element = target();
    if (element && element !== document.body && element.isConnected) {
      element.focus();
      return;
    }
    const next = visibleRows[Math.min(index, visibleRows.length - 1)];
    (rowRefs[next?.user.id] ?? heading)?.focus();
  }

  async function startEdit(user) {
    if (actionState || editingId) {
      return;
    }

    editingId = user.id;
    editName = user.name ?? '';
    editError = '';
    if (rowError.id === user.id) {
      rowError = { id: '', message: '' };
    }
    await tick();
    nameInput?.focus();
  }

  async function cancelEdit() {
    if (actionState) {
      return;
    }

    const id = editingId;
    editingId = '';
    editError = '';
    await tick();
    editButtons[id]?.focus();
  }

  async function handleSave(event, user) {
    event.preventDefault();
    if (actionState || editingId !== user.id) {
      return;
    }

    const name = editName.trim();
    if (name.length > EXPERT_NAME_MAX) {
      editError = $t('admin.users_name_too_long');
      nameInput?.focus();
      return;
    }
    if (name === (user.name ?? '')) {
      await cancelEdit();
      return;
    }

    const trigger = document.activeElement;
    const index = indexOfRow(user.id);
    startAction(user.id, 'save');
    editError = '';
    let failed = false;

    try {
      const updated = await updateAdminUser(user.id, { name });
      const changes = updated ?? { name: name || null };
      replaceUser(user.id, changes);
      editingId = '';
      // The name the server kept: cleared, it falls back to the Google or Discord name.
      statusMessage = $t('admin.users_saved_status', { name: displayName({ ...user, ...changes }) });
      notify({ textKey: 'kimchi.user_saved' }, DEFAULT_NOTIFICATION_DURATION);
    } catch (error) {
      failed = true;
      editError = error.message || $t('admin.users_save_error');
    } finally {
      actionState = null;
    }

    // Saved: back to the row's Edit button (the form is gone). Failed: to Save, or the field.
    await settleFocus(trigger, index, () => (failed ? trigger : editButtons[user.id]));
  }

  async function handleReset(user) {
    if (actionState) {
      return;
    }

    const trigger = document.activeElement;
    const confirmed = window.confirm($t('admin.users_reset_confirm', { email: user.email }));
    if (!confirmed) {
      return;
    }

    const index = indexOfRow(user.id);
    startAction(user.id, 'reset');

    try {
      const result = await sendAdminUserPasswordReset(user.id);
      // Only a sent email counts: the bubble says the link is on its way.
      if (result?.emailSent !== true) {
        throw new Error($t('admin.users_reset_failed'));
      }
      statusMessage = $t('admin.users_reset_sent_status', { name: displayName(user) });
      notify({ textKey: 'kimchi.user_reset_sent' }, DEFAULT_NOTIFICATION_DURATION);
    } catch (error) {
      rowError = { id: user.id, message: error.message || $t('admin.users_reset_error') };
    } finally {
      actionState = null;
    }

    await settleFocus(trigger, index);
  }

  async function handleSuspend(row) {
    const { user, mentor } = row;
    if (actionState) {
      return;
    }

    const suspend = !user.suspended;
    // The server refuses too (409), as for delete: a suspended mentor's profile would keep
    // taking requests they can't answer. Lifting a suspension is always allowed.
    if (suspend && mentor) {
      statusMessage = '';
      rowError = {
        id: user.id,
        message: $t('admin.users_mentor_error', { email: user.email, title: mentor.title }),
      };
      return;
    }

    const trigger = document.activeElement;
    const confirmed = window.confirm(
      $t(suspend ? 'admin.users_suspend_confirm' : 'admin.users_unsuspend_confirm', { email: user.email }),
    );
    if (!confirmed) {
      return;
    }

    const index = indexOfRow(user.id);
    startAction(user.id, 'suspend');

    try {
      const updated = await setAdminUserSuspended(user.id, suspend);
      replaceUser(user.id, updated ?? { suspended: suspend });
      statusMessage = $t(suspend ? 'admin.users_suspended_status' : 'admin.users_unsuspended_status', {
        name: displayName(user),
      });
      notify(
        { textKey: suspend ? 'kimchi.user_suspended' : 'kimchi.user_unsuspended' },
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      // The server refuses to suspend a mentor (409), as it does to delete one.
      rowError = {
        id: user.id,
        message:
          error.code === 'user_is_mentor' && error.title
            ? $t('admin.users_mentor_error', { email: user.email, title: error.title })
            : error.message || $t('admin.users_suspend_error'),
      };
    } finally {
      actionState = null;
    }

    // The same button flips between Suspend and Lift suspension, so focus stays on it.
    await settleFocus(trigger, index);
  }

  async function handleDelete(row) {
    const { user, mentor, activeCount } = row;
    if (actionState || !itemsLoaded) {
      return;
    }

    // The server refuses too (409): a mentor's public profile would outlive the account.
    if (mentor) {
      statusMessage = '';
      rowError = {
        id: user.id,
        message: $t('admin.users_mentor_error', { email: user.email, title: mentor.title }),
      };
      return;
    }

    const trigger = document.activeElement;
    const confirmed = window.confirm(
      activeCount > 0
        ? $t('admin.users_delete_confirm_active', { email: user.email, count: formatNumber(activeCount) })
        : $t('admin.users_delete_confirm', { email: user.email }),
    );
    if (!confirmed) {
      return;
    }

    const index = indexOfRow(user.id);
    startAction(user.id, 'delete');
    let refreshed = null;

    try {
      const result = await deleteAdminUser(user.id);
      editVersion += 1;
      users = users.filter((candidate) => candidate.id !== user.id);
      delete bookingsOpen[user.id];
      if (editingId === user.id) {
        editingId = '';
      }
      onchanged?.();

      const cancelled = Number(result?.cancelled) || 0;
      // Say who was told only when the server emailed about the bookings it cancelled.
      const notified = result?.emailSent === true && cancelled > 0;
      if (notified) {
        notify(
          { textKey: 'kimchi.user_deleted_notified', vars: { count: formatNumber(cancelled) } },
          LONG_NOTIFICATION_DURATION,
        );
      } else {
        notify({ textKey: 'kimchi.user_deleted' }, DEFAULT_NOTIFICATION_DURATION);
      }
      statusMessage = [
        $t('admin.users_deleted_status', { name: displayName(user) }),
        cancelled > 0 && $t('admin.users_cancelled_status', { count: formatNumber(cancelled) }),
        notified && $t('admin.status_removed_emailed'),
      ]
        .filter(Boolean)
        .join(' ');
    } catch (error) {
      rowError = {
        id: user.id,
        message:
          error.code === 'user_is_mentor' && error.title
            ? $t('admin.users_mentor_error', { email: user.email, title: error.title })
            : error.message || $t('admin.users_delete_error'),
      };
      // The server suspended the account and may have cancelled some bookings before it
      // stopped, so show both as they are now. A retry skips what was already cancelled.
      if (error.code === 'user_delete_incomplete') {
        pinnedId = user.id;
        refreshed = Promise.allSettled([load(), onchanged?.()]);
      }
    } finally {
      actionState = null;
    }

    await settleFocus(trigger, index);
    if (refreshed) {
      // The refresh re-renders the row (suspended now): keep focus on it, not on <body>.
      await refreshed;
      await settleFocus(trigger, index);
    }
  }

  onMount(load);

  onDestroy(() => {
    destroyed = true;
  });
</script>

<section id="admin-users" class="admin-users" aria-labelledby="admin-users-heading">
  <h3 bind:this={heading} id="admin-users-heading" class="admin-subheading admin-users__heading" tabindex="-1">
    {$t('admin.users_heading')}
  </h3>
  <p class="visually-hidden" role="status">{statusMessage}</p>

  {#if hasLoaded || loading}
    <div class="admin-users__toolbar">
      <div class="admin-users__search">
        <label for="admin-users-search">{$t('admin.users_search_label')}</label>
        <input
          id="admin-users-search"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder={$t('admin.users_search_placeholder')}
          bind:value={query}
          oninput={resetPaging}
        />
      </div>
      <div class="inventory-filter admin-users__filter" role="group" aria-label={$t('admin.users_filter_aria')}>
        {#each FILTERS as kind (kind)}
          <!-- No count until it's known: members load here, bookings with AdminPanel's list. -->
          {@const counting = !hasLoaded || (kind === 'active' && !itemsLoaded)}
          <button
            type="button"
            class="inventory-filter__btn"
            class:inventory-filter__btn--active={filter === kind}
            aria-pressed={filter === kind}
            aria-label={counting
              ? undefined
              : $t('admin.users_filter_with_count', {
                  label: $t(FILTER_LABELS[kind]),
                  count: formatNumber(filterCounts[kind]),
                })}
            onclick={() => selectFilter(kind)}
          >
            <span class="inventory-filter__label">{$t(FILTER_LABELS[kind])}</span>
            {#if counting}
              <span class="inventory-filter__count inventory-filter__count--loading" aria-hidden="true"></span>
            {:else}
              <span class="inventory-filter__count" aria-hidden="true">{formatNumber(filterCounts[kind])}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {/if}
  {#if loading && !hasLoaded}
    <Skeleton count={6} avatar actions={2} label={$t('admin.loading')} />
  {:else if visibleRows.length > 0}
    <!-- No aria-busy while a form or row error is up: it would hold back their alerts. -->
    <ul
      class="admin-item-list admin-users__list"
      class:list-refreshing={loading}
      aria-busy={(loading && !editingId && !rowError.id) || undefined}
    >
      {#each visibleRows as row (row.user.id)}
        {@const user = row.user}
        {@const name = displayName(user)}
        {@const nameId = `admin-user-${user.id}-name`}
        {@const bookingsId = `admin-user-${user.id}-bookings`}
        <li bind:this={rowRefs[user.id]} class="admin-item-row admin-users__row" tabindex="-1">
          <div class="admin-users__summary">
            <span class="admin-avatar admin-avatar--{avatarTone(user.id)}" aria-hidden="true">{initials(user)}</span>
            <div class="admin-users__meta">
              <span class="admin-users__name">
                <span id={nameId} class="admin-item-title">{name}</span>
                {#if user.isSelf}
                  <span class="consultation-status admin-users__pill">{$t('admin.users_pill_self')}</span>
                {/if}
                {#if user.isAdmin}
                  <span class="consultation-status admin-users__pill admin-users__pill--admin">
                    {$t('admin.users_pill_admin')}
                  </span>
                {/if}
                {#if row.mentor}
                  <span class="consultation-status admin-users__pill admin-users__pill--mentor">
                    {$t('admin.users_pill_mentor')}
                  </span>
                {/if}
                {#if user.suspended}
                  <span class="consultation-status admin-users__pill admin-users__pill--suspended">
                    {$t('admin.users_pill_suspended')}
                  </span>
                {/if}
                {#if user.confirmed === false}
                  <span class="consultation-status admin-users__pill admin-users__pill--unconfirmed">
                    {$t('admin.users_pill_unconfirmed')}
                  </span>
                {/if}
              </span>
              {#if user.name && user.email}
                <span class="admin-users__email">{user.email}</span>
              {/if}
              <span class="admin-users__detail">
                {#each accountFacts(user) as fact, index (index)}
                  {#if index > 0}{' · '}{/if}<span class="admin-users__fact">{fact}</span>
                {/each}
              </span>
              {#if itemsLoaded}
                <span class="admin-users__detail">
                  {$t('admin.users_bookings_count', {
                    total: formatNumber(row.bookings.length),
                    active: formatNumber(row.activeCount),
                  })}
                </span>
              {/if}
              {#if row.isProtected}
                <span class="admin-users__detail admin-users__note">{$t('admin.users_protected_note')}</span>
              {/if}
            </div>
          </div>

          {#if editingId === user.id}
            <div class="admin-users__panel">
              <form class="admin-mentor-editor admin-users__editor" novalidate onsubmit={(event) => handleSave(event, user)}>
                <label for="admin-user-{user.id}-input">{$t('admin.users_name_label')}</label>
                <input
                  bind:this={nameInput}
                  id="admin-user-{user.id}-input"
                  name="name"
                  type="text"
                  autocomplete="off"
                  maxlength={EXPERT_NAME_MAX}
                  aria-describedby="admin-user-{user.id}-hint"
                  bind:value={editName}
                />
                <p id="admin-user-{user.id}-hint" class="field-hint">{$t('admin.users_name_hint')}</p>

                {#if editError}
                  <p class="admin-status admin-status-error" role="alert">{editError}</p>
                {/if}

                <div class="admin-mentor-actions">
                  <button type="button" class="btn-secondary" disabled={Boolean(actionState)} onclick={cancelEdit}>
                    {$t('auth.cancel')}
                  </button>
                  <button type="submit" class="btn-primary" disabled={Boolean(actionState)}>
                    <BusyLabel
                      label={$t('admin.users_save')}
                      busyLabel={$t('admin.users_saving')}
                      busy={isBusy(user.id, 'save')}
                    />
                  </button>
                </div>
              </form>
            </div>
          {:else}
            <div class="consultation-row__actions admin-users__actions">
              <div class="admin-pending-actions">
                <button
                  type="button"
                  class="btn-header btn-header--secondary"
                  aria-expanded={Boolean(bookingsOpen[user.id])}
                  aria-controls={bookingsId}
                  aria-describedby={nameId}
                  disabled={!itemsLoaded}
                  onclick={() => toggleBookings(user.id)}
                >
                  {$t('admin.users_bookings')}
                </button>
                <button
                  bind:this={editButtons[user.id]}
                  type="button"
                  class="btn-secondary admin-mentor-edit"
                  aria-describedby={nameId}
                  disabled={Boolean(actionState) || Boolean(editingId)}
                  onclick={() => startEdit(user)}
                >
                  {$t('admin.users_edit')}
                </button>
                {#if user.passwordLogin && !user.suspended}
                  <button
                    type="button"
                    class="btn-header btn-header--secondary"
                    aria-describedby={nameId}
                    disabled={Boolean(actionState)}
                    onclick={() => handleReset(user)}
                  >
                    <BusyLabel
                      label={$t('admin.users_reset')}
                      busyLabel={$t('admin.users_resetting')}
                      busy={isBusy(user.id, 'reset')}
                    />
                  </button>
                {/if}
                {#if !row.isProtected}
                  <button
                    type="button"
                    class={user.suspended ? 'btn-approve' : 'btn-remove'}
                    aria-describedby={nameId}
                    disabled={Boolean(actionState)}
                    onclick={() => handleSuspend(row)}
                  >
                    <BusyLabel
                      label={$t(user.suspended ? 'admin.users_unsuspend' : 'admin.users_suspend')}
                      busyLabel={$t(user.suspended ? 'admin.users_unsuspending' : 'admin.users_suspending')}
                      busy={isBusy(user.id, 'suspend')}
                    />
                  </button>
                  <button
                    type="button"
                    class="btn-remove"
                    aria-describedby={nameId}
                    disabled={Boolean(actionState) || !itemsLoaded}
                    onclick={() => handleDelete(row)}
                  >
                    <BusyLabel
                      label={$t('admin.users_delete')}
                      busyLabel={$t('admin.users_deleting')}
                      busy={isBusy(user.id, 'delete')}
                    />
                  </button>
                {/if}
              </div>
              {#if rowError.id === user.id}
                <p class="admin-status admin-status-error consultation-row__error" role="alert">
                  {rowError.message}
                </p>
              {/if}
            </div>

            {#if bookingsOpen[user.id]}
              <div class="admin-users__panel">
                {#if row.bookings.length > 0}
                  <ul
                    id={bookingsId}
                    class="consultation-follow-up admin-users__bookings"
                    aria-label={$t('admin.users_bookings_aria', { name })}
                  >
                    {#each row.bookings as booking (booking.reservation.id)}
                      {@const status = bookingStatus(booking)}
                      <li class="admin-users__booking">
                        <span class="consultation-row__heading">
                          <span class="admin-users__booking-title">{booking.item.title}</span>
                          <span class="consultation-status consultation-status--{status.key}">{status.label}</span>
                        </span>
                        <span class="admin-users__detail">
                          {$t(`inventory.filter_${booking.item.tag ?? 'equipment'}`)} · {bookingWhen(booking)}
                        </span>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p id={bookingsId} class="admin-users__bookings-empty">{$t('admin.users_bookings_empty')}</p>
                {/if}
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>

    {#if filteredRows.length > visibleRows.length}
      <div class="admin-users__more">
        <p class="admin-users__showing">
          {$t('admin.users_showing', {
            shown: formatNumber(visibleRows.length),
            total: formatNumber(filteredRows.length),
          })}
        </p>
        <button type="button" class="btn-header btn-header--secondary" onclick={showMore}>
          {$t('admin.users_show_more')}
        </button>
      </div>
    {/if}
  {:else if hasLoaded}
    <p class="empty-state">{$t(users.length > 0 ? 'admin.users_no_match' : 'admin.users_empty')}</p>
  {/if}
</section>
