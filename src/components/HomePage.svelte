<script module>
  // A random rank per expert, kept for the whole page load. HomePage remounts on every
  // visit, so this keeps the same four experts when someone opens one and comes back.
  const expertRanks = new Map();

  function expertRank(id) {
    if (!expertRanks.has(id)) {
      expertRanks.set(id, Math.random());
    }
    return expertRanks.get(id);
  }
</script>

<script>
  import { splitExpertiseCopy } from '../lib/expertise-fields.js';
  import { t } from '../lib/i18n.js';
  import { INVENTORY_TAGS } from '../lib/inventory.js';
  import {
    categoryToPath,
    isPlainLeftClick,
    itemToPath,
    navigateToItem,
    navigateToPage,
  } from '../lib/router.js';

  let { items, loading } = $props();

  const FEATURED_EXPERT_COUNT = 4;

  const featuredExperts = $derived(
    items
      .filter((item) => item.tag === 'expertise')
      .sort((a, b) => expertRank(a.id) - expertRank(b.id))
      .slice(0, FEATURED_EXPERT_COUNT),
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

  function openExpert(event, expert) {
    if (!isPlainLeftClick(event)) {
      return;
    }

    event.preventDefault();
    navigateToItem(expert);
  }
</script>

<main id="main-content" class="container home-page">
  <header class="page-header home-page__header">
    <h1 class="brand-heading" tabindex="-1">{$t('home.heading')}</h1>
    <p class="page-intro">{$t('home.intro')}</p>
    <p class="page-intro page-intro--extended">{$t('home.free')}</p>
  </header>

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
        <ul class="home-experts" aria-hidden="true">
          {#each Array(FEATURED_EXPERT_COUNT) as _, index (index)}
            <li class="home-expert home-expert--placeholder">
              <span class="home-expert__photo"></span>
              <span class="home-expert__line"></span>
            </li>
          {/each}
        </ul>
      {:else}
        <ul class="home-experts">
          {#each featuredExperts as expert (expert.id)}
            <li>
              <a class="home-expert" href={itemToPath(expert)} onclick={(event) => openExpert(event, expert)}>
                {#if expert.image}
                  <img
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

  <footer class="home-footer">
    <ol class="home-steps" aria-label={$t('home.steps_aria')}>
      <li class="home-step">
        <span class="home-step__number" aria-hidden="true">1</span>
        {$t('home.step_account')}
      </li>
      <li class="home-step">
        <span class="home-step__number" aria-hidden="true">2</span>
        {$t('home.step_browse')}
      </li>
    </ol>

    <div class="home-partners">
      <span class="home-partners__item">
        <span class="home-partners__label">{$t('home.created_by')}</span>
        <a
          class="home-partners__link"
          href="https://www.fesplanet.org"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={$t('home.fes_link_aria')}
        >
          <img
            class="home-partners__logo"
            src="/assets/brand/fes-logo.webp"
            alt={$t('home.fes_name')}
            width="120"
            height="40"
          />
        </a>
      </span>
      <span class="home-partners__item">
        <span class="home-partners__label">{$t('home.run_by')}</span>
        <a
          class="home-partners__link"
          href="https://www.apathyisboring.com"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={$t('home.aisb_link_aria')}
        >
          <img
            class="home-partners__logo home-partners__logo--aisb"
            src="/assets/brand/apathy-is-boring-logo.png"
            alt={$t('site.brand_name')}
            width="64"
            height="64"
          />
        </a>
      </span>
    </div>
  </footer>
</main>
