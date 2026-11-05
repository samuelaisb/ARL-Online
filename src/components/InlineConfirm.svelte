<script>
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n.js';
  import BusyLabel from './BusyLabel.svelte';

  // A confirmation in the page instead of window.confirm: the question (the same *_confirm
  // string the dialog used), then Yes and Keep it. The parent renders it in place of, or under,
  // the control that asked, and removes it on cancel or once the action is done. Focus lands on
  // Keep it for a destructive question and on Yes otherwise; Escape inside it is Keep it.
  // While `busy`, both buttons are disabled and Yes shows its busy label.
  let {
    message,
    confirmLabel,
    busyLabel,
    busy = false,
    tone = 'danger',
    onconfirm,
    oncancel,
    keepLabel,
    id,
  } = $props();

  const autoId = $props.id();
  const groupId = $derived(id ?? autoId);
  const textId = $derived(`${groupId}-text`);
  const parts = $derived(splitQuestion(message ?? ''));

  let root = $state(null);
  let yesButton = $state(null);
  let keepButton = $state(null);

  /**
   * The question up to its first "?" (outside quotes, so a title can hold one) is the bold
   * lead; anything after it stays plain. A title with a stray `"` upsets the quote count, so
   * then the first "?" that ends a sentence is used instead.
   */
  function splitQuestion(text) {
    const split = (index) => ({ lead: text.slice(0, index + 1), rest: text.slice(index + 1).trim() });
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '«' || char === '“') {
        quoted = true;
      } else if (char === '»' || char === '”') {
        quoted = false;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === '?' && !quoted) {
        return split(index);
      }
    }
    const sentenceEnd = text.search(/\?(?=\s|$)/);
    return sentenceEnd === -1 ? { lead: text, rest: '' } : split(sentenceEnd);
  }

  /** Moves focus to the button a keyboard user most likely wants (see above). */
  export function focus() {
    (tone === 'danger' ? keepButton : yesButton)?.focus();
  }

  onMount(focus);

  // Escape anywhere inside the question cancels it (not while the action runs).
  $effect(() => {
    const element = root;
    if (!element) {
      return;
    }

    const onKeydown = (event) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        event.stopPropagation();
        oncancel?.();
      }
    };
    element.addEventListener('keydown', onKeydown);
    return () => element.removeEventListener('keydown', onKeydown);
  });
</script>

<div
  bind:this={root}
  id={groupId}
  class="inline-confirm"
  class:inline-confirm--danger={tone === 'danger'}
  role="group"
  aria-labelledby={textId}
>
  <p id={textId} class="inline-confirm__text">
    <strong class="inline-confirm__lead">{parts.lead}</strong>{#if parts.rest}{' '}{parts.rest}{/if}
  </p>
  <div class="inline-confirm__actions">
    <button
      bind:this={yesButton}
      type="button"
      class="action-btn {tone === 'danger' ? 'action-btn--danger' : 'action-btn--primary'}"
      aria-busy={busy ? 'true' : undefined}
      disabled={busy}
      onclick={() => onconfirm?.()}
    >
      <BusyLabel label={confirmLabel} busyLabel={busyLabel ?? confirmLabel} {busy} />
    </button>
    <button bind:this={keepButton} type="button" class="action-btn" disabled={busy} onclick={() => oncancel?.()}>
      {keepLabel ?? $t('account_agenda.keep')}
    </button>
  </div>
</div>
