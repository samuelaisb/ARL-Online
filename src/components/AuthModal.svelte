<script>
  import { tick } from 'svelte';
  import {
    OAUTH_PROVIDER_NAMES,
    PASSWORD_MIN_LENGTH,
    oauthProviders,
    passwordResetErrorKey,
    requestPasswordReset,
    signInWithEmail,
    signInWithOAuthProvider,
    signUpWithEmail,
  } from '../lib/auth.js';
  import { t } from '../lib/i18n.js';
  import MemberAgreementModal from './MemberAgreementModal.svelte';
  import OAuthProviderIcon from './OAuthProviderIcon.svelte';

  let dialog = $state();
  let agreementModal = $state();
  let emailInput = $state();
  let submitButton = $state();
  /** 'login' | 'register' | 'reset' (request a password-reset email). */
  let activeMode = $state('login');
  let email = $state('');
  let password = $state('');
  let contractSigned = $state(false);
  let emailUpdatesOptIn = $state(false);
  let submitting = $state(false);
  let oauthProvider = $state('');
  let formStatus = $state('');
  let formStatusType = $state('');
  /** Reset view: the status is about the email field (marked invalid and described by it). */
  let emailInvalid = $state(false);

  function resetRegisterState() {
    contractSigned = false;
    emailUpdatesOptIn = false;
  }

  /** `errorMessage` shows a failed OAuth / email-link redirect (or expired reset link) when the modal opens. */
  export async function open(nextMode = 'login', errorMessage = '') {
    activeMode = nextMode;
    email = '';
    password = '';
    clearFormStatus();
    oauthProvider = '';
    resetRegisterState();
    dialog?.showModal();
    if (errorMessage) {
      // Filled in once the dialog is open, so its status region announces the message.
      await tick();
      showFormStatus(errorMessage, 'error');
    }
  }

  export function close() {
    dialog?.close();
  }

  function clearFormStatus() {
    formStatus = '';
    formStatusType = '';
    emailInvalid = false;
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

  async function handleOAuth(provider) {
    clearFormStatus();
    oauthProvider = provider;

    try {
      // A register-form signature carries over; otherwise the agreement is asked after sign-in.
      await signInWithOAuthProvider(provider, {
        signedMemberAgreement: activeMode === 'register' && contractSigned,
        emailUpdatesOptIn: activeMode === 'register' && emailUpdatesOptIn,
      });
    } catch (error) {
      showFormStatus(error.message || $t('auth.auth_failed'), 'error');
      oauthProvider = '';
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormStatus();

    const trimmedEmail = email.trim();

    if (activeMode === 'reset') {
      await handleResetRequest(trimmedEmail);
      return;
    }

    if (!trimmedEmail || !password) {
      showFormStatus($t('auth.enter_email_password'), 'error');
      return;
    }

    // Register only: an older account may have a shorter password and must still log in.
    if (activeMode === 'register' && password.length < PASSWORD_MIN_LENGTH) {
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

  /** Reset view: shows an error about the address, then focuses the field so it is read out. */
  async function showEmailError(message) {
    showFormStatus(message, 'error');
    emailInvalid = true;
    await tick();
    emailInput?.focus();
  }

  async function handleResetRequest(trimmedEmail) {
    if (!trimmedEmail) {
      showEmailError($t('auth.enter_email'));
      return;
    }

    submitting = true;
    // Only real failures are reported; anything else gets the same neutral confirmation,
    // so the form never says whether an address has an account.
    let errorKey = '';
    try {
      await requestPasswordReset(trimmedEmail);
    } catch (error) {
      errorKey = passwordResetErrorKey(error);
    }
    submitting = false;

    if (errorKey === 'auth.enter_valid_email') {
      showEmailError($t(errorKey));
      return;
    }

    // Disabling the button while sending dropped its focus. Restore it before the result
    // appears, so the focus announcement doesn't cut the status message off.
    await tick();
    submitButton?.focus();
    if (errorKey) {
      showFormStatus($t(errorKey), 'error');
    } else {
      showFormStatus($t('auth.reset_sent', { email: trimmedEmail }), 'success');
    }
  }

  async function switchMode(nextMode) {
    activeMode = nextMode;
    clearFormStatus();
    password = '';
    if (nextMode === 'register') {
      resetRegisterState();
    }
    // The link that was clicked is gone in the new mode; keep focus in the form.
    await tick();
    emailInput?.focus();
  }
</script>

<dialog bind:this={dialog} class="modal" oncancel={handleCancel}>
  <form method="dialog" novalidate onsubmit={handleSubmit}>
    <header class="modal-header">
      <h2>
        {#if activeMode === 'register'}
          {$t('auth.create_account')}
        {:else if activeMode === 'reset'}
          {$t('auth.reset_title')}
        {:else}
          {$t('auth.log_in')}
        {/if}
      </h2>
      <button type="button" class="icon-btn" aria-label={$t('auth.close_aria')} onclick={close}>
        &times;
      </button>
    </header>

    {#if activeMode === 'reset'}
      <p id="auth-reset-intro" class="auth-intro">{$t('auth.reset_intro')}</p>
    {:else if $oauthProviders.length}
      <div class="auth-oauth">
        {#each $oauthProviders as provider (provider)}
          <button
            type="button"
            class="btn-oauth btn-oauth--{provider}"
            disabled={submitting || Boolean(oauthProvider)}
            onclick={() => handleOAuth(provider)}
          >
            <OAuthProviderIcon {provider} />
            <span>
              {#if oauthProvider === provider}
                {$t('auth.oauth_redirecting')}
              {:else}
                {$t(activeMode === 'register' ? 'auth.sign_up_with' : 'auth.log_in_with', {
                  provider: OAUTH_PROVIDER_NAMES[provider],
                })}
              {/if}
            </span>
          </button>
        {/each}
      </div>

      <p class="auth-divider"><span>{$t('auth.or_use_email')}</span></p>
    {/if}

    <label for="auth-email">{$t('auth.email')}</label>
    <input
      bind:this={emailInput}
      id="auth-email"
      name="email"
      type="email"
      autocomplete="email"
      placeholder={$t('auth.email_placeholder')}
      aria-describedby={activeMode !== 'reset'
        ? undefined
        : emailInvalid
          ? 'auth-form-status auth-reset-intro'
          : 'auth-reset-intro'}
      aria-invalid={emailInvalid || undefined}
      required
      bind:value={email}
    />

    {#if activeMode !== 'reset'}
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
    {/if}

    {#if activeMode === 'login'}
      <p class="auth-forgot">
        <button type="button" class="link-btn" onclick={() => switchMode('reset')}>
          {$t('auth.forgot_password')}
        </button>
      </p>
    {/if}

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

    <!-- Always in the page (empty when there is no message) so screen readers announce changes. -->
    <p id="auth-form-status" class="status {formStatusType}" role="status" aria-live="polite">{formStatus}</p>

    <div class="modal-actions">
      <button type="button" class="btn-secondary" onclick={close}>{$t('auth.cancel')}</button>
      <button
        bind:this={submitButton}
        type="submit"
        class="btn-primary"
        disabled={submitting || Boolean(oauthProvider)}
      >
        {#if activeMode === 'reset'}
          {submitting ? $t('auth.reset_sending') : $t('auth.reset_submit')}
        {:else if submitting}
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
      {:else if activeMode === 'reset'}
        <button type="button" class="link-btn" onclick={() => switchMode('login')}>{$t('auth.back_to_log_in')}</button>
      {:else}
        {$t('auth.need_account')}
        <button type="button" class="link-btn" onclick={() => switchMode('register')}>{$t('auth.register')}</button>
      {/if}
    </p>
  </form>
</dialog>

<MemberAgreementModal bind:this={agreementModal} onagreed={handleAgreementSigned} />
