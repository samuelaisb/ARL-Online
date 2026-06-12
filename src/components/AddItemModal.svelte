<script>
  import {
    createInventoryItem,
    INVENTORY_TAGS,
    DEFAULT_INVENTORY_TAG,
  } from '../lib/inventory.js';
  import { compressImageFile } from '../lib/image.js';
  import { t } from '../lib/i18n.js';

  let { oncreated } = $props();

  let dialog = $state();
  let title = $state('');
  let body = $state('');
  let tag = $state(DEFAULT_INVENTORY_TAG);
  let selectedImageDataUrl = $state('');
  let imageFileName = $state('');
  let processingImage = $state(false);
  let saving = $state(false);
  let formStatus = $state('');
  let formStatusType = $state('');

  let imageInput;

  export function open() {
    title = '';
    body = '';
    tag = DEFAULT_INVENTORY_TAG;
    selectedImageDataUrl = '';
    imageFileName = '';
    formStatus = '';
    formStatusType = '';
    if (imageInput) {
      imageInput.value = '';
    }
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

  async function handleImageChange(event) {
    clearFormStatus();

    const file = event.target.files?.[0];
    if (!file) {
      selectedImageDataUrl = '';
      imageFileName = '';
      return;
    }

    processingImage = true;

    try {
      selectedImageDataUrl = await compressImageFile(file);
      imageFileName = file.name;
    } catch (error) {
      selectedImageDataUrl = '';
      imageFileName = '';
      event.target.value = '';
      showFormStatus(error.message || $t('add_item.process_image_error'), 'error');
    } finally {
      processingImage = false;
    }
  }

  function handleCancel(event) {
    event.preventDefault();
    close();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormStatus();

    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    const image = selectedImageDataUrl;

    if (!trimmedTitle || !trimmedBody || !image) {
      showFormStatus($t('add_item.fill_all_fields'), 'error');
      return;
    }

    saving = true;

    try {
      const item = await createInventoryItem({
        title: trimmedTitle,
        body: trimmedBody,
        image,
        tag,
      });
      oncreated?.(item);
      close();
    } catch (error) {
      showFormStatus(error.message || $t('add_item.save_error'), 'error');
    } finally {
      saving = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="modal"
  oncancel={handleCancel}
>
  <form method="dialog" novalidate onsubmit={handleSubmit}>
    <header class="modal-header">
      <h2>{$t('add_item.title')}</h2>
      <button type="button" class="icon-btn" aria-label={$t('auth.close_aria')} onclick={close}>
        &times;
      </button>
    </header>

    <label for="item-title">{$t('add_item.title_label')}</label>
    <input
      id="item-title"
      name="title"
      type="text"
      placeholder={$t('add_item.title_placeholder')}
      required
      bind:value={title}
    />

    <div class="tag-fieldset">
      <span class="tag-fieldset__label" id="item-tag-label">{$t('add_item.tag_label')}</span>
      <div class="inventory-filter" role="group" aria-labelledby="item-tag-label">
        {#each INVENTORY_TAGS as tagOption (tagOption)}
          <button
            type="button"
            class="inventory-filter__btn"
            class:inventory-filter__btn--active={tag === tagOption}
            aria-pressed={tag === tagOption}
            onclick={() => (tag = tagOption)}
          >
            {$t(`add_item.tag_${tagOption}`)}
          </button>
        {/each}
      </div>
    </div>

    <label for="item-body">{$t('add_item.body_label')}</label>
    <textarea
      id="item-body"
      name="body"
      rows="5"
      placeholder={$t('add_item.body_placeholder')}
      required
      bind:value={body}
    ></textarea>

    <label for="item-image">{$t('add_item.image_label')}</label>
    <div class="image-upload">
      <input
        bind:this={imageInput}
        id="item-image"
        name="image"
        type="file"
        accept="image/*"
        hidden
        onchange={handleImageChange}
      />
      <button
        type="button"
        class="btn-secondary image-upload-btn"
        disabled={processingImage}
        onclick={() => imageInput?.click()}
      >
        {#if processingImage}
          {$t('add_item.processing')}
        {:else}
          {$t('add_item.choose_image')}
        {/if}
      </button>
      {#if imageFileName}
        <p class="image-file-name">{imageFileName}</p>
      {/if}
      {#if selectedImageDataUrl}
        <img class="image-preview" src={selectedImageDataUrl} alt="" />
      {/if}
    </div>

    {#if formStatus}
      <p class="status {formStatusType}" role="status" aria-live="polite">
        {formStatus}
      </p>
    {/if}

    <div class="modal-actions">
      <button type="button" class="btn-secondary" onclick={close}>{$t('auth.cancel')}</button>
      <button type="submit" class="btn-primary" disabled={saving}>
        {#if saving}
          {$t('add_item.saving')}
        {:else}
          {$t('add_item.save_item')}
        {/if}
      </button>
    </div>
  </form>
</dialog>
