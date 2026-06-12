<script>
  import { onMount } from 'svelte';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { authReady, initAuth, isApathyAdmin, session, signOut } from '../lib/auth.js';
  import { t } from '../lib/i18n.js';
  import AdminPanel from './AdminPanel.svelte';
  import AuthModal from './AuthModal.svelte';

  let {
    items = [],
    loading = false,
    loadError = '',
    onAddItem,
    onItemRemoved,
  } = $props();

  let authModal = $state();
  let signingOut = $state(false);
  let signOutError = $state('');
  let adminOpen = $state(false);
  let adminRoot = $state();

  onMount(() => {
    initAuth();

    function handleWindowClick(event) {
      if (adminOpen && adminRoot && !adminRoot.contains(event.target)) {
        adminOpen = false;
      }
    }

    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  });

  export function openLogin() {
    authModal?.open('login');
  }

  export function openRegister() {
    authModal?.open('register');
  }

  function toggleAdmin(event) {
    event.stopPropagation();
    adminOpen = !adminOpen;
  }

  function handleAddItem() {
    adminOpen = false;
    onAddItem?.();
  }

  async function handleSignOut() {
    signOutError = '';
    signingOut = true;
    adminOpen = false;

    try {
      await signOut();
    } catch (error) {
      signOutError = error.message || $t('auth.sign_out_error');
    } finally {
      signingOut = false;
    }
  }
</script>

{#if supabaseConfigured}
  <div class="header-auth">
    {#if !$authReady}
      <span class="header-auth__loading" aria-live="polite">{$t('auth.loading')}</span>
    {:else if $session}
      <span class="header-auth__email" title={$session.user.email}>{$session.user.email}</span>
      {#if isApathyAdmin($session)}
        <div class="header-admin" bind:this={adminRoot}>
          <button
            type="button"
            class="btn-header btn-header--secondary"
            aria-expanded={adminOpen}
            aria-controls="header-admin-menu"
            aria-haspopup="true"
            onclick={toggleAdmin}
          >
            {$t('auth.admin')}
          </button>
          {#if adminOpen}
            <div id="header-admin-menu" class="header-admin__dropdown">
              <AdminPanel
                variant="dropdown"
                {items}
                {loading}
                {loadError}
                onAddItem={handleAddItem}
                {onItemRemoved}
              />
            </div>
          {/if}
        </div>
      {/if}
      <button
        type="button"
        class="btn-header btn-header--secondary"
        disabled={signingOut}
        onclick={handleSignOut}
      >
        {signingOut ? $t('auth.signing_out') : $t('auth.sign_out')}
      </button>
      {#if signOutError}
        <p class="header-auth__error" role="alert">{signOutError}</p>
      {/if}
    {:else}
      <button type="button" class="btn-header btn-header--secondary" onclick={openLogin}>
        {$t('auth.log_in')}
      </button>
      <button type="button" class="btn-header btn-header--primary" onclick={openRegister}>
        {$t('auth.register')}
      </button>
    {/if}
  </div>

  <AuthModal bind:this={authModal} />
{/if}
