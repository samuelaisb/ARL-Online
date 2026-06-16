<script>
  import { authReady, isApathyAdmin, session, signOut } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { navigate } from '../lib/router.js';
  import { t, translateKey } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';

  let { onOpenLogin, onOpenRegister } = $props();

  let signingOut = $state(false);
  let signOutError = $state('');

  function goHome(event) {
    event.preventDefault();
    navigate('/');
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
</script>

<main id="main-content" class="container account-page">
  <p class="account-page__back">
    <a href="/" class="account-page__back-link" onclick={goHome}>
      {$t('account.back_to_inventory')}
    </a>
  </p>

  {#if !supabaseConfigured}
    <div class="admin-access">
      <h1 class="admin-access__title">{$t('account.not_available_title')}</h1>
      <p class="admin-access__message">{$t('account.not_available_message')}</p>
    </div>
  {:else if !$authReady}
    <p class="admin-status" role="status">{$t('auth.loading')}</p>
  {:else if !$session}
    <div class="admin-access">
      <h1 class="admin-access__title">{$t('account.sign_in_required_title')}</h1>
      <p class="admin-access__message">{$t('account.sign_in_required_message')}</p>
      <div class="admin-access__actions">
        <button type="button" class="btn-header btn-header--secondary" onclick={onOpenLogin}>
          {$t('auth.log_in')}
        </button>
        <button type="button" class="btn-header btn-header--primary" onclick={onOpenRegister}>
          {$t('auth.register')}
        </button>
      </div>
    </div>
  {:else}
    <header class="page-header">
      <h1>{$t('account.heading')}</h1>
    </header>

    <section class="account-panel" aria-labelledby="account-email-heading">
      <h2 id="account-email-heading" class="visually-hidden">{$t('auth.email')}</h2>
      <p class="account-panel__email">{$session.user.email}</p>

      <div class="account-panel__actions">
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
      </div>

      {#if signOutError}
        <p class="account-panel__error" role="alert">{signOutError}</p>
      {/if}
    </section>
  {/if}
</main>
