<script>
  import { completeMemberAgreement, needsMemberAgreement, signOut } from '../lib/auth.js';
  import { t, translateKey } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import MemberAgreementModal from './MemberAgreementModal.svelte';

  let dialog = $state();
  let agreementModal = $state();
  let contractSigned = $state(false);
  let emailUpdatesOptIn = $state(false);
  let submitting = $state(false);
  let formStatus = $state('');

  // Opens whenever the signed-in account came from an OAuth provider without the agreement.
  $effect(() => {
    if (!dialog) return;
    if ($needsMemberAgreement && !dialog.open) {
      contractSigned = false;
      emailUpdatesOptIn = false;
      formStatus = '';
      dialog.showModal();
    } else if (!$needsMemberAgreement && dialog.open) {
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
    formStatus = '';
    try {
      await signOut();
      notify(translateKey('kimchi.signed_out'));
    } catch (error) {
      formStatus = error.message || $t('auth.sign_out_error');
    } finally {
      submitting = false;
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
        {$t('auth.sign_out')}
      </button>
      <button type="submit" class="btn-primary" disabled={submitting}>
        {submitting ? $t('auth.saving') : $t('auth.complete_signup_submit')}
      </button>
    </div>
  </form>
</dialog>

<MemberAgreementModal bind:this={agreementModal} onagreed={handleAgreementSigned} />
