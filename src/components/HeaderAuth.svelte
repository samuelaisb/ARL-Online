<script>
  import { onMount, tick } from 'svelte';
  import { supabaseConfigured } from '../lib/supabase.js';
  import {
    authReady,
    authRedirectError,
    authRedirectFromPasswordReset,
    initAuth,
    session,
    signOut,
  } from '../lib/auth.js';
  import { navigate } from '../lib/router.js';
  import { t } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import AuthModal from './AuthModal.svelte';
  import BusyLabel from './BusyLabel.svelte';
  import CompleteSignupModal from './CompleteSignupModal.svelte';
  import SetPasswordModal from './SetPasswordModal.svelte';

  const SIGN_OUT_FAILED_DURATION = 8000;

  let authModal = $state();
  let signOutButton = $state();
  let signingOut = $state(false);
  // The last sign-out failed and the session is still here. Shown in the header as well
  // as by Kimchi: she may be asleep, and on a shared computer this must not go unseen.
  let signOutFailed = $state(false);

  // Signed out some other way (another tab, the account page): drop a stale error.
  $effect(() => {
    if (!$session) {
      signOutFailed = false;
    }
  });

  onMount(() => {
    initAuth().then(({ passwordResetLinkFailed }) => {
      // Expired or already-used reset link: go straight to requesting a new one.
      if (passwordResetLinkFailed) {
        authModal?.open('reset', $t('auth.reset_link_expired'));
      }
    });
    if (authRedirectError && !authRedirectFromPasswordReset) {
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
    notify({ textKey: 'kimchi.register_click' });
    openRegister();
  }

  async function handleSignOut() {
    signingOut = true;
    signOutFailed = false;

    try {
      await signOut();
      notify({ textKey: 'kimchi.signed_out' });
    } catch (error) {
      console.error('Sign out failed:', error);
      signOutFailed = true;
      notify({ textKey: 'kimchi.sign_out_failed' }, SIGN_OUT_FAILED_DURATION);
    } finally {
      signingOut = false;
    }

    if (signOutFailed) {
      // The button was disabled while the attempt ran, which can drop focus to <body>.
      // Put it back on Sign out so a keyboard user can try again.
      await tick();
      if (!document.activeElement || document.activeElement === document.body) {
        signOutButton?.focus();
      }
    }
  }
</script>

{#if supabaseConfigured}
  <div class="header-auth" class:header-auth--has-error={signOutFailed && $session}>
    {#if !$authReady}
      <!-- Two pills the size of the buttons, so the header doesn't jump. The text is
           not a live region: the account and admin gates announce their own wait. -->
      <span class="header-auth__skeleton skeleton skeleton--gate" aria-hidden="true">
        <span class="bone header-auth__bone"></span>
        <span class="bone header-auth__bone header-auth__bone--wide"></span>
      </span>
      <span class="visually-hidden">{$t('auth.loading')}</span>
    {:else if $session}
      <button type="button" class="btn-header btn-header--secondary" onclick={openAccount}>
        {$t('auth.view_account')}
      </button>
      <button
        bind:this={signOutButton}
        type="button"
        class="btn-header btn-header--secondary"
        disabled={signingOut}
        onclick={handleSignOut}
      >
        <BusyLabel
          compact
          label={$t('auth.sign_out')}
          busyLabel={$t('auth.signing_out')}
          busy={signingOut}
        />
      </button>
      {#if signOutFailed}
        <p class="header-auth__error" role="alert">{$t('auth.sign_out_error')}</p>
      {/if}
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
    <SetPasswordModal />
  </div>
{/if}
