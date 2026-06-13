<script>
  import { onMount } from 'svelte';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { authReady, initAuth, isApathyAdmin, session, signOut } from '../lib/auth.js';
  import { navigate } from '../lib/router.js';
  import { t, translateKey } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import AuthModal from './AuthModal.svelte';

  let authModal = $state();
  let signingOut = $state(false);
  let signOutError = $state('');

  onMount(() => {
    initAuth();
  });

  export function openLogin() {
    authModal?.open('login');
  }

  export function openRegister() {
    authModal?.open('register');
  }

  function openAdmin(event) {
    event.preventDefault();
    navigate('/admin');
  }

  async function handleSignOut() {
    signOutError = '';
    signingOut = true;

    try {
      await signOut();
      notify(translateKey('kimchi.signed_out'));
    } catch (error) {
      signOutError = error.message || $t('auth.sign_out_error');
    } finally {
      signingOut = false;
    }
  }

  function handleRegisterClick() {
    notify(translateKey('kimchi.register_click'));
    openRegister();
  }
</script>

{#if supabaseConfigured}
  <div class="header-auth">
    {#if !$authReady}
      <span class="header-auth__loading" aria-live="polite">{$t('auth.loading')}</span>
    {:else if $session}
      <span class="header-auth__email" title={$session.user.email}>{$session.user.email}</span>
      {#if isApathyAdmin($session)}
        <a href="/admin" class="btn-header btn-header--secondary" onclick={openAdmin}>
          {$t('auth.admin')}
        </a>
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
      <button type="button" class="btn-header btn-header--primary" onclick={handleRegisterClick}>
        {$t('auth.register')}
      </button>
    {/if}
  </div>

  <AuthModal bind:this={authModal} />
{/if}
