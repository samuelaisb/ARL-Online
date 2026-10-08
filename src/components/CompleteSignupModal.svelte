<script>
  import {
    completeMemberAgreement,
    needsMemberAgreement,
    passwordPrompt,
    signOut,
  } from '../lib/auth.js';
  import { t } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import BusyLabel from './BusyLabel.svelte';
  import MemberAgreementModal from './MemberAgreementModal.svelte';

  /** The sign-out line here is longer than the usual 5 s bubble. */
  const SIGNUP_PAUSED_DURATION = 8000;

  let dialog = $state();
  let agreementModal = $state();
  let contractSigned = $state(false);
  let emailUpdatesOptIn = $state(false);
  /** Disables both buttons while either request runs. */
  let submitting = $state(false);
  /** Which request is running, so only the clicked button shows busy. */
  let signingOut = $state(false);
  let formStatus = $state('');

  // Opens whenever the signed-in account came from an OAuth provider without the agreement.
  // It waits while SetPasswordModal is up (a reset link can sign in such an account), so the
  // two dialogs never stack; it opens once the new password is saved or skipped.
  const shouldOpen = $derived($needsMemberAgreement && !$passwordPrompt);

  $effect(() => {
    if (!dialog) return;
    if (shouldOpen && !dialog.open) {
      contractSigned = false;
      emailUpdatesOptIn = false;
      formStatus = '';
      dialog.showModal();
    } else if (!shouldOpen && dialog.open) {
      dialog.close();
    }
  });

  function handleCancel(event) {
    // The account has to sign the agreement or sign out.
    event.preventDefault();
  }

  function handleAgreementSigned() {
    contractSigned = true;
    formStatus = '';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!contractSigned) {
      formStatus = $t('auth.complete_signup_contract_required');
      return;
    }

    submitting = true;
    formStatus = '';
    try {
      await completeMemberAgreement({ emailUpdatesOptIn });
    } catch (error) {
      formStatus = error.message || $t('auth.auth_failed');
    } finally {
      submitting = false;
    }
  }

  async function handleSignOut() {
    submitting = true;
    signingOut = true;
    formStatus = '';
    try {
      await signOut();
      // Backing out of joining, not leaving: say they can finish later. If a new agreement
      // version ever re-asks existing members through this dialog, they should get
      // `kimchi.signed_out` here instead.
      notify({ textKey: 'kimchi.signup_paused' }, SIGNUP_PAUSED_DURATION);
    } catch (error) {
      formStatus = error.message || $t('auth.sign_out_error');
    } finally {
      submitting = false;
      signingOut = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="modal"
  aria-labelledby="complete-signup-title"
  oncancel={handleCancel}
>
  <form method="dialog" novalidate onsubmit={handleSubmit}>
    <header class="modal-header">
      <h2 id="complete-signup-title">{$t('auth.complete_signup_title')}</h2>
    </header>

    <p class="auth-complete-intro">{$t('auth.complete_signup_message')}</p>

    <div class="auth-contract">
      {#if contractSigned}
        <p class="auth-contract-signed" role="status">
          <span class="auth-contract-signed__icon" aria-hidden="true">✓</span>
          {$t('auth.contract_signed')}
        </p>
      {:else}
        <button type="button" class="btn-sign-contract" onclick={() => agreementModal?.open()}>
          {$t('auth.sign_contract')}
        </button>
      {/if}
    </div>

    <label class="auth-opt-in">
      <input type="checkbox" name="email-updates-opt-in" bind:checked={emailUpdatesOptIn} />
      <span>{$t('auth.email_updates_opt_in')}</span>
    </label>

    {#if formStatus}
      <p class="status error" role="status" aria-live="polite">{formStatus}</p>
    {/if}

    <div class="modal-actions">
      <button type="button" class="btn-secondary" disabled={submitting} onclick={handleSignOut}>
        <BusyLabel label={$t('auth.sign_out')} busyLabel={$t('auth.signing_out')} busy={signingOut} />
      </button>
      <button type="submit" class="btn-primary" disabled={submitting}>
        <BusyLabel
          label={$t('auth.complete_signup_submit')}
          busyLabel={$t('auth.saving')}
          busy={submitting && !signingOut}
        />
      </button>
    </div>
  </form>
</dialog>

<MemberAgreementModal bind:this={agreementModal} onagreed={handleAgreementSigned} />
