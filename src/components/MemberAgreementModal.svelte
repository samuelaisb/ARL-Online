<script>
  import { getMemberAgreementHtml } from '../lib/member-agreement.js';
  import { locale, t } from '../lib/i18n.js';

  let { onagreed } = $props();

  let dialog = $state();

  const agreementHtml = $derived(getMemberAgreementHtml($locale));

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

  function handleAgree() {
    onagreed?.();
    close();
  }
</script>

<dialog bind:this={dialog} class="modal modal--agreement" oncancel={handleCancel}>
  <div class="modal-body modal-body--agreement">
    <header class="modal-header">
      <h2>{$t('auth.member_agreement_title')}</h2>
      <button type="button" class="icon-btn" aria-label={$t('auth.close_aria')} onclick={close}>
        &times;
      </button>
    </header>

    <div class="member-agreement-content">
      {@html agreementHtml}
    </div>

    <div class="modal-actions modal-actions--agreement">
      <button type="button" class="btn-primary" onclick={handleAgree}>
        {$t('auth.agree_to_terms')}
      </button>
    </div>
  </div>
</dialog>
