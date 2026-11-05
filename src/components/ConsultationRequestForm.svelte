<script>
  import { tick } from 'svelte';
  import { trackBookingRequestSent } from '../lib/analytics.js';
  import { availabilityNow } from '../lib/availability-clock.js';
  import { toDateKey } from '../lib/calendar.js';
  import { locale, t } from '../lib/i18n.js';
  import { createReservation } from '../lib/inventory.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import { isPlainLeftClick, navigateToPage } from '../lib/router.js';
  import BusyLabel from './BusyLabel.svelte';

  let { item, onupdated, onconfirmed, onbeforeconfirm } = $props();

  // The server's limits (CONSULTATION_TIME_SLOTS_MAX / _SUMMARY_MAX in server.js). The times
  // and the member's own words share the one availability box.
  const TIME_SLOTS_MAX = 500;
  const SUMMARY_MAX = 2000;
  const SLOTS_MAX = 3;
  const SLOT_FIELDS = ['date', 'from', 'to'];
  // Only one request form is ever on the page (the expert overlay), as before.
  const ID = 'consultation';

  let nextSlotKey = 1;

  function emptySlot() {
    return { key: nextSlotKey++, date: '', from: '', to: '' };
  }

  let slots = $state([emptySlot()]);
  let ownWordsOpen = $state(false);
  let ownWords = $state('');
  let summary = $state('');
  let saving = $state(false);
  // Field errors hold locale keys, so they follow a language switch. slotErrors maps a slot's
  // key to { key, date, from, to } (which of its inputs to mark).
  let slotErrors = $state({});
  let slotsError = $state('');
  let summaryError = $state(false);
  // The server's message (already translated by apiErrorMessage, or its raw text).
  let submitError = $state('');
  let announcement = $state('');
  // { timeSlots, summary } once the request is saved: the form gives way to what was sent.
  let sent = $state(null);
  let submitErrorBox = $state();
  let sentHeading = $state();

  // The member's own calendar day: the times are in their device's time zone.
  const todayKey = $derived(toDateKey(new Date($availabilityNow)));

  // "Tue, Nov 10, 2:00–4:00 p.m. EST": the member's language and their device's time zone
  // name, so the expert reads the time as the member meant it.
  const slotFormat = $derived(
    new Intl.DateTimeFormat($locale === 'fr' ? 'fr-CA' : 'en-CA', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
  );

  const isBlank = (slot) => !slot.date && !slot.from && !slot.to;

  // What's wrong with one row, or null. A blank row is fine (it's left out).
  function slotProblem(slot, today) {
    if (isBlank(slot)) {
      return null;
    }
    if (!slot.date || !slot.from || !slot.to) {
      return {
        key: 'consultation.slot_incomplete',
        date: !slot.date,
        from: !slot.from,
        to: !slot.to,
      };
    }
    if (slot.date < today) {
      return { key: 'consultation.slot_past', date: true };
    }
    if (slot.to <= slot.from) {
      return { key: 'calendar.room_times_order', from: true, to: true };
    }
    return null;
  }

  function formatSlot(slot) {
    const [year, month, day] = slot.date.split('-').map(Number);
    const [startHour, startMinute] = slot.from.split(':').map(Number);
    const [endHour, endMinute] = slot.to.split(':').map(Number);
    return slotFormat.formatRange(
      new Date(year, month - 1, day, startHour, startMinute),
      new Date(year, month - 1, day, endHour, endMinute),
    );
  }

  const slotLines = $derived(
    slots.filter((slot) => !isBlank(slot) && !slotProblem(slot, todayKey)).map(formatSlot),
  );
  // Closing the disclosure leaves their words out, as it hides them.
  const ownWordsText = $derived(ownWordsOpen ? ownWords.trim() : '');
  // The request's availability box (still the one `timeSlots` text): a line per time, then
  // their own words.
  const timeSlotsText = $derived([...slotLines, ownWordsText].filter(Boolean).join('\n'));
  // What's left of the box for their own words once the times are in.
  const ownWordsMax = $derived(
    TIME_SLOTS_MAX - (slotLines.length ? slotLines.join('\n').length + 1 : 0),
  );

  const hasSlotErrors = $derived(Object.keys(slotErrors).length > 0);
  // The line above Send request: the existing summary when something is missing.
  const formErrorKey = $derived(
    slotsError === 'consultation.slots_required' || summaryError
      ? 'consultation.fill_all_fields'
      : hasSlotErrors
        ? 'consultation.slots_fix'
        : slotsError,
  );

  function fieldId(slot, field) {
    return `${ID}-slot-${slot.key}-${field}`;
  }

  function slotErrorId(slot) {
    return `${ID}-slot-${slot.key}-error`;
  }

  // "Add at least one time" is shown on the first row's date.
  function isSlotFieldInvalid(slot, index, field) {
    return (
      !!slotErrors[slot.key]?.[field] ||
      (slotsError === 'consultation.slots_required' && index === 0 && field === 'date')
    );
  }

  function slotDescribedBy(slot, index, field) {
    const ids = [];
    if (slotErrors[slot.key]) {
      ids.push(slotErrorId(slot));
    }
    if (slotsError === 'consultation.slots_required' && index === 0 && field === 'date') {
      ids.push(`${ID}-slots-error`);
    }
    return ids.join(' ') || undefined;
  }

  async function announce(text) {
    announcement = '';
    await tick();
    announcement = text;
  }

  // Typing in a row clears its error (the next Send checks again).
  function clearSlotError(slot) {
    if (slotErrors[slot.key]) {
      const { [slot.key]: _cleared, ...rest } = slotErrors;
      slotErrors = rest;
    }
    slotsError = '';
  }

  async function addSlot() {
    if (slots.length >= SLOTS_MAX) {
      return;
    }

    const slot = emptySlot();
    slots.push(slot);
    slotsError = '';
    await tick();
    document.getElementById(fieldId(slot, 'date'))?.focus();
  }

  async function removeSlot(slot) {
    const index = slots.findIndex((entry) => entry.key === slot.key);
    if (index === -1 || slots.length <= 1) {
      return;
    }

    clearSlotError(slot);
    slots.splice(index, 1);
    announce($t('consultation.slot_removed', { n: index + 1 }));
    // The button just pressed is gone; Add another time is always there (and enabled now).
    await tick();
    document.getElementById(`${ID}-add-slot`)?.focus();
  }

  function toggleOwnWords() {
    ownWordsOpen = !ownWordsOpen;
    slotsError = '';
  }

  // Sets every field error and returns the id of the first invalid field in page order.
  function validate() {
    const nextSlotErrors = {};
    for (const slot of slots) {
      const problem = slotProblem(slot, todayKey);
      if (problem) {
        nextSlotErrors[slot.key] = problem;
      }
    }

    slotErrors = nextSlotErrors;
    slotsError = slots.every(isBlank) && !ownWordsText
      ? 'consultation.slots_required'
      : timeSlotsText.length > TIME_SLOTS_MAX
        ? 'consultation.slots_too_long'
        : '';
    summaryError = !summary.trim();

    if (slotsError === 'consultation.slots_required') {
      return fieldId(slots[0], 'date');
    }
    const firstBadSlot = slots.find((slot) => nextSlotErrors[slot.key]);
    if (firstBadSlot) {
      return fieldId(firstBadSlot, SLOT_FIELDS.find((field) => nextSlotErrors[firstBadSlot.key][field]));
    }
    // Only their own words can make the box too long: three times take about 120 characters.
    if (slotsError) {
      return `${ID}-own-words`;
    }
    if (summaryError) {
      return `${ID}-summary`;
    }
    return null;
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (saving) {
      return;
    }

    submitError = '';
    const invalidFieldId = validate();
    if (invalidFieldId) {
      await tick();
      document.getElementById(invalidFieldId)?.focus();
      return;
    }

    if (onbeforeconfirm && onbeforeconfirm() === false) {
      return;
    }

    const request = { timeSlots: timeSlotsText, summary: summary.trim() };
    saving = true;

    try {
      const result = await createReservation(item.id, request);
      trackBookingRequestSent(item);

      const updatedItem =
        result.item?.reservations != null
          ? { ...item, reservations: result.item.reservations }
          : result.item;

      onupdated?.(updatedItem);
      onconfirmed?.({ item: updatedItem, reservation: result.reservation });
      notify({ textKey: 'kimchi.consultation_sent' }, DEFAULT_NOTIFICATION_DURATION);
      sent = request;
      await tick();
      sentHeading?.focus();
    } catch (error) {
      submitError = error.message || $t('consultation.create_error');
      // Send request was disabled while saving, which dropped focus to <body>.
      await tick();
      submitErrorBox?.focus();
    } finally {
      saving = false;
    }
  }

  function goToAccount(event) {
    if (!isPlainLeftClick(event)) {
      return;
    }
    event.preventDefault();
    navigateToPage('/account');
  }
</script>

{#snippet errorIcon()}
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 7v6M12 17v0.01" />
  </svg>
{/snippet}

<div class="consultation-request">
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if sent}
    <section class="consultation-request__sent" aria-labelledby="{ID}-sent-heading">
      <div class="consultation-request__head">
        <h2
          bind:this={sentHeading}
          id="{ID}-sent-heading"
          class="f-title f-title--sm"
          tabindex="-1"
        >
          {$t('consultation.success_heading')}
        </h2>
        <span class="consultation-status consultation-status--pending">
          {$t('account_consultations.status_pending')}
        </span>
      </div>
      <p class="consultation-request__intro">{$t('consultation.request_pending')}</p>

      <h3 class="f-label consultation-request__label">{$t('consultation.success_times')}</h3>
      <p class="f-note">{sent.timeSlots}</p>
      <h3 class="f-label consultation-request__label">{$t('consultation.success_request')}</h3>
      <p class="f-note">{sent.summary}</p>

      <a
        href="/account"
        class="action-btn action-btn--primary consultation-request__account"
        onclick={goToAccount}
      >
        {$t('consultation.success_account_link')}
      </a>
    </section>
  {:else}
    <section aria-labelledby="{ID}-heading">
      <h2 id="{ID}-heading" class="f-title f-title--sm">{$t('consultation.heading')}</h2>
      <p class="consultation-request__intro">{$t('consultation.intro', { name: item.title })}</p>

      <form class="consultation-form" novalidate onsubmit={handleSubmit}>
        <fieldset
          class="consultation-form__group"
          aria-describedby="{ID}-slots-hint{slotsError ? ` ${ID}-slots-error` : ''}"
        >
          <legend class="f-field-label consultation-form__legend">{$t('consultation.slots_legend')}</legend>
          <p id="{ID}-slots-hint" class="consultation-form__hint">
            {$t('consultation.slots_hint', { name: item.title })}
          </p>
          {#if slotsError}
            <p id="{ID}-slots-error" class="consultation-form__error">
              {@render errorIcon()}<span>{$t(slotsError)}</span>
            </p>
          {/if}

          <div class="consultation-slots__heads" aria-hidden="true">
            <span class="f-label">{$t('consultation.slot_date')}</span>
            <span class="f-label">{$t('consultation.slot_from')}</span>
            <span class="f-label">{$t('consultation.slot_to')}</span>
          </div>

          {#each slots as slot, index (slot.key)}
            {@const problem = slotErrors[slot.key]}
            <div
              class="consultation-slot"
              role="group"
              aria-labelledby="{ID}-slot-{slot.key}-name"
            >
              <span id="{ID}-slot-{slot.key}-name" class="f-field-label consultation-slot__name">
                {$t('consultation.slot_label', { n: index + 1 })}
              </span>
              {#each SLOT_FIELDS as field (field)}
                <div class="consultation-slot__field consultation-slot__field--{field}">
                  <label class="f-label consultation-slot__label" for={fieldId(slot, field)}>
                    {$t(`consultation.slot_${field}`)}
                  </label>
                  {#if field === 'date'}
                    <input
                      id={fieldId(slot, field)}
                      class="consultation-slot__input"
                      type="date"
                      min={todayKey}
                      bind:value={slot.date}
                      aria-invalid={isSlotFieldInvalid(slot, index, field) ? 'true' : undefined}
                      aria-describedby={slotDescribedBy(slot, index, field)}
                      oninput={() => clearSlotError(slot)}
                    />
                  {:else}
                    <input
                      id={fieldId(slot, field)}
                      class="consultation-slot__input consultation-slot__input--time"
                      type="time"
                      step="900"
                      bind:value={slot[field]}
                      aria-invalid={isSlotFieldInvalid(slot, index, field) ? 'true' : undefined}
                      aria-describedby={slotDescribedBy(slot, index, field)}
                      oninput={() => clearSlotError(slot)}
                    />
                  {/if}
                </div>
              {/each}
              <button
                type="button"
                class="action-btn action-btn--icon consultation-slot__remove"
                aria-label={$t('consultation.slot_remove_aria', { n: index + 1 })}
                disabled={slots.length <= 1}
                onclick={() => removeSlot(slot)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
              {#if problem}
                <p id={slotErrorId(slot)} class="consultation-form__error consultation-slot__error">
                  {@render errorIcon()}<span
                    >{$t(
                      problem.key === 'consultation.slot_incomplete' && slots.length <= 1
                        ? 'consultation.slot_incomplete_only'
                        : problem.key,
                    )}</span
                  >
                </p>
              {/if}
            </div>
          {/each}

          <div class="consultation-form__add">
            <button
              id="{ID}-add-slot"
              type="button"
              class="action-btn"
              disabled={slots.length >= SLOTS_MAX}
              onclick={addSlot}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M12 4.5v15M4.5 12h15" />
              </svg>
              {$t('consultation.slot_add')}
            </button>
          </div>

          <button
            type="button"
            class="f-disclosure f-disclosure--sm consultation-form__own-words-toggle"
            aria-expanded={ownWordsOpen}
            aria-controls="{ID}-own-words-panel"
            onclick={toggleOwnWords}
          >
            <svg class="f-disclosure__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3.5 12h17" />
              <path class="f-disclosure__stem" d="M12 3.5v17" />
            </svg>
            <span class="f-disclosure__text">{$t('consultation.own_words_show')}</span>
          </button>
          <div
            id="{ID}-own-words-panel"
            class="consultation-form__field consultation-form__own-words"
            hidden={!ownWordsOpen}
          >
            <div class="consultation-form__field-head">
              <label class="f-field-label" for="{ID}-own-words">{$t('consultation.own_words_label')}</label>
              <!-- Counts against what the times leave of the box. -->
              <span
                id="{ID}-own-words-count"
                class="consultation-form__count"
                class:consultation-form__count--over={ownWords.length > ownWordsMax}
              >
                {$t('consultation.summary_count', { count: ownWords.length, max: ownWordsMax })}
              </span>
            </div>
            <textarea
              id="{ID}-own-words"
              class="consultation-form__textarea"
              rows="3"
              maxlength={TIME_SLOTS_MAX}
              placeholder={$t('consultation.time_slots_placeholder')}
              bind:value={ownWords}
              aria-invalid={slotsError === 'consultation.slots_too_long' ? 'true' : undefined}
              aria-describedby="{slotsError === 'consultation.slots_too_long' ? `${ID}-slots-error ` : ''}{ID}-own-words-count"
              oninput={() => (slotsError = '')}
            ></textarea>
          </div>
        </fieldset>

        <div class="consultation-form__field">
          <div class="consultation-form__field-head">
            <label class="f-field-label" for="{ID}-summary">{$t('consultation.summary_label')}</label>
            <span id="{ID}-summary-count" class="consultation-form__count">
              {$t('consultation.summary_count', { count: summary.length, max: SUMMARY_MAX })}
            </span>
          </div>
          <textarea
            id="{ID}-summary"
            class="consultation-form__textarea consultation-form__textarea--summary"
            rows="5"
            maxlength={SUMMARY_MAX}
            placeholder={$t('consultation.summary_placeholder')}
            bind:value={summary}
            aria-invalid={summaryError ? 'true' : undefined}
            aria-describedby="{summaryError ? `${ID}-summary-error ` : ''}{ID}-summary-count"
            oninput={() => (summaryError = false)}
          ></textarea>
          {#if summaryError}
            <p id="{ID}-summary-error" class="consultation-form__error">
              {@render errorIcon()}<span>{$t('consultation.summary_required', { name: item.title })}</span>
            </p>
          {/if}
        </div>

        <div class="f-strip consultation-form__sharing">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
            <circle cx="17" cy="9" r="2.5" />
            <path d="M16.5 13.6c2.9 0.3 5 2.6 5 5.4" />
          </svg>
          <div>
            <p class="f-label">{$t('consultation.who_sees')}</p>
            <p id="{ID}-sharing-note" class="consultation-form__sharing-text">
              {$t('consultation.sharing_note', { name: item.title })}
            </p>
          </div>
        </div>

        <div class="consultation-form__actions">
          {#if submitError || formErrorKey}
            <p
              bind:this={submitErrorBox}
              id="{ID}-form-error"
              class="consultation-form__alert"
              tabindex="-1"
            >
              {@render errorIcon()}<span>{submitError || $t(formErrorKey)}</span>
            </p>
          {/if}
          <button
            type="submit"
            class="action-btn action-btn--primary action-btn--block consultation-form__submit"
            aria-describedby="{ID}-sharing-note"
            disabled={saving}
          >
            <BusyLabel
              label={$t('consultation.submit')}
              busyLabel={$t('consultation.submitting')}
              busy={saving}
            />
          </button>
        </div>
      </form>
    </section>
  {/if}
</div>
