<script>
  import { onMount, tick } from 'svelte';
  import { createStaffReservation, fetchAdminUsers } from '../lib/inventory.js';
  import { compareDateKeys, getBlockingReservations, libraryTodayKey, parseDateKey } from '../lib/calendar.js';
  import { CONFIRMATION_MESSAGE_MAX } from '../lib/expertise-fields.js';
  import { addDays, getBlockEndDate, isFixedBlockTag } from '../lib/reservation-rules.js';
  import { locale, t } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import BusyLabel from './BusyLabel.svelte';
  import Skeleton from './Skeleton.svelte';

  // `items`: AdminPanel's admin inventory (reservations carry their emails). `oncreated(itemId,
  // result)` folds the new booking into it, so the booked list below updates at once.
  let {
    items = [],
    loading = false,
    hasLoaded = false,
    loadError = '',
    todayKey = libraryTodayKey(),
    oncreated,
  } = $props();

  const TAGS = ['equipment', 'books', 'rooms'];
  // STAFF_RESERVATION_MAX_DAYS in server.js.
  const MAX_DAYS = 366;
  // Same check as the server's isValidEmailAddress.
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let itemId = $state('');
  let email = $state('');
  let startDate = $state('');
  let endDate = $state('');
  // Until staff pick an end date themselves, it follows the start date (the item's usual block).
  let endTouched = false;
  let message = $state('');
  let submitting = $state(false);
  let errors = $state({ item: '', email: '', dates: '' });
  let formError = $state('');
  let doneMessage = $state('');
  // Accounts for the email suggestions and the member hint; empty if they didn't load.
  let users = $state([]);

  let itemSelect = $state();
  let emailInput = $state();
  let startInput = $state();

  const groups = $derived(
    TAGS.map((tag) => ({
      tag,
      items: items
        .filter((item) => item.tag === tag)
        .sort((a, b) => a.title.localeCompare(b.title, $locale === 'fr' ? 'fr-CA' : 'en-CA')),
    })).filter((group) => group.items.length > 0),
  );

  const selectedItem = $derived(items.find((item) => item.id === itemId) ?? null);

  // Pending requests block dates too, as on the server.
  const booked = $derived(
    selectedItem
      ? getBlockingReservations(selectedItem.reservations ?? [])
          .filter((entry) => compareDateKeys(entry.endDate, todayKey) >= 0)
          .sort((a, b) => compareDateKeys(a.startDate, b.startDate))
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
    errors.dates = '';
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

  function validate() {
    const next = { item: '', email: '', dates: '' };

    if (!selectedItem) {
      next.item = $t('admin.create_reservation_item_required');
    }

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      next.email = $t('admin.create_reservation_email_invalid');
    } else if (matchedUser?.suspended) {
      next.email = $t('admin.create_reservation_suspended');
    }

    if (!startDate || !endDate) {
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

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    doneMessage = '';
    formError = '';
    errors = validate();

    const firstInvalid = errors.item ? itemSelect : errors.email ? emailInput : errors.dates ? startInput : null;
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const item = selectedItem;
    const to = email.trim();
    const confirmed = window.confirm(
      $t('admin.create_reservation_confirm', {
        title: item.title,
        dates: formatRange(startDate, endDate),
        email: to,
      }),
    );

    if (!confirmed) {
      return;
    }

    submitting = true;

    try {
      const result = await createStaffReservation(item.id, { email: to, startDate, endDate, message });
      oncreated?.(item.id, result);

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

      // The item stays picked, so its booked list shows the new booking.
      email = '';
      startDate = '';
      endDate = '';
      endTouched = false;
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
          {#if booked.length > 0}
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
        aria-invalid={errors.email ? 'true' : undefined}
        aria-describedby="admin-create-reservation-email-hint{errors.email ? ' admin-create-reservation-email-error' : ''}"
        oninput={() => (errors.email = '')}
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
      <p id="admin-create-reservation-email-hint" class="field-hint admin-create-reservation__hint">{emailHint}</p>

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

      <label for="admin-create-reservation-message">{$t('admin.create_reservation_message_label')}</label>
      <textarea
        id="admin-create-reservation-message"
        class="admin-create-reservation__message"
        rows="3"
        maxlength={CONFIRMATION_MESSAGE_MAX}
        aria-describedby="admin-create-reservation-message-hint"
        bind:value={message}
      ></textarea>
      <p id="admin-create-reservation-message-hint" class="field-hint">{$t('admin.create_reservation_message_hint')}</p>

      {#if formError}
        <p class="admin-status admin-status-error" role="alert">{formError}</p>
      {/if}

      <div class="admin-mentor-actions">
        <button type="submit" class="btn-primary" disabled={submitting}>
          <BusyLabel
            label={$t('admin.create_reservation_submit')}
            busyLabel={$t('admin.create_reservation_submitting')}
            busy={submitting}
          />
        </button>
      </div>
    </form>
  {/if}

  <!-- Always in the page, so the result is announced (Kimchi may be asleep). -->
  <p class="admin-status admin-create-reservation__done" role="status">{doneMessage}</p>
</section>
