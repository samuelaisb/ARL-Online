<script>
  import { onMount, tick } from 'svelte';
  import { loadInventoryItems } from './lib/inventory.js';
  import { locale, t } from './lib/i18n.js';
  import {
    getItemRouteParams,
    isAboutRoute,
    isAccountRoute,
    isAdminRoute,
    isCategoryPath,
    isHomeRoute,
    isHowThisWorksRoute,
    isItemDetailRoute,
    isKnownAppPath,
    isPlainLeftClick,
    isPrivacyRoute,
    navigateToPage,
    path,
  } from './lib/router.js';
  import { notifyWhenIdle } from './lib/notification-store.js';
  import {
    applyHreflangTags,
    applySeoTags,
    clearRobotsMeta,
    getFaqJsonLd,
    getItemSeoConfig,
    getNotFoundSeoConfig,
    getOrganizationJsonLd,
    getProductJsonLd,
    getSeoForRoute,
    getSiteOrigin,
    removeJsonLd,
    setRobotsMeta,
    upsertJsonLd,
  } from './lib/seo.js';
  import HomePage from './components/HomePage.svelte';
  import InventoryPanel from './components/InventoryPanel.svelte';
  import SiteNav from './components/SiteNav.svelte';
  import HeaderAuth from './components/HeaderAuth.svelte';
  import LocaleSwitcher from './components/LocaleSwitcher.svelte';
  import KimchiNotification from './components/KimchiNotification.svelte';
  import PageLoadError from './components/PageLoadError.svelte';
  import RouteProgress from './components/RouteProgress.svelte';

  let items = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let itemDetailSeoItem = $state(null);
  let itemDetailNotFound = $state(false);
  // URL the two values above belong to. The overlay mounts asynchronously, so right
  // after a navigation they still describe the previous route until it reports in.
  let itemDetailSeoPath = $state(null);
  let reserveSuccessTick = $state({ id: null, at: 0 });

  let addItemModal = $state();
  let headerAuth = $state();
  // Route we just left, so the overlay-close effect can tell an item → page change
  // apart from the initial load and other navigation. Not reactive on purpose.
  let previousPath = null;
  // Path whose <head> the server rendered, until the client applies tags of its own.
  // Not reactive on purpose: the SEO effect clears it.
  let serverSeoPath = $path;

  /** After the item overlay closes, Kimchi waits this long before pointing to /account. */
  const TRACK_REQUEST_DELAY_MS = 600;
  const TRACK_REQUEST_DURATION = 8000;
  const INVENTORY_LOAD_FAILED_DURATION = 8000;
  // A pending equipment, book or room request was sent from the item overlay, and
  // Kimchi hasn't yet said where to follow it. The reservation_sent bubble fires behind
  // the dialog's backdrop, so this one waits for the overlay to close. Once per page
  // load, spent only when the bubble shows. Not reactive on purpose.
  let trackRequestArmed = false;
  let trackRequestShown = false;
  // Bumped on every overlay close, so a delayed offer from an earlier close gives up.
  let trackRequestAttempt = 0;
  // Kimchi has mentioned the current inventory load failure. Reset by refreshInventory.
  let inventoryLoadNoticeShown = false;

  const onAdminPage = $derived(isAdminRoute($path));
  const onHowThisWorksPage = $derived(isHowThisWorksRoute($path));
  const onAboutPage = $derived(isAboutRoute($path));
  const onAccountPage = $derived(isAccountRoute($path));
  const onPrivacyPage = $derived(isPrivacyRoute($path));
  const onItemDetailPage = $derived(isItemDetailRoute($path));
  const onHomePage = $derived(isHomeRoute($path));
  const onInventoryPage = $derived(isCategoryPath($path));
  const onUnknownPage = $derived(!isKnownAppPath($path));

  async function refreshInventory() {
    loadError = '';
    loading = true;
    inventoryLoadNoticeShown = false;

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

  function handleMentorProfileSaved(profile) {
    if (!profile?.id) {
      return;
    }

    const existing = items.find((item) => item.id === profile.id);
    const publicItem = {
      id: profile.id,
      title: profile.title,
      body: profile.body,
      image: profile.image,
      createdAt: profile.createdAt,
      tag: profile.tag || 'expertise',
      slug: profile.slug,
      longBody: profile.longBody ?? null,
      reservations: existing?.reservations ?? [],
    };

    items = existing
      ? items.map((item) => (item.id === publicItem.id ? publicItem : item))
      : [publicItem, ...items];
  }

  function handleItemUpdated(updatedItem) {
    items = items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
    if (itemDetailSeoItem?.id === updatedItem.id) {
      itemDetailSeoItem = updatedItem;
    }
  }

  function handleItemDetailLoaded(loadedItem, { notFound = false, path: loadedPath } = {}) {
    // A response for a route we already left (slow fetch, overlay closed) is stale.
    if (loadedPath !== $path) {
      return;
    }

    itemDetailSeoItem = loadedItem;
    itemDetailNotFound = notFound;
    itemDetailSeoPath = loadedPath;
  }

  function handleReserveSuccess(detail) {
    const updatedItem = detail?.item;
    const pending = detail?.reservation?.status === 'pending';
    reserveSuccessTick = {
      id: updatedItem?.id ?? null,
      at: Date.now(),
      pending,
    };
    if (updatedItem) {
      handleItemUpdated(updatedItem);
    }

    // Consultation requests come through here too; their confirmation already names
    // the account page, so only equipment, books and rooms arm the /account pointer.
    const tag = updatedItem?.tag ?? getItemRouteParams($path)?.tag;
    if (pending && tag !== 'expertise' && !trackRequestShown) {
      trackRequestArmed = true;
    }
  }

  /**
   * The overlay closed after a pending request was sent from it: once the page has
   * settled, Kimchi points to /account. Skipped when the close lands on /account.
   */
  async function offerTrackRequest(routePath) {
    const attempt = ++trackRequestAttempt;
    if (isAccountRoute(routePath)) {
      trackRequestArmed = false;
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, TRACK_REQUEST_DELAY_MS));
    if (attempt !== trackRequestAttempt || !trackRequestArmed || $path !== routePath) {
      return;
    }

    // Waits out other bubbles (the request confirmation, a welcome) and any dialog.
    const id = await notifyWhenIdle(
      {
        link: {
          href: '/account',
          ctaKey: 'kimchi.track_request_cta',
          labelKey: 'kimchi.track_request_link',
        },
      },
      TRACK_REQUEST_DURATION,
    );
    // Not shown (asleep, page changed): stay armed for the next overlay close.
    if (id !== -1) {
      trackRequestArmed = false;
      trackRequestShown = true;
    }
  }

  // Logo and not-found link. A full reload here would also wake Kimchi and replay the greeting.
  function goHome(event) {
    if (!isPlainLeftClick(event)) {
      return;
    }

    event.preventDefault();
    navigateToPage('/');
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
    const itemReported = onItemDetailPage && itemDetailSeoPath === currentPath;
    const seoItem = itemReported ? itemDetailSeoItem : null;
    const itemNotFound = itemReported && itemDetailNotFound;

    if (seoItem) {
      const seo = getItemSeoConfig(seoItem, currentLocale, origin);
      clearRobotsMeta();
      applySeoTags(seo);
      applyHreflangTags(currentPath, origin);
      upsertJsonLd('organization', getOrganizationJsonLd(origin));
      upsertJsonLd('product', getProductJsonLd(seoItem, origin));
      removeJsonLd('faq');
      serverSeoPath = null;
      return;
    }

    // On the item URL the page was loaded at, keep the item tags the server injected
    // while the item loads (or after a load error) instead of the site defaults.
    // After a client-side navigation the head holds the previous page's tags, so
    // fall through to the route defaults until the item arrives.
    if (onItemDetailPage && !itemNotFound && currentPath === serverSeoPath) {
      return;
    }
    serverSeoPath = null;

    const seo =
      onUnknownPage || itemNotFound
        ? getNotFoundSeoConfig(currentPath, currentLocale)
        : getSeoForRoute(currentPath, currentLocale);
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

  // Closing the item overlay (X, Escape, backdrop, Back) unmounts its <dialog>,
  // which drops focus to <body>. Hand focus to the card that opens that item, or
  // else to the page's main heading.
  $effect(() => {
    const currentPath = $path;
    const closedItemPath =
      previousPath && isItemDetailRoute(previousPath) && !isItemDetailRoute(currentPath)
        ? previousPath
        : null;
    previousPath = currentPath;

    if (closedItemPath) {
      returnFocusAfterOverlay(closedItemPath, currentPath);
      if (trackRequestArmed) {
        offerTrackRequest(currentPath);
      }
    } else if (isAccountRoute(currentPath)) {
      // They found /account on their own: no need to point there any more.
      trackRequestArmed = false;
    }
  });

  // The inventory didn't load: on the homepage or a category grid, Kimchi says so,
  // once per failed load. Both pages also show the error inline (role="alert").
  // Each qualifying page tries again until the bubble shows; the previous wait was
  // cancelled by the page change (notifyWhenIdle).
  $effect(() => {
    $path;
    if (!loadError || inventoryLoadNoticeShown || !(onHomePage || onInventoryPage)) {
      return;
    }

    notifyWhenIdle({ textKey: 'kimchi.inventory_load_failed' }, INVENTORY_LOAD_FAILED_DURATION).then(
      (id) => {
        if (id !== -1) {
          inventoryLoadNoticeShown = true;
        }
      },
    );
  });

  function findOverlayReturnTarget(itemPath) {
    const cardLink = Array.from(
      document.querySelectorAll('.inventory-card__title-link, .home-expert, .home-item'),
    ).find(
      (link) => link.pathname === itemPath,
    );
    if (cardLink) {
      return cardLink;
    }

    const heading = document.querySelector('#main-content h1');
    if (heading && !heading.hasAttribute('tabindex')) {
      heading.setAttribute('tabindex', '-1');
    }
    return heading;
  }

  // Skip the scroll when the target is already on screen (above the FES badge's
  // scroll-padding); otherwise let focus() scroll it into view.
  function focusInView(element) {
    const rect = element.getBoundingClientRect();
    const bottomInset =
      parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0;
    const inView = rect.top >= 0 && rect.bottom <= window.innerHeight - bottomInset;
    element.focus({ preventScroll: inView });
  }

  async function returnFocusAfterOverlay(itemPath, routePath) {
    await tick();

    // Lazy pages (e.g. Back to /account) render once their chunk resolves, so poll
    // briefly. A timer, not requestAnimationFrame, which stalls in background tabs.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const active = document.activeElement;
      if ($path !== routePath || (active && active !== document.body && active.isConnected)) {
        return;
      }

      const target = findOverlayReturnTarget(itemPath);
      if (target) {
        focusInView(target);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // The item overlay is the main interaction, so fetch its chunk once the browser
  // is idle after the inventory loads: the first card click then opens it without
  // waiting on the network, and a tab left open across a deploy already holds it.
  // A failure here stays silent; the overlay's own import retries on click.
  function warmItemDetailChunk() {
    const load = () => import('./components/ItemDetailPage.svelte').catch(() => {});
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(load, { timeout: 3000 });
    } else {
      setTimeout(load, 1000);
    }
  }

  onMount(() => {
    refreshInventory().then(warmItemDetailChunk);
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
    <a class="site-header__brand" href="/" aria-label={$t('site.brand_home_aria')} onclick={goHome}>
      <img
        class="site-header__logo"
        src="/assets/brand/apathy-is-boring-wordmark.png"
        alt={$t('site.brand_name')}
        width="830"
        height="385"
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
      {#await import('./components/AdminPage.svelte')}
        <RouteProgress />
      {:then { default: AdminPage }}
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
      {:catch}
        <PageLoadError />
      {/await}
    {:else if onHowThisWorksPage}
      {#await import('./components/HowThisWorksPage.svelte')}
        <RouteProgress />
      {:then { default: HowThisWorksPage }}
        <HowThisWorksPage />
      {:catch}
        <PageLoadError />
      {/await}
    {:else if onAboutPage}
      {#await import('./components/AboutPage.svelte')}
        <RouteProgress />
      {:then { default: AboutPage }}
        <AboutPage />
      {:catch}
        <PageLoadError />
      {/await}
    {:else if onPrivacyPage}
      {#await import('./components/PrivacyPage.svelte')}
        <RouteProgress />
      {:then { default: PrivacyPage }}
        <PrivacyPage />
      {:catch}
        <PageLoadError />
      {/await}
    {:else if onAccountPage}
      {#await import('./components/AccountPage.svelte')}
        <RouteProgress />
      {:then { default: AccountPage }}
        <AccountPage
          onOpenLogin={openLoginFromReserve}
          onOpenRegister={openRegisterFromReserve}
          onProfileSaved={handleMentorProfileSaved}
        />
      {:catch}
        <PageLoadError />
      {/await}
    {:else if onHomePage}
      <HomePage {items} {loading} {loadError} />
    {:else if onInventoryPage || onItemDetailPage}
      <main id="main-content" class="container">
        <header class="page-header">
          <h1 class="brand-heading" tabindex="-1">{$t('site.title')}</h1>
          <p class="page-intro">{$t('site.intro')}</p>
        </header>

        <InventoryPanel
          items={items}
          loading={loading}
          loadError={loadError}
        />
      </main>
    {:else}
      <main id="main-content" class="container not-found-page">
        <header class="page-header">
          <h1 tabindex="-1">{$t('not_found.heading')}</h1>
          <p class="page-intro">{$t('not_found.body')}</p>
        </header>
        <p>
          <a href="/" class="not-found-page__back-link" onclick={goHome}>
            {$t('not_found.back_to_library')}
          </a>
        </p>
      </main>
    {/if}
  </div>
</div>

{#if onItemDetailPage}
  {#await import('./components/ItemDetailPage.svelte')}
    <RouteProgress />
  {:then { default: ItemDetailPage }}
    <ItemDetailPage
      {reserveSuccessTick}
      onItemUpdated={handleItemUpdated}
      onItemLoaded={handleItemDetailLoaded}
      onReserveSuccess={handleReserveSuccess}
      onOpenRegister={openRegisterFromReserve}
      onOpenLogin={openLoginFromReserve}
    />
  {:catch}
    <PageLoadError overlay />
  {/await}
{/if}

{#if onAdminPage}
  {#await import('./components/AddItemModal.svelte') then { default: AddItemModal }}
    <AddItemModal bind:this={addItemModal} oncreated={handleItemCreated} />
  {:catch}
    <!-- Loads alongside AdminPage, whose own {:catch} shows the reload notice. -->
  {/await}
{/if}

<KimchiNotification />
