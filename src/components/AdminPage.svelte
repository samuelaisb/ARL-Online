<script>
  import { authReady, isApathyAdmin, session } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { navigate } from '../lib/router.js';
  import { t } from '../lib/i18n.js';
  import AdminPanel from './AdminPanel.svelte';

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

  function goHome(event) {
    event.preventDefault();
    navigate('/');
  }
</script>

<main id="main-content" class="container admin-page">
  <p class="admin-page__back">
    <a href="/" class="admin-page__back-link" onclick={goHome}>{$t('admin.back_to_inventory')}</a>
  </p>

  {#if !supabaseConfigured}
    <div class="admin-access">
      <h1 class="admin-access__title">{$t('admin.not_available_title')}</h1>
      <p class="admin-access__message">{$t('admin.not_available_message')}</p>
    </div>
  {:else if !$authReady}
    <p class="admin-status" role="status">{$t('auth.loading')}</p>
  {:else if !$session}
    <div class="admin-access">
      <h1 class="admin-access__title">{$t('admin.sign_in_required_title')}</h1>
      <p class="admin-access__message">{$t('admin.sign_in_required_message')}</p>
      <div class="admin-access__actions">
        <button type="button" class="btn-header btn-header--secondary" onclick={onOpenLogin}>
          {$t('auth.log_in')}
        </button>
        <button type="button" class="btn-header btn-header--primary" onclick={onOpenRegister}>
          {$t('auth.register')}
        </button>
      </div>
    </div>
  {:else if !isApathyAdmin($session)}
    <div class="admin-access">
      <h1 class="admin-access__title">{$t('admin.access_denied_title')}</h1>
      <p class="admin-access__message">{$t('admin.access_denied_message')}</p>
    </div>
  {:else}
    <header class="page-header">
      <h1>{$t('admin.heading')}</h1>
      <p class="subtitle">{$t('admin.copy')}</p>
    </header>

    <AdminPanel {items} {loading} {loadError} {onAddItem} {onItemRemoved} {onItemUpdated} />
  {/if}
</main>
