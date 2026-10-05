<script>
  import { onMount } from 'svelte';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { authReady, authRedirectError, initAuth, session, signOut } from '../lib/auth.js';
  import { navigate } from '../lib/router.js';
  import { t, translateKey } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import AuthModal from './AuthModal.svelte';
  import CompleteSignupModal from './CompleteSignupModal.svelte';

  let authModal = $state();
  let signingOut = $state(false);

  onMount(() => {
    initAuth();
    if (authRedirectError) {
      authModal?.open('login', formatRedirectError(authRedirectError));
    }
  });

  /** Supabase redirect errors are English and technical; lead with a localized message. */
  function formatRedirectError(message) {
    if (/email/i.test(message) && /provider/i.test(message)) {
      return $t('auth.oauth_no_email');
    }
    return `${$t('auth.oauth_failed')} (${message})`;
  }

  export function openLogin() {
    authModal?.open('login');
  }

  export function openRegister() {
    authModal?.open('register');
  }

  function openAccount() {
    navigate('/account');
  }

  function handleRegisterClick() {
    notify(translateKey('kimchi.register_click'));
    openRegister();
  }

  async function handleSignOut() {
    signingOut = true;

    try {
      await signOut();
      notify(translateKey('kimchi.signed_out'));
    } catch (error) {
      console.error('Sign out failed:', error);
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
      <button type="button" class="btn-header btn-header--secondary" onclick={openAccount}>
        {$t('auth.view_account')}
      </button>
      <button
        type="button"
        class="btn-header btn-header--secondary"
        disabled={signingOut}
        onclick={handleSignOut}
      >
        {signingOut ? $t('auth.signing_out') : $t('auth.sign_out')}
      </button>
    {:else}
      <button type="button" class="btn-header btn-header--secondary" onclick={openLogin}>
        {$t('auth.log_in')}
      </button>
      <button type="button" class="btn-header btn-header--primary" onclick={handleRegisterClick}>
        {$t('auth.register')}
      </button>
    {/if}

    <AuthModal bind:this={authModal} />
    <CompleteSignupModal />
  </div>
{/if}
