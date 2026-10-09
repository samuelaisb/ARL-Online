<script module>
  // A random rank per item, kept for the whole page load. HomePage remounts on every
  // visit, so this keeps the same picks when someone opens one and comes back.
  const itemRanks = new Map();

  function itemRank(id) {
    if (!itemRanks.has(id)) {
      itemRanks.set(id, Math.random());
    }
    return itemRanks.get(id);
  }
</script>

<script>
  import LoadingStatus from './LoadingStatus.svelte';
  import { session } from '../lib/auth.js';
  import { splitExpertiseCopy } from '../lib/expertise-fields.js';
  import { t } from '../lib/i18n.js';
  import { INVENTORY_TAGS } from '../lib/inventory.js';
  import { revealOnLoad } from '../lib/motion.js';
  import {
    categoryToPath,
    isPlainLeftClick,
    itemToPath,
    navigateToItem,
    navigateToPage,
  } from '../lib/router.js';

  let { items, loading, loadError = '', onOpenRegister } = $props();

  const FEATURED_EXPERT_COUNT = 4;

  // The sections under the experts, in INVENTORY_TAGS order. There are only a couple of
  // rooms, so they get two wide photos instead of four tiles.
  const SHELVES = [
    { tag: 'equipment', count: 4 },
    { tag: 'books', count: 4 },
    { tag: 'rooms', count: 2 },
  ];

  /** `count` items of `tag` in this page load's random order, one per title (the
   *  catalogue has a few copies of the same thing). */
  function pickFeatured(tag, count) {
    const titles = new Set();
    return items
      .filter((item) => item.tag === tag)
      .sort((a, b) => itemRank(a.id) - itemRank(b.id))
      .filter((item) => {
        const title = item.title?.trim().toLowerCase() || item.id;
        if (titles.has(title)) {
          return false;
        }
        titles.add(title);
        return true;
      })
      .slice(0, count);
  }

  const featuredExperts = $derived(pickFeatured('expertise', FEATURED_EXPERT_COUNT));
  const shelves = $derived(
    SHELVES.map((shelf) => ({ ...shelf, items: pickFeatured(shelf.tag, shelf.count) })),
  );

  const nameKeys = {
    equipment: 'inventory.filter_equipment',
    books: 'inventory.filter_books',
    rooms: 'inventory.filter_rooms',
    expertise: 'inventory.filter_expertise',
  };

  function openCategory(event, tag) {
    if (!isPlainLeftClick(event)) {
      return;
    }

    event.preventDefault();
    navigateToPage(categoryToPath(tag));
  }

  function openItem(event, item) {
    if (!isPlainLeftClick(event)) {
      return;
    }

    event.preventDefault();
    navigateToItem(item);
  }
</script>

<main id="main-content" class="container home-page">
  <header class="page-header home-page__header">
    <h1 tabindex="-1">{$t('home.heading')}</h1>
    <p class="page-intro">{$t('home.intro')}</p>
    <p class="page-intro page-intro--extended">{$t('home.free')}</p>
  </header>

  {#if loadError}
    <!-- The inventory didn't load, so the sections below can't show. Kimchi says so too,
         unless she's asleep. -->
    <p class="status error" role="alert">{$t('home.load_error')}</p>
  {/if}

  <nav class="home-categories" aria-label={$t('home.categories_aria')}>
    <ul class="home-categories__list">
      {#each INVENTORY_TAGS as tag (tag)}
        <li>
          <a
            href={categoryToPath(tag)}
            class="home-category home-category--{tag}"
            onclick={(event) => openCategory(event, tag)}
          >
            <span class="home-category__icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="28"
                height="28"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                focusable="false"
              >
                {#if tag === 'equipment'}
                  <!-- Megaphone -->
                  <path d="M3 10.5v3a1.5 1.5 0 0 0 1.5 1.5H7l10 5V4L7 9H4.5A1.5 1.5 0 0 0 3 10.5Z" />
                  <path d="m7.5 15 1.4 4.6a1 1 0 0 0 1 .7h1.3a1 1 0 0 0 .9-1.3L11 15.8" />
                  <path d="M20.5 9.5a3.5 3.5 0 0 1 0 5" />
                {:else if tag === 'books'}
                  <!-- Open book -->
                  <path d="M12 7c-1.6-1.3-4-2-8-2v13c4 0 6.4.7 8 2" />
                  <path d="M12 7c1.6-1.3 4-2 8-2v13c-4 0-6.4.7-8 2" />
                  <path d="M12 7v13" />
                {:else if tag === 'rooms'}
                  <!-- Door -->
                  <path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21" />
                  <path d="M3 21h18" />
                  <path d="M14.5 12h.01" />
                {:else}
                  <!-- Speech bubbles -->
                  <path d="M15 9.5V5.5A1.5 1.5 0 0 0 13.5 4h-9A1.5 1.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13H6v3l3-3" />
                  <path d="M10.5 9.5h9A1.5 1.5 0 0 1 21 11v5.5a1.5 1.5 0 0 1-1.5 1.5H18v3l-3.5-3h-4a1.5 1.5 0 0 1-1.5-1.5V11a1.5 1.5 0 0 1 1.5-1.5Z" />
                {/if}
              </svg>
            </span>
            <span class="home-category__text">
              <span class="home-category__name">{$t(nameKeys[tag])}</span>
              <span class="home-category__description">{$t(`home.${tag}_description`)}</span>
            </span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  {#if loading || featuredExperts.length > 0}
    <section class="home-section" aria-labelledby="home-experts-heading">
      <div class="home-section__header">
        <h2 id="home-experts-heading" class="home-section__title">{$t('home.experts_heading')}</h2>
        <a
          href={categoryToPath('expertise')}
          class="home-section__link"
          onclick={(event) => openCategory(event, 'expertise')}
        >
          {$t('home.experts_all')}
        </a>
      </div>

      {#if loading}
        <ul class="home-experts skeleton" aria-hidden="true">
          {#each Array(FEATURED_EXPERT_COUNT) as _, index (index)}
            <li class="home-expert home-expert--placeholder skeleton-sheen">
              <span class="home-expert__photo"></span>
              <span class="bone home-expert__name-bone"></span>
              <span class="home-expert__topics-bones">
                <span class="bone bone--line"></span>
                <span class="bone bone--line"></span>
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <ul class="home-experts">
          {#each featuredExperts as expert (expert.id)}
            <li>
              <a class="home-expert" href={itemToPath(expert)} onclick={(event) => openItem(event, expert)}>
                {#if expert.image}
                  <img
                    {@attach revealOnLoad}
                    class="home-expert__photo"
                    src={expert.image}
                    alt=""
                    width="96"
                    height="96"
                    decoding="async"
                    loading="lazy"
                  />
                {:else}
                  <span class="home-expert__photo" aria-hidden="true"></span>
                {/if}
                <span class="home-expert__name">{expert.title}</span>
                <span class="home-expert__topics">{splitExpertiseCopy(expert).shortText}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#each shelves as shelf (shelf.tag)}
    {#if loading || shelf.items.length > 0}
      <section class="home-section home-shelf home-shelf--{shelf.tag}" aria-labelledby="home-{shelf.tag}-heading">
        <div class="home-section__header">
          <h2 id="home-{shelf.tag}-heading" class="home-section__title">{$t(`home.${shelf.tag}_heading`)}</h2>
          <a
            href={categoryToPath(shelf.tag)}
            class="home-section__link"
            onclick={(event) => openCategory(event, shelf.tag)}
          >
            {$t(`home.${shelf.tag}_all`)}
          </a>
        </div>

        {#if loading}
          <ul class="home-shelf__list skeleton" aria-hidden="true">
            {#each Array(shelf.count) as _, index (index)}
              <li class="home-item home-item--placeholder skeleton-sheen">
                <span class="home-item__frame"></span>
                <span class="bone bone--title home-item__title-bone"></span>
                {#if shelf.tag !== 'equipment'}
                  <span class="home-item__body-bones">
                    <span class="bone bone--line"></span>
                    <span class="bone bone--line"></span>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <ul class="home-shelf__list">
            {#each shelf.items as item (item.id)}
              <li>
                <a class="home-item" href={itemToPath(item)} onclick={(event) => openItem(event, item)}>
                  <span class="home-item__frame">
                    {#if item.image}
                      <img
                        {@attach revealOnLoad}
                        class="home-item__image"
                        src={item.image}
                        alt=""
                        decoding="async"
                        loading="lazy"
                      />
                    {/if}
                  </span>
                  <span class="home-item__title">{item.title}</span>
                  <!-- Equipment descriptions mostly repeat the product name. The
                       description is hidden from screen readers so the link is named by
                       its title (the clamp only hides it visually); the overlay has it. -->
                  {#if shelf.tag !== 'equipment' && item.body}
                    <span class="home-item__body" aria-hidden="true">{item.body}</span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/each}

  {#if loading}
    <LoadingStatus text={$t('home.loading')} />
  {/if}

  <!-- Who made the library is in the site footer, under this card. -->
  <div class="home-footer">
    <ol class="home-steps" aria-label={$t('home.steps_aria')}>
      <li class="home-step">
        <!-- Signed-out visitors can start here: the step opens the Register dialog. -->
        {#if $session}
          <span class="home-step__number" aria-hidden="true">1</span>
          {$t('home.step_account')}
        {:else}
          <button type="button" class="home-step__action" aria-haspopup="dialog" onclick={onOpenRegister}>
            <span class="home-step__number" aria-hidden="true">1</span>
            <span class="home-step__label">{$t('home.step_account')}</span>
          </button>
        {/if}
      </li>
      <li class="home-step">
        <span class="home-step__number" aria-hidden="true">2</span>
        {$t('home.step_browse')}
      </li>
    </ol>
  </div>
</main>
