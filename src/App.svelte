<script>
  import { onMount } from 'svelte';
  import { loadInventoryItems } from './lib/inventory.js';
  import { locale, t } from './lib/i18n.js';
  import {
    isAboutRoute,
    isAccountRoute,
    isAdminRoute,
    isHowThisWorksRoute,
    isInventoryHomePath,
    isItemDetailRoute,
    path,
  } from './lib/router.js';
  import {
    applyHreflangTags,
    applySeoTags,
    clearRobotsMeta,
    getFaqJsonLd,
    getItemSeoConfig,
    getOrganizationJsonLd,
    getProductJsonLd,
    getSeoForRoute,
    getSiteOrigin,
    removeJsonLd,
    setRobotsMeta,
    upsertJsonLd,
  } from './lib/seo.js';
  import InventoryPanel from './components/InventoryPanel.svelte';
  import SiteNav from './components/SiteNav.svelte';
  import AddItemModal from './components/AddItemModal.svelte';
  import QuoteFooter from './components/QuoteFooter.svelte';
  import HeaderAuth from './components/HeaderAuth.svelte';
  import LocaleSwitcher from './components/LocaleSwitcher.svelte';
  import KimchiNotification from './components/KimchiNotification.svelte';

  let items = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let itemDetailSeoItem = $state(null);
  let reserveSuccessTick = $state({ id: null, at: 0 });

  let addItemModal;
  let headerAuth = $state();

  const onAdminPage = $derived(isAdminRoute($path));
  const onHowThisWorksPage = $derived(isHowThisWorksRoute($path));
  const onAboutPage = $derived(isAboutRoute($path));
  const onAccountPage = $derived(isAccountRoute($path));
  const onItemDetailPage = $derived(isItemDetailRoute($path));
  const onInventoryPage = $derived(isInventoryHomePath($path));

  async function refreshInventory() {
    loadError = '';
    loading = true;

    try {
      items = await loadInventoryItems();
    } catch (error) {
      loadError = error.message || $t('inventory.load_error');
      items = [];
    } finally {
      loading = false;
    }
  }

  function handleItemCreated(item) {
    items = [item, ...items];
  }

  function handleItemRemoved(id) {
    items = items.filter((item) => item.id !== id);
  }

  function handleItemUpdated(updatedItem) {
    items = items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
    if (itemDetailSeoItem?.id === updatedItem.id) {
      itemDetailSeoItem = updatedItem;
    }
  }

  function handleItemDetailLoaded(loadedItem) {
    itemDetailSeoItem = loadedItem;
  }

  function handleReserveSuccess(detail) {
    const updatedItem = detail?.item;
    reserveSuccessTick = {
      id: updatedItem?.id ?? null,
      at: Date.now(),
      pending: detail?.reservation?.status === 'pending',
    };
    if (updatedItem) {
      handleItemUpdated(updatedItem);
    }
  }

  function openAddItemModal() {
    addItemModal?.open();
  }

  function openRegisterFromReserve() {
    headerAuth?.openRegister();
  }

  function openLoginFromReserve() {
    headerAuth?.openLogin();
  }

  function trackPlausiblePageview() {
    if (typeof window.plausible === 'function') {
      window.plausible('pageview', { u: window.location.href });
    }
  }

  function trackGtagPageview() {
    if (typeof window.gtag === 'function') {
      window.gtag('config', 'G-5VERECD6ZJ', {
        page_path: window.location.pathname + window.location.search,
      });
    }
  }

  $effect(() => {
    const currentPath = $path;
    const currentLocale = $locale;
    const origin = getSiteOrigin();

    if (onItemDetailPage && itemDetailSeoItem) {
      const seo = getItemSeoConfig(itemDetailSeoItem, currentLocale, origin);
      clearRobotsMeta();
      applySeoTags(seo);
      applyHreflangTags(currentPath, origin);
      upsertJsonLd('organization', getOrganizationJsonLd(origin));
      upsertJsonLd('product', getProductJsonLd(itemDetailSeoItem, origin));
      removeJsonLd('faq');
      return;
    }

    const seo = getSeoForRoute(currentPath, currentLocale);
    removeJsonLd('product');

    if (seo.noindex) {
      setRobotsMeta('noindex, nofollow');
      removeJsonLd('organization');
      removeJsonLd('faq');
    } else {
      clearRobotsMeta();
      upsertJsonLd('organization', getOrganizationJsonLd(origin));

      if (currentPath === '/howthisworks') {
        const faqJsonLd = getFaqJsonLd(currentLocale);
        if (faqJsonLd) {
          upsertJsonLd('faq', faqJsonLd);
        } else {
          removeJsonLd('faq');
        }
      } else {
        removeJsonLd('faq');
      }
    }

    applySeoTags(seo);
    applyHreflangTags(currentPath, origin);
  });

  $effect(() => {
    $path;
    trackPlausiblePageview();
    trackGtagPageview();
  });

  onMount(() => {
    refreshInventory();
  });
</script>

<div class="app">
  <a class="skip-link" href="#main-content">{$t('site.skip_to_content')}</a>

  <div class="site-psa-banner">
    <a
      class="site-psa-banner__link"
      href={$t('site.psa_link')}
      target="_blank"
      rel="noopener noreferrer"
    >
      {$t('site.psa_text')}
    </a>
  </div>

  <header class="site-header">
    <a class="site-header__brand" href="/" aria-label={$t('site.brand_home_aria')}>
      <img
        class="site-header__logo"
        src="/assets/brand/apathy-is-boring-logo.png"
        alt={$t('site.brand_name')}
        width="240"
        height="64"
      />
    </a>
    <SiteNav />
    <div class="site-header__actions">
      <HeaderAuth bind:this={headerAuth} />
      <LocaleSwitcher />
    </div>
  </header>

  <div class="app-body">
    {#if onAdminPage}
      {#await import('./components/AdminPage.svelte') then { default: AdminPage }}
        <AdminPage
          {items}
          {loading}
          {loadError}
          onAddItem={openAddItemModal}
          onItemRemoved={handleItemRemoved}
          onItemUpdated={handleItemUpdated}
          onOpenLogin={openLoginFromReserve}
          onOpenRegister={openRegisterFromReserve}
        />
      {/await}
    {:else if onHowThisWorksPage}
      {#await import('./components/HowThisWorksPage.svelte') then { default: HowThisWorksPage }}
        <HowThisWorksPage />
      {/await}
    {:else if onAboutPage}
      {#await import('./components/AboutPage.svelte') then { default: AboutPage }}
        <AboutPage />
      {/await}
    {:else if onAccountPage}
      {#await import('./components/AccountPage.svelte') then { default: AccountPage }}
        <AccountPage
          onOpenLogin={openLoginFromReserve}
          onOpenRegister={openRegisterFromReserve}
        />
      {/await}
    {:else if onInventoryPage || onItemDetailPage}
      <main id="main-content" class="container">
        <header class="page-header">
          <h1>{$t('site.title')}</h1>
          <p class="subtitle">{$t('site.subtitle')}</p>
          <p class="page-intro">{$t('site.intro')}</p>
          <p class="page-intro page-intro--extended">{$t('site.intro_extended')}</p>
        </header>

        <InventoryPanel
          items={items}
          loading={loading}
          loadError={loadError}
        />
      </main>
    {/if}
  </div>
</div>

{#if onItemDetailPage}
  {#await import('./components/ItemDetailPage.svelte') then { default: ItemDetailPage }}
    <ItemDetailPage
      {reserveSuccessTick}
      onItemUpdated={handleItemUpdated}
      onItemLoaded={handleItemDetailLoaded}
      onReserveSuccess={handleReserveSuccess}
      onOpenRegister={openRegisterFromReserve}
      onOpenLogin={openLoginFromReserve}
    />
  {/await}
{/if}

<QuoteFooter />

<aside class="site-attribution" aria-label={$t('site.attribution_aria')}>
  <p class="site-attribution__text">
    {$t('site.attribution_text')}
  </p>
  <a
    class="site-attribution__logo-link"
    href="https://www.fesplanet.org"
    target="_blank"
    rel="noopener noreferrer"
    aria-label={$t('site.attribution_link_aria')}
  >
    <img
      class="site-attribution__logo"
      src="/assets/brand/fes-logo.webp"
      alt={$t('site.fes_name')}
      width="120"
      height="40"
    />
  </a>
</aside>

<AddItemModal bind:this={addItemModal} oncreated={handleItemCreated} />

<KimchiNotification />
