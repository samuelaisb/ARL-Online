<script>
  import { createReservation } from '../lib/inventory.js';
  import { t } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import BusyLabel from './BusyLabel.svelte';

  let { item, onupdated, onconfirmed, onbeforeconfirm } = $props();

  const TIME_SLOTS_MAX = 500;
  const SUMMARY_MAX = 2000;

  let timeSlots = $state('');
  let summary = $state('');
  let saving = $state(false);
  let statusMessage = $state('');
  let statusType = $state('');

  function clearStatus() {
    statusMessage = '';
    statusType = '';
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (saving) {
      return;
    }

    const trimmedTimeSlots = timeSlots.trim();
    const trimmedSummary = summary.trim();

    if (!trimmedTimeSlots || !trimmedSummary) {
      statusMessage = $t('consultation.fill_all_fields');
      statusType = 'error';
      return;
    }

    if (onbeforeconfirm && onbeforeconfirm() === false) {
      return;
    }

    saving = true;
    clearStatus();

    try {
      const result = await createReservation(item.id, {
        timeSlots: trimmedTimeSlots,
        summary: trimmedSummary,
      });

      const updatedItem =
        result.item?.reservations != null
          ? { ...item, reservations: result.item.reservations }
          : result.item;

      onupdated?.(updatedItem);
      onconfirmed?.({ item: updatedItem, reservation: result.reservation });
      notify({ textKey: 'kimchi.consultation_sent' }, DEFAULT_NOTIFICATION_DURATION);
      timeSlots = '';
      summary = '';
      statusMessage = $t('consultation.request_pending');
      statusType = 'success';
    } catch (error) {
      statusMessage = error.message || $t('consultation.create_error');
      statusType = 'error';
    } finally {
      saving = false;
    }
  }
</script>

<form class="consultation-form" novalidate onsubmit={handleSubmit}>
  <h4 class="consultation-form__title">{$t('consultation.heading')}</h4>
  <p class="consultation-form__intro">{$t('consultation.intro', { name: item.title })}</p>

  <label class="consultation-form__label" for="consultation-time-slots">
    {$t('consultation.time_slots_label')}
  </label>
  <textarea
    id="consultation-time-slots"
    class="consultation-form__textarea"
    rows="3"
    maxlength={TIME_SLOTS_MAX}
    placeholder={$t('consultation.time_slots_placeholder')}
    required
    bind:value={timeSlots}
  ></textarea>

  <label class="consultation-form__label" for="consultation-summary">
    {$t('consultation.summary_label')}
  </label>
  <textarea
    id="consultation-summary"
    class="consultation-form__textarea"
    rows="5"
    maxlength={SUMMARY_MAX}
    placeholder={$t('consultation.summary_placeholder')}
    required
    bind:value={summary}
  ></textarea>

  <div class="consultation-form__actions">
    <button
      type="submit"
      class="btn-calendar-confirm"
      aria-describedby="consultation-sharing-note"
      disabled={saving}
    >
      <BusyLabel
        label={$t('consultation.submit')}
        busyLabel={$t('consultation.submitting')}
        busy={saving}
      />
    </button>
  </div>
  <p id="consultation-sharing-note" class="consultation-form__note">
    {$t('consultation.sharing_note', { name: item.title })}
  </p>

  {#if statusMessage}
    <p class="consultation-form__status status {statusType}" role="status" aria-live="polite">
      {statusMessage}
    </p>
  {/if}
</form>
