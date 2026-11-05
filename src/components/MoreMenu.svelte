<script>
  import { tick } from 'svelte';

  // The "More" button on an agenda entry and the list of actions it shows. A disclosure (a
  // button and a list of buttons), not an ARIA menu: Tab moves through the actions. The parent
  // keeps `open` (one menu open per page) and hears every change through `ontoggle(open)`.
  // Escape closes it and puts focus back on the button; a click or focus outside closes it;
  // choosing an action closes it first, then calls the action's `onselect`.
  // `items`: [{ id, label, danger?, disabled?, onselect }].
  let { label, ariaLabel, items = [], open = false, ontoggle, disabled = false, id } = $props();

  const autoId = $props.id();
  const listId = $derived(`${id ?? autoId}-list`);

  let root = $state(null);
  let trigger = $state(null);
  let list = $state(null);

  /** Puts focus back on the More button, e.g. after a panel opened from it closes. */
  export function focusTrigger() {
    trigger?.focus();
  }

  async function choose(item) {
    if (item.disabled) {
      return;
    }

    ontoggle?.(false);
    item.onselect?.();
    // The chosen button is hidden now; if the action didn't move focus itself, keep it here.
    // Chrome still reports the hidden button as focused until its next frame, so check the list.
    await tick();
    const active = document.activeElement;
    if (!active || active === document.body || list?.contains(active)) {
      trigger?.focus();
    }
  }

  // Listeners only while open: Escape, a click elsewhere on the page, and focus leaving it.
  $effect(() => {
    const element = root;
    if (!open || !element) {
      return;
    }

    const onKeydown = (event) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      const inside = element.contains(document.activeElement);
      ontoggle?.(false);
      if (inside) {
        trigger?.focus();
      }
    };
    const onClick = (event) => {
      if (!element.contains(event.target)) {
        ontoggle?.(false);
      }
    };
    const onFocusOut = (event) => {
      if (event.relatedTarget && !element.contains(event.relatedTarget)) {
        ontoggle?.(false);
      }
    };

    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onClick, true);
    element.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('click', onClick, true);
      element.removeEventListener('focusout', onFocusOut);
    };
  });
</script>

<div bind:this={root} class="more-menu">
  <button
    bind:this={trigger}
    type="button"
    class="action-btn more-menu__trigger"
    aria-label={ariaLabel}
    aria-expanded={open ? 'true' : 'false'}
    aria-controls={listId}
    {disabled}
    onclick={() => ontoggle?.(!open)}
  >
    <svg class="more-menu__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.75" fill="currentColor" />
      <circle cx="8" cy="8" r="1.75" fill="currentColor" />
      <circle cx="13" cy="8" r="1.75" fill="currentColor" />
    </svg>
    <span>{label}</span>
  </button>
  <ul bind:this={list} id={listId} class="more-menu__list" hidden={!open}>
    {#each items as item (item.id)}
      <li>
        <button
          type="button"
          class="more-menu__item"
          class:more-menu__item--danger={item.danger}
          disabled={item.disabled}
          onclick={() => choose(item)}
        >
          {item.label}
        </button>
      </li>
    {/each}
  </ul>
</div>
