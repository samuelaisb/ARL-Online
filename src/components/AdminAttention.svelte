<script module>
  import { compareDateKeys } from '../lib/calendar.js';
  import { addDays } from '../lib/reservation-rules.js';

  // A consultation request unanswered this long is overdue: the strip, the Pending list's
  // "Waiting a week+" chip and Kimchi's arrival note (B2) all use this rule.
  export const CONSULTATION_WAIT_DAYS = 7;
  const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * A pending request that should have had an answer by now: an equipment, book or room
   * request whose start date has passed, or a consultation request waiting a week or more
   * (a consultation's start date is the day it was requested).
   */
  export function isOverdueRequest(entry, todayKey) {
    if (entry.itemTag === 'expertise') {
      return compareDateKeys(entry.startDate, addDays(todayKey, -CONSULTATION_WAIT_DAYS)) <= 0;
    }
    return compareDateKeys(entry.startDate, todayKey) < 0;
  }

  /** A scheduled consultation, not over yet, that starts within 7 days (or is under way). */
  function isConsultationThisWeek(entry, now) {
    if (entry.itemTag !== 'expertise' || !entry.meetingAt || entry.held) {
      return false;
    }
    const start = Date.parse(entry.meetingAt);
    return !Number.isNaN(start) && start <= now + UPCOMING_WINDOW_MS;
  }
</script>

<script>
  import { locale, t } from '../lib/i18n.js';
  import Skeleton from './Skeleton.svelte';

  // "Needs attention": three counts above the admin toggles, from AdminPanel's own lists, so
  // they match the rows and chips. `onopen('pending' | 'upcoming')` opens the matching list.
  let {
    pendingEntries = [],
    reservationEntries = [],
    todayKey,
    now,
    hasLoaded = false,
    onopen,
  } = $props();

  const uid = $props.id();

  const pendingCount = $derived(pendingEntries.length);
  const upcomingCount = $derived(
    reservationEntries.filter((entry) => isConsultationThisWeek(entry, now)).length,
  );
  const overdueCount = $derived(
    pendingEntries.filter((entry) => isOverdueRequest(entry, todayKey)).length,
  );

  // `tone`: Lemon for a waiting queue, Plum for late ones, plain white otherwise; any tile at
  // zero is white and muted.
  const tiles = $derived([
    {
      key: 'pending',
      target: 'pending',
      count: pendingCount,
      tone: 'lemon',
      labelKey: 'admin.attention_pending',
      hintKey: pendingCount > 0 ? 'admin.attention_pending_hint' : 'admin.attention_pending_none',
    },
    {
      key: 'upcoming',
      target: 'upcoming',
      count: upcomingCount,
      tone: 'plain',
      labelKey: 'admin.attention_upcoming',
      hintKey: upcomingCount > 0 ? 'admin.attention_upcoming_hint' : 'admin.attention_upcoming_none',
    },
    {
      key: 'overdue',
      target: 'pending',
      count: overdueCount,
      tone: 'plum',
      labelKey: 'admin.attention_overdue',
      hintKey: overdueCount > 0 ? 'admin.attention_overdue_hint' : 'admin.attention_overdue_none',
    },
  ]);

  const numberFormat = $derived(new Intl.NumberFormat($locale === 'fr' ? 'fr-CA' : 'en-CA'));
</script>

<section aria-label={$t('admin.attention_heading')}>
  {#if !hasLoaded}
    <Skeleton variant="tiles" count={3} listClass="admin-attention" label={$t('admin.loading')} />
  {:else}
    <ul class="admin-attention">
      {#each tiles as tile (tile.key)}
        <!-- The name is the count and label; the hint is the description. -->
        <li>
          <button
            type="button"
            class="admin-attention__tile admin-attention__tile--{tile.count > 0 ? tile.tone : 'zero'}"
            aria-labelledby="{uid}-{tile.key}-count {uid}-{tile.key}-label"
            aria-describedby="{uid}-{tile.key}-hint"
            onclick={() => onopen?.(tile.target)}
          >
            <span id="{uid}-{tile.key}-count" class="admin-attention__count">
              {numberFormat.format(tile.count)}
            </span>
            <span id="{uid}-{tile.key}-label" class="admin-attention__label">{$t(tile.labelKey)}</span>
            <span id="{uid}-{tile.key}-hint" class="admin-attention__hint">{$t(tile.hintKey)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
