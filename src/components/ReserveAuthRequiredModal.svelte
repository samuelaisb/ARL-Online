<script>
  import { t } from '../lib/i18n.js';

  let { onSignUp, onLogIn } = $props();

  let dialog = $state();

  export function open() {
    dialog?.showModal();
  }

  export function close() {
    dialog?.close();
  }

  function handleCancel(event) {
    event.preventDefault();
    close();
  }

  function handleSignUp() {
    close();
    onSignUp?.();
  }

  function handleLogIn() {
    close();
    onLogIn?.();
  }
</script>

<dialog bind:this={dialog} class="modal" oncancel={handleCancel}>
  <div class="modal-body">
    <header class="modal-header">
      <h2>{$t('auth.reserve_requires_account_title')}</h2>
      <button type="button" class="icon-btn" aria-label={$t('auth.close_aria')} onclick={close}>
        &times;
      </button>
    </header>

    <p class="status error" role="alert">{$t('auth.reserve_requires_account_message')}</p>

    <div class="modal-actions">
      <button type="button" class="btn-secondary" onclick={close}>{$t('auth.cancel')}</button>
      <button type="button" class="btn-primary" onclick={handleSignUp}>{$t('auth.register')}</button>
    </div>

    <p class="auth-modal-switch">
      {$t('auth.already_have_account')}
      <button type="button" class="link-btn" onclick={handleLogIn}>{$t('auth.log_in')}</button>
    </p>
  </div>
</dialog>
