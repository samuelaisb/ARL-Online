<script>
  import { authReady, isApathyAdmin, session } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { INVENTORY_PATH, navigate } from '../lib/router.js';
  import { t } from '../lib/i18n.js';
  import AdminPanel from './AdminPanel.svelte';
  import Skeleton from './Skeleton.svelte';

  let {
    items = [],
    loading = false,
    loadError = '',
    onAddItem,
    onItemRemoved,
    onItemUpdated,
    onOpenLogin,
    onOpenRegister,
  } = $props();

  function goToInventory(event) {
    event.preventDefault();
    navigate(INVENTORY_PATH);
  }
</script>

<main id="main-content" class="container admin-page">
  <!-- The band is there from the first frame; only what's inside it changes while
       sign-in loads. -->
  <header class="page-header">
    {#if !supabaseConfigured}
      <h1>{$t('admin.not_available_title')}</h1>
      <p class="page-intro">{$t('admin.not_available_message')}</p>
    {:else if !$authReady}
      <Skeleton variant="page" gate label={$t('auth.loading')} />
    {:else if !$session}
      <h1>{$t('admin.sign_in_required_title')}</h1>
      <p class="page-intro">{$t('admin.sign_in_required_message')}</p>
      <div class="page-header__actions">
        <button type="button" class="btn-header btn-header--secondary" onclick={onOpenLogin}>
          {$t('auth.log_in')}
        </button>
        <button type="button" class="btn-header btn-header--primary" onclick={onOpenRegister}>
          {$t('auth.register')}
        </button>
      </div>
    {:else if !isApathyAdmin($session)}
      <h1>{$t('admin.access_denied_title')}</h1>
      <p class="page-intro">{$t('admin.access_denied_message')}</p>
    {:else}
      <h1>{$t('admin.heading')}</h1>
      <p class="subtitle">{$t('admin.copy')}</p>
    {/if}
    <p class="page-header__back">
      <a href={INVENTORY_PATH} class="page-header__back-link" onclick={goToInventory}>{$t('admin.back_to_inventory')}</a>
    </p>
  </header>

  {#if supabaseConfigured && $authReady && $session && isApathyAdmin($session)}
    <AdminPanel {items} {loading} {loadError} {onAddItem} {onItemRemoved} {onItemUpdated} />
  {/if}
</main>
