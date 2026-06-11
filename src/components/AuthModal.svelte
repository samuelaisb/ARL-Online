<script>
  import { signInWithEmail, signUpWithEmail } from '../lib/auth.js';
  import { t } from '../lib/i18n.js';

  let dialog = $state();
  let activeMode = $state('login');
  let email = $state('');
  let password = $state('');
  let submitting = $state(false);
  let formStatus = $state('');
  let formStatusType = $state('');

  export function open(nextMode = 'login') {
    activeMode = nextMode;
    email = '';
    password = '';
    formStatus = '';
    formStatusType = '';
    dialog?.showModal();
  }

  export function close() {
    dialog?.close();
  }

  function clearFormStatus() {
    formStatus = '';
    formStatusType = '';
  }

  function showFormStatus(message, type) {
    formStatus = message;
    formStatusType = type;
  }

  function handleCancel(event) {
    event.preventDefault();
    close();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormStatus();

    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      showFormStatus($t('auth.enter_email_password'), 'error');
      return;
    }

    if (password.length < 6) {
      showFormStatus($t('auth.password_min_length'), 'error');
      return;
    }

    submitting = true;

    try {
      if (activeMode === 'register') {
        const { session: newSession } = await signUpWithEmail(trimmedEmail, password);
        if (!newSession) {
          showFormStatus($t('auth.account_created_check_email'), 'success');
          activeMode = 'login';
          password = '';
          return;
        }
      } else {
        await signInWithEmail(trimmedEmail, password);
      }

      close();
    } catch (error) {
      showFormStatus(error.message || $t('auth.auth_failed'), 'error');
    } finally {
      submitting = false;
    }
  }

  function switchMode(nextMode) {
    activeMode = nextMode;
    clearFormStatus();
    password = '';
  }
</script>

<dialog bind:this={dialog} class="modal" oncancel={handleCancel}>
  <form method="dialog" novalidate onsubmit={handleSubmit}>
    <header class="modal-header">
      <h2>{activeMode === 'register' ? $t('auth.create_account') : $t('auth.log_in')}</h2>
      <button type="button" class="icon-btn" aria-label={$t('auth.close_aria')} onclick={close}>
        &times;
      </button>
    </header>

    <label for="auth-email">{$t('auth.email')}</label>
    <input
      id="auth-email"
      name="email"
      type="email"
      autocomplete="email"
      placeholder={$t('auth.email_placeholder')}
      required
      bind:value={email}
    />

    <label for="auth-password">{$t('auth.password')}</label>
    <input
      id="auth-password"
      name="password"
      type="password"
      autocomplete={activeMode === 'register' ? 'new-password' : 'current-password'}
      placeholder="••••••••"
      required
      bind:value={password}
    />

    {#if formStatus}
      <p class="status {formStatusType}" role="status" aria-live="polite">
        {formStatus}
      </p>
    {/if}

    <div class="modal-actions">
      <button type="button" class="btn-secondary" onclick={close}>{$t('auth.cancel')}</button>
      <button type="submit" class="btn-primary" disabled={submitting}>
        {#if submitting}
          {activeMode === 'register' ? $t('auth.creating') : $t('auth.logging_in')}
        {:else}
          {activeMode === 'register' ? $t('auth.create_account') : $t('auth.log_in')}
        {/if}
      </button>
    </div>

    <p class="auth-modal-switch">
      {#if activeMode === 'register'}
        {$t('auth.already_have_account')}
        <button type="button" class="link-btn" onclick={() => switchMode('login')}>{$t('auth.log_in')}</button>
      {:else}
        {$t('auth.need_account')}
        <button type="button" class="link-btn" onclick={() => switchMode('register')}>{$t('auth.register')}</button>
      {/if}
    </p>
  </form>
</dialog>
