<script>
  import { INVENTORY_PATH, navigate } from '../lib/router.js';
  import { locale, t } from '../lib/i18n.js';
  import { getPrivacyPolicyHtml } from '../lib/privacy-policy.js';

  let content = $state();

  const policyHtml = $derived(getPrivacyPolicyHtml($locale));

  $effect(() => {
    const element = content;
    element?.addEventListener('click', handleContentClick);
    return () => element?.removeEventListener('click', handleContentClick);
  });

  function goToInventory(event) {
    event.preventDefault();
    navigate(INVENTORY_PATH);
  }

  // Keep in-site links in the policy (e.g. /about) on the SPA router.
  function handleContentClick(event) {
    const link = event.target.closest?.('a[href^="/"]');
    if (!link || event.defaultPrevented || event.button !== 0) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(link.getAttribute('href'));
  }
</script>

<main id="main-content" class="container privacy-page">
  <header class="page-header">
    <h1>{$t('privacy.heading')}</h1>
    <p class="subtitle">{$t('privacy.subtitle')}</p>
    <p class="page-header__back">
      <a href={INVENTORY_PATH} class="page-header__back-link" onclick={goToInventory}>
        {$t('privacy.back_to_inventory')}
      </a>
    </p>
  </header>

  <article class="privacy-content" bind:this={content}>
    {@html policyHtml}
  </article>
</main>
