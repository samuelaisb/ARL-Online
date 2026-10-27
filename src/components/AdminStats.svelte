<script module>
  import { isApathyAdminEmail } from '../lib/auth.js';
  import { compareDateKeys, libraryTodayKey, parseDateKey } from '../lib/calendar.js';
  import { DEFAULT_INVENTORY_TAG, INVENTORY_TAGS, fetchAdminItemViews } from '../lib/inventory.js';
  import { addDays, isConsultationHeld, isTestCancellation } from '../lib/reservation-rules.js';

  // Pure helpers: each stat below is one of these over the admin items (and the view
  // counts), so every number can be checked by hand.

  // Every outcome counts as a request; `available` rows are staff blocks, not requests.
  const REQUEST_STATUSES = new Set(['pending', 'reserved', 'refused', 'cancelled']);
  const RANK_LIMIT = 10;
  const MENTOR_RANK_LIMIT = 5;
  const QUIET_PREVIEW = 10;
  const SPARK_WIDTH = 300;
  const SPARK_HEIGHT = 60;
  // Keeps the line's 2px stroke inside the box at the peak and at zero.
  const SPARK_PAD = 4;
  /**
   * Anything booked or asked for, whatever came of it: member requests, staff bookings
   * (Create Reservation, 012) and follow-ups. A deleted member's rows lose their email but keep
   * `anonymizedAt`, so their history still counts. Left out: rows with neither (staff blocks,
   * pre-002 bookings), staff accounts' own requests (@apathyisboring.com, filed as internal
   * traffic in GA) and test cancellations.
   */
  function isCountedActivity(reservation) {
    if (!REQUEST_STATUSES.has(reservation.status) || isTestCancellation(reservation)) {
      return false;
    }
    if (reservation.bookedByStaff || reservation.anonymizedAt) {
      return true;
    }
    return Boolean(reservation.userEmail) && !isApathyAdminEmail(reservation.userEmail);
  }

  /**
   * A request: a member's own from the site, or a staff booking. These are what send GA's
   * `booking_request_sent` (`booking_source` member or staff). Follow-ups are booked by the
   * expert from a meeting already counted, so they're activity, not requests.
   */
  function isCountedRequest(reservation) {
    return isCountedActivity(reservation) && !reservation.followUpOf;
  }

  function requestsOf(item) {
    return (item.reservations ?? []).filter(isCountedRequest);
  }

  function activityOf(item) {
    return (item.reservations ?? []).filter(isCountedActivity);
  }

  /**
   * The Montréal day a request came in: its `createdAt` (rows saved since migration 009),
   * else its start date (a consultation's is the day it was asked for; a booking's start is
   * the closest older rows have).
   */
  function requestDayKey(reservation) {
    const created = reservation.createdAt ? Date.parse(reservation.createdAt) : Number.NaN;
    return Number.isNaN(created) ? reservation.startDate : libraryTodayKey(new Date(created));
  }

  function itemTag(item) {
    return item.tag ?? DEFAULT_INVENTORY_TAG;
  }

  /**
   * Requests, on every item, that came in on `sinceKey` or later: `{ total, byStaff }`. A row
   * from before 009 that starts after `todayKey` has no known request day (a booking can be
   * made months ahead), so it's left out rather than counted as a request from the future.
   */
  function countRequestsSince(items, sinceKey, todayKey) {
    const inWindow = (r) =>
      (r.createdAt || compareDateKeys(r.startDate, todayKey) <= 0) &&
      compareDateKeys(requestDayKey(r), sinceKey) >= 0;
    const counted = items.flatMap((item) => requestsOf(item).filter(inWindow));
    return { total: counted.length, byStaff: counted.filter((r) => r.bookedByStaff).length };
  }

  /** `{ [tag]: number of items }` for every category. */
  function countByCategory(items) {
    const counts = Object.fromEntries(INVENTORY_TAGS.map((tag) => [tag, 0]));
    for (const item of items) {
      counts[itemTag(item)] = (counts[itemTag(item)] ?? 0) + 1;
    }
    return counts;
  }

  /** Total and last-30-days views over every counted item. */
  function sumViews(viewRows) {
    let total = 0;
    let last30 = 0;
    for (const row of viewRows) {
      total += row.total ?? 0;
      last30 += row.last30 ?? 0;
    }
    return { total, last30 };
  }

  /** The category with the most views in the last 30 days (`{ tag, count }`), or null. */
  function topCategoryLast30(items, viewsById) {
    const totals = countByCategory([]);
    for (const item of items) {
      totals[itemTag(item)] = (totals[itemTag(item)] ?? 0) + (viewsById.get(item.id)?.last30 ?? 0);
    }

    let best = null;
    for (const tag of INVENTORY_TAGS) {
      if (totals[tag] > 0 && (!best || totals[tag] > best.count)) {
        best = { tag, count: totals[tag] };
      }
    }
    return best;
  }

  /** The `limit` rows with the highest value above zero (ties in title order). */
  function topRows(rows, limit) {
    return rows
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value || (a.item.title ?? '').localeCompare(b.item.title ?? ''))
      .slice(0, limit);
  }

  /** Most viewed: `field` is `last30` or `total`. */
  function rankByViews(items, viewsById, field) {
    return topRows(
      items.map((item) => ({ item, value: viewsById.get(item.id)?.[field] ?? 0 })),
      RANK_LIMIT,
    );
  }

  /** Most requested (all time), with how many of those requests are booked (approved). */
  function rankByRequests(items) {
    return topRows(
      items.map((item) => {
        const requests = requestsOf(item);
        return {
          item,
          value: requests.length,
          booked: requests.filter((r) => r.status === 'reserved').length,
        };
      }),
      RANK_LIMIT,
    );
  }

  /**
   * Busiest mentors (all time): consultations booked, follow-ups and completed meetings
   * included, with how many of those have been held. Every booked row counts, with or
   * without a member email: a mentor's meetings happened whoever was on the other side.
   */
  function rankMentors(items, now) {
    return topRows(
      items
        .filter((item) => item.tag === 'expertise')
        .map((item) => {
          const booked = (item.reservations ?? []).filter((r) => r.status === 'reserved');
          return {
            item,
            value: booked.length,
            completed: booked.filter((r) => isConsultationHeld(r, now)).length,
          };
        }),
      MENTOR_RANK_LIMIT,
    );
  }

  /**
   * Quiet items: on the shelves since before `since60`, with no views and no counted activity
   * (requests, staff bookings, follow-ups) from `since60` on. Longest on the shelves first.
   */
  function findQuietItems(items, viewsById, since60) {
    return items
      .filter((item) => {
        const added = Number(item.createdAt);
        if (!item.createdAt || !Number.isFinite(added)) {
          return false;
        }
        if (compareDateKeys(libraryTodayKey(new Date(added)), since60) >= 0) {
          return false;
        }
        if ((viewsById.get(item.id)?.last60 ?? 0) > 0) {
          return false;
        }
        return !activityOf(item).some((r) => compareDateKeys(requestDayKey(r), since60) >= 0);
      })
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  }

  /** SVG paths (viewBox 0 0 300 60) for the daily views line and the area under it. */
  function sparkPaths(daily) {
    const max = Math.max(1, ...daily.map((day) => day.views));
    const step = daily.length > 1 ? SPARK_WIDTH / (daily.length - 1) : 0;
    const points = daily.map((day, index) => {
      const x = index * step;
      const y = SPARK_HEIGHT - SPARK_PAD - (day.views / max) * (SPARK_HEIGHT - 2 * SPARK_PAD);
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    const line = `M${points.join(' L')}`;
    return { line, area: `${line} L${SPARK_WIDTH} ${SPARK_HEIGHT} L0 ${SPARK_HEIGHT} Z` };
  }

  /** The day with the most views (the latest, on a tie), or null when there were none. */
  function peakDay(daily) {
    let peak = null;
    for (const day of daily) {
      if (day.views > 0 && (!peak || day.views >= peak.views)) {
        peak = day;
      }
    }
    return peak;
  }

  /** A ranking bar's fill, as a percentage of the top row (a sliver stays visible). */
  function barWidth(value, max) {
    return max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  }
</script>

<script>
  import { onMount } from 'svelte';
  import { locale, t } from '../lib/i18n.js';
  import { itemToPath } from '../lib/router.js';
  import Skeleton from './Skeleton.svelte';
  import kimchiAwake from '../../content/kimchi-awake.jpg';

  // `items` are AdminPanel's admin items (reservations with emails); `loading`, `hasLoaded`
  // and `loadError` are its fetch state. View counts are fetched here.
  let { items = [], loading = false, hasLoaded = false, loadError = '', now, todayKey } = $props();

  const uid = $props.id();

  let views = $state(null);
  let viewsLoading = $state(true);
  let viewsError = $state('');
  // Most viewed: 'last30' or 'total' (the view rows' field names).
  let viewedPeriod = $state('last30');
  let showAllQuiet = $state(false);

  const PERIODS = [
    { key: 'last30', labelKey: 'admin.stats_period_30' },
    { key: 'total', labelKey: 'admin.stats_period_all' },
  ];
  const MEDIUM_DATE = { dateStyle: 'medium' };
  const SHORT_DATE = { month: 'short', day: 'numeric' };

  async function loadViews() {
    viewsLoading = true;
    viewsError = '';

    try {
      views = await fetchAdminItemViews();
    } catch (error) {
      viewsError = error.message || $t('admin.stats_views_error');
    } finally {
      viewsLoading = false;
    }
  }

  onMount(loadViews);

  const localeCode = $derived($locale === 'fr' ? 'fr-CA' : 'en-CA');
  const numberFormat = $derived(new Intl.NumberFormat(localeCode));

  function formatNumber(value) {
    return numberFormat.format(value);
  }

  function formatDay(key, options = MEDIUM_DATE) {
    const date = parseDateKey(key);
    return date ? new Intl.DateTimeFormat(localeCode, options).format(date) : (key ?? '');
  }

  function categoryLabel(tag) {
    return $t(`inventory.filter_${tag ?? DEFAULT_INVENTORY_TAG}`);
  }

  // View counts (migration 009). Until it is applied the view blocks are hidden and the
  // view tiles show a dash.
  const viewsAvailable = $derived(views?.available === true);
  const viewsById = $derived(new Map((views?.items ?? []).map((row) => [row.itemId, row])));
  const viewTotals = $derived(sumViews(views?.items ?? []));
  const daily = $derived(views?.daily ?? []);
  // The server's windows when it sent them, so requests are counted over the same days.
  const since30 = $derived(views?.since30 ?? addDays(todayKey, -29));
  const since60 = $derived(views?.since60 ?? addDays(todayKey, -59));

  // From the reservations: these work without the migration.
  const categoryCounts = $derived(countByCategory(items));
  const requestsLast30 = $derived(countRequestsSince(items, since30, views?.today ?? todayKey));
  const mostRequested = $derived(rankByRequests(items));
  const busiestMentors = $derived(rankMentors(items, now));

  // From the view counts.
  const mostViewed = $derived(rankByViews(items, viewsById, viewedPeriod));
  const spark = $derived(sparkPaths(daily));
  const peak = $derived(peakDay(daily));
  const quietItems = $derived(viewsAvailable ? findQuietItems(items, viewsById, since60) : []);
  const visibleQuiet = $derived(showAllQuiet ? quietItems : quietItems.slice(0, QUIET_PREVIEW));
  // Counting started inside the 60-day window: items look quiet only because it's new.
  const countingSince = $derived(views?.firstDay ?? views?.today ?? todayKey);
  const quietSettling = $derived(compareDateKeys(countingSince, since60) > 0);

  const kimchiLine = $derived.by(() => {
    const top = viewTotals.last30 > 0 ? topCategoryLast30(items, viewsById) : null;
    if (top) {
      const form = new Intl.PluralRules(localeCode).select(top.count) === 'one' ? 'one' : 'other';
      return $t(`admin.stats_kimchi_top_${form}`, {
        category: categoryLabel(top.tag),
        count: formatNumber(top.count),
      });
    }
    return $t(viewTotals.total > 0 ? 'admin.stats_kimchi_quiet_month' : 'admin.stats_kimchi_none');
  });

  const sparkSummary = $derived(
    peak
      ? $t('admin.stats_spark_summary', {
          total: formatNumber(viewTotals.last30),
          peak: formatNumber(peak.views),
          date: formatDay(peak.day, SHORT_DATE),
        })
      : $t('admin.stats_spark_summary_empty'),
  );

  // The view tiles say why they're empty: not switched on yet, or (with an error above) nothing.
  function viewsNote(note) {
    if (viewsAvailable) {
      return note;
    }
    return viewsError ? '' : $t('admin.stats_not_switched_on');
  }

  const tiles = $derived([
    {
      key: 'views-total',
      labelKey: 'admin.stats_views_total',
      value: viewsAvailable ? formatNumber(viewTotals.total) : '—',
      note: viewsNote(
        views?.firstDay
          ? $t('admin.stats_since', { date: formatDay(views.firstDay) })
          : $t('admin.stats_no_views_yet'),
      ),
    },
    {
      key: 'views-30',
      labelKey: 'admin.stats_views_30',
      value: viewsAvailable ? formatNumber(viewTotals.last30) : '—',
      note: viewsNote($t('admin.stats_views_30_note')),
    },
    {
      key: 'requests-30',
      labelKey: 'admin.stats_requests_30',
      value: formatNumber(requestsLast30.total),
      note: $t('admin.stats_requests_30_note'),
      // "Members 12 · Staff 3" once staff have booked in the window.
      parts:
        requestsLast30.byStaff > 0
          ? [
              $t('admin.stats_requests_members', {
                count: formatNumber(requestsLast30.total - requestsLast30.byStaff),
              }),
              $t('admin.stats_requests_staff', { count: formatNumber(requestsLast30.byStaff) }),
            ]
          : [],
    },
    {
      key: 'items',
      labelKey: 'admin.stats_items',
      value: formatNumber(items.length),
      note: '',
      parts: INVENTORY_TAGS.filter((tag) => categoryCounts[tag] > 0).map((tag) =>
        $t('admin.stats_category_count', {
          category: categoryLabel(tag),
          count: formatNumber(categoryCounts[tag]),
        }),
      ),
    },
  ]);
</script>

<!-- A new tab, so checking an item doesn't leave /admin (and its open sections). -->
{#snippet itemLink(item)}
  <a class="admin-rank__title" href={itemToPath(item)} target="_blank" rel="noopener noreferrer">
    {item.title}<span class="visually-hidden"> {$t('admin.stats_opens_new_tab')}</span>
  </a>
{/snippet}

{#snippet rankList(rows, metaFor)}
  {@const max = rows[0]?.value ?? 0}
  <ol class="admin-item-list admin-rank">
    {#each rows as row, index (row.item.id)}
      <li class="admin-item-row admin-rank__row">
        <span class="admin-rank__number" aria-hidden="true">{index + 1}</span>
        <span class="admin-rank__main">
          {@render itemLink(row.item)}
          <span class="admin-rank__meta">{metaFor(row)}</span>
          <span class="admin-rank__bar" aria-hidden="true">
            <span class="admin-rank__fill" style:width="{barWidth(row.value, max)}%"></span>
          </span>
        </span>
        <span class="admin-rank__value">{formatNumber(row.value)}</span>
      </li>
    {/each}
  </ol>
{/snippet}

<section id="admin-stats" class="admin-stats" aria-labelledby="{uid}-heading">
  <h3 id="{uid}-heading" class="admin-subheading">{$t('admin.stats_heading')}</h3>

  {#if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {/if}
  {#if viewsError}
    <p class="admin-status admin-status-error" role="alert">{viewsError}</p>
  {/if}

  {#if !hasLoaded || viewsLoading}
    <!-- Nothing to wait for once a first admin fetch has failed: its error is above. -->
    {#if loading || viewsLoading}
      <div class="admin-stats__body">
        <Skeleton variant="stats" count={4} />
        <Skeleton count={5} actions={0} label={$t('admin.loading')} />
      </div>
    {/if}
  {:else}
    <div class="admin-stats__body">
      {#if viewsAvailable}
        <div class="admin-stats__kimchi">
          <img class="admin-stats__kimchi-photo" src={kimchiAwake} alt="" width="40" height="40" />
          <p class="admin-stats__kimchi-line">{kimchiLine}</p>
        </div>
      {:else if !viewsError}
        <p class="admin-stats__notice">{$t('admin.stats_views_unavailable')}</p>
      {/if}

      <ul class="admin-stats__tiles">
        {#each tiles as tile (tile.key)}
          <li class="admin-stat">
            <span class="admin-stat__label">{$t(tile.labelKey)}</span>
            <span class="admin-stat__value">{tile.value}</span>
            {#if tile.parts?.length}
              <!-- "Expertise 12 · Equipment 30": lines break only after a dot. -->
              <span class="admin-stat__note">
                {#each tile.parts as part, index (part)}{#if index > 0}{' · '}{/if}<span class="admin-stat__part">{part}</span>{/each}
              </span>
            {:else if tile.note}
              <span class="admin-stat__note">{tile.note}</span>
            {/if}
          </li>
        {/each}
      </ul>

      {#if viewsAvailable && daily.length > 0}
        <div class="admin-spark">
          <div class="admin-spark__header">
            <h4 class="admin-stats__title">{$t('admin.stats_views_30')}</h4>
            {#if peak}
              <span class="admin-spark__peak">
                {$t('admin.stats_spark_peak', {
                  count: formatNumber(peak.views),
                  date: formatDay(peak.day, SHORT_DATE),
                })}
              </span>
            {/if}
          </div>
          <svg
            class="admin-spark__chart"
            viewBox="0 0 300 60"
            preserveAspectRatio="none"
            role="img"
            aria-label={sparkSummary}
          >
            <path class="admin-spark__area" d={spark.area} />
            <path class="admin-spark__line" d={spark.line} vector-effect="non-scaling-stroke" />
          </svg>
          <div class="admin-spark__axis" aria-hidden="true">
            <span>{formatDay(daily[0].day, SHORT_DATE)}</span>
            <span>{$t('admin.stats_spark_today')}</span>
          </div>
          <ul class="visually-hidden">
            {#each daily as day (day.day)}
              <li>
                {$t('admin.stats_spark_day', {
                  date: formatDay(day.day, SHORT_DATE),
                  count: formatNumber(day.views),
                })}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if viewsAvailable}
        <div class="admin-stats__block">
          <div class="home-section__header admin-stats__header">
            <h4 class="admin-stats__title">{$t('admin.stats_most_viewed')}</h4>
            <div
              class="inventory-filter admin-stats__period"
              role="group"
              aria-label={$t('admin.stats_period_aria')}
            >
              {#each PERIODS as period (period.key)}
                <button
                  type="button"
                  class="inventory-filter__btn"
                  class:inventory-filter__btn--active={viewedPeriod === period.key}
                  aria-pressed={viewedPeriod === period.key}
                  onclick={() => (viewedPeriod = period.key)}
                >
                  {$t(period.labelKey)}
                </button>
              {/each}
            </div>
          </div>
          {#if mostViewed.length > 0}
            {@render rankList(mostViewed, (row) => categoryLabel(row.item.tag))}
          {:else}
            <p class="empty-state">{$t('admin.stats_most_viewed_empty')}</p>
          {/if}
        </div>
      {/if}

      <div class="admin-stats__block">
        <div class="home-section__header admin-stats__header">
          <h4 class="admin-stats__title">{$t('admin.stats_most_requested')}</h4>
        </div>
        {#if mostRequested.length > 0}
          {@render rankList(
            mostRequested,
            (row) =>
              `${categoryLabel(row.item.tag)} · ${$t('admin.stats_booked', { count: formatNumber(row.booked) })}`,
          )}
        {:else}
          <p class="empty-state">{$t('admin.stats_most_requested_empty')}</p>
        {/if}
      </div>

      <div class="admin-stats__block">
        <div class="home-section__header admin-stats__header">
          <h4 class="admin-stats__title">{$t('admin.stats_busiest_mentors')}</h4>
        </div>
        {#if busiestMentors.length > 0}
          {@render rankList(busiestMentors, (row) =>
            $t('admin.stats_completed', { count: formatNumber(row.completed) }),
          )}
        {:else}
          <p class="empty-state">{$t('admin.stats_busiest_mentors_empty')}</p>
        {/if}
      </div>

      {#if viewsAvailable}
        <div class="admin-stats__block">
          <div class="home-section__header admin-stats__header">
            <h4 class="admin-stats__title">{$t('admin.stats_quiet')}</h4>
          </div>
          <p class="admin-stats__intro">
            {$t('admin.stats_quiet_intro')}
            {#if quietSettling}
              {$t('admin.stats_quiet_settling', { date: formatDay(countingSince) })}
            {/if}
          </p>
          {#if quietItems.length > 0}
            <ul id="{uid}-quiet" class="admin-item-list admin-rank">
              {#each visibleQuiet as item (item.id)}
                <li class="admin-item-row admin-rank__row">
                  <span class="admin-rank__main">
                    {@render itemLink(item)}
                    <span class="admin-rank__meta">
                      {categoryLabel(item.tag)} · {$t('admin.stats_added_on', {
                        date: formatDay(libraryTodayKey(new Date(Number(item.createdAt)))),
                      })}
                    </span>
                  </span>
                </li>
              {/each}
            </ul>
            {#if quietItems.length > QUIET_PREVIEW}
              <button
                type="button"
                class="btn-header btn-header--secondary admin-stats__more"
                aria-expanded={showAllQuiet}
                aria-controls="{uid}-quiet"
                onclick={() => (showAllQuiet = !showAllQuiet)}
              >
                {showAllQuiet
                  ? $t('admin.stats_quiet_show_fewer')
                  : $t('admin.stats_quiet_show_all', { count: formatNumber(quietItems.length) })}
              </button>
            {/if}
          {:else}
            <p class="empty-state">{$t('admin.stats_quiet_empty')}</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>
