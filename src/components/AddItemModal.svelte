<script>
  import { createInventoryItem } from '../lib/inventory.js';
  import { compressImageFile } from '../lib/image.js';

  let { oncreated } = $props();

  let dialog = $state();
  let title = $state('');
  let body = $state('');
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
      showFormStatus(error.message || 'Could not process the image.', 'error');
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
      showFormStatus('Please fill in title, body, and choose an image.', 'error');
      return;
    }

    saving = true;

    try {
      const item = await createInventoryItem({
        title: trimmedTitle,
        body: trimmedBody,
        image,
      });
      oncreated?.(item);
      close();
    } catch (error) {
      showFormStatus(error.message || 'Could not save inventory item.', 'error');
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
      <h2>Add Item</h2>
      <button type="button" class="icon-btn" aria-label="Close" onclick={close}>
        &times;
      </button>
    </header>

    <label for="item-title">Title</label>
    <input
      id="item-title"
      name="title"
      type="text"
      placeholder="Item title"
      required
      bind:value={title}
    />

    <label for="item-body">Body</label>
    <textarea
      id="item-body"
      name="body"
      rows="5"
      placeholder="Item description..."
      required
      bind:value={body}
    ></textarea>

    <label for="item-image">Image</label>
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
          Processing...
        {:else}
          Choose Image
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
      <button type="button" class="btn-secondary" onclick={close}>Cancel</button>
      <button type="submit" class="btn-primary" disabled={saving}>
        {#if saving}
          Saving...
        {:else}
          Save Item
        {/if}
      </button>
    </div>
  </form>
</dialog>
