<script>
  import { signInWithEmail, signUpWithEmail } from '../lib/auth.js';
  import { t } from '../lib/i18n.js';
  import MemberAgreementModal from './MemberAgreementModal.svelte';

  let dialog = $state();
  let agreementModal = $state();
  let activeMode = $state('login');
  let email = $state('');
  let password = $state('');
  let contractSigned = $state(false);
  let emailUpdatesOptIn = $state(false);
  let submitting = $state(false);
  let formStatus = $state('');
  let formStatusType = $state('');

  function resetRegisterState() {
    contractSigned = false;
    emailUpdatesOptIn = false;
  }

  export function open(nextMode = 'login') {
    activeMode = nextMode;
    email = '';
    password = '';
    formStatus = '';
    formStatusType = '';
    resetRegisterState();
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

  function openAgreement() {
    agreementModal?.open();
  }

  function handleAgreementSigned() {
    contractSigned = true;
    clearFormStatus();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormStatus();

    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      showFormStatus($t('auth.enter_email_password'), 'error');
      return;
    }

    if (password.length < 8) {
      showFormStatus($t('auth.password_min_length'), 'error');
      return;
    }

    if (activeMode === 'register' && !contractSigned) {
      showFormStatus($t('auth.contract_required'), 'error');
      return;
    }

    submitting = true;

    try {
      if (activeMode === 'register') {
        const { session: newSession } = await signUpWithEmail(trimmedEmail, password, {
          signedMemberAgreement: true,
          emailUpdatesOptIn,
        });
        if (!newSession) {
          showFormStatus($t('auth.account_created_check_email'), 'success');
          activeMode = 'login';
          password = '';
          resetRegisterState();
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
    if (nextMode === 'register') {
      resetRegisterState();
    }
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

    {#if activeMode === 'register'}
      <div class="auth-contract">
        {#if contractSigned}
          <p class="auth-contract-signed" role="status">
            <span class="auth-contract-signed__icon" aria-hidden="true">✓</span>
            {$t('auth.contract_signed')}
          </p>
        {:else}
          <button type="button" class="btn-sign-contract" onclick={openAgreement}>
            {$t('auth.sign_contract')}
          </button>
        {/if}
      </div>

      <label class="auth-opt-in">
        <input
          type="checkbox"
          name="email-updates-opt-in"
          bind:checked={emailUpdatesOptIn}
        />
        <span>{$t('auth.email_updates_opt_in')}</span>
      </label>
    {/if}

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

<MemberAgreementModal bind:this={agreementModal} onagreed={handleAgreementSigned} />
