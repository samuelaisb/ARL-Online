<script>
  import {
    EXPERT_LONG_TEXT_MAX,
    EXPERT_SHORT_TEXT_MAX,
    splitExpertiseCopy,
  } from '../lib/expertise-fields.js';
  import { updateExpertiseItem } from '../lib/inventory.js';
  import { compressImageFile } from '../lib/image.js';
  import { locale, t } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';
  import { revealOnLoad } from '../lib/motion.js';
  import BusyLabel from './BusyLabel.svelte';
  import Skeleton from './Skeleton.svelte';

  // `loading`: a fetch is running. Before `hasLoaded` that shows the skeleton; after it,
  // the rows stay and the list is marked as refreshing.
  let { mentors = [], loading = false, hasLoaded = false, loadError = '', onupdated } = $props();

  let editingId = $state('');
  let name = $state('');
  let expertEmail = $state('');
  let shortText = $state('');
  let longText = $state('');
  let imageDataUrl = $state('');
  let imageFileName = $state('');
  let replaceImage = $state(false);
  let processingImage = $state(false);
  let saving = $state(false);
  let formError = $state('');

  let imageInput = $state();

  const sortedMentors = $derived(
    [...mentors].sort((a, b) =>
      (a.title || '').localeCompare(b.title || '', $locale === 'fr' ? 'fr' : 'en', {
        sensitivity: 'base',
      }),
    ),
  );

  function startEdit(mentor) {
    if (saving) {
      return;
    }

    const copy = splitExpertiseCopy(mentor);
    editingId = mentor.id;
    name = mentor.title ?? '';
    expertEmail = mentor.expertEmail ?? '';
    shortText = copy.shortText;
    longText = copy.longText;
    imageDataUrl = '';
    imageFileName = '';
    replaceImage = false;
    formError = '';
    if (imageInput) {
      imageInput.value = '';
    }
  }

  function cancelEdit() {
    if (saving) {
      return;
    }

    editingId = '';
    formError = '';
  }

  async function handleImageChange(event) {
    formError = '';

    const file = event.target.files?.[0];
    if (!file) {
      imageDataUrl = '';
      imageFileName = '';
      replaceImage = false;
      return;
    }

    processingImage = true;

    try {
      imageDataUrl = await compressImageFile(file);
      imageFileName = file.name;
      replaceImage = true;
    } catch (error) {
      imageDataUrl = '';
      imageFileName = '';
      replaceImage = false;
      event.target.value = '';
      formError = error.message || $t('add_item.process_image_error');
    } finally {
      processingImage = false;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    formError = '';

    if (!editingId || saving) {
      return;
    }

    const trimmedName = name.trim();
    const trimmedShort = shortText.trim();
    const trimmedLong = longText.trim();
    const trimmedEmail = expertEmail.trim();

    if (!trimmedName || !trimmedShort || !trimmedLong) {
      formError = $t('admin.mentors_fill_fields');
      return;
    }

    if (trimmedShort.length > EXPERT_SHORT_TEXT_MAX) {
      formError = $t('add_item.short_text_too_long');
      return;
    }

    if (trimmedLong.length > EXPERT_LONG_TEXT_MAX) {
      formError = $t('add_item.long_text_too_long');
      return;
    }

    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      formError = $t('add_item.expert_email_invalid');
      return;
    }

    if (replaceImage && !imageDataUrl) {
      formError = $t('add_item.process_image_error');
      return;
    }

    saving = true;

    try {
      const item = await updateExpertiseItem(editingId, {
        title: trimmedName,
        body: trimmedShort,
        longBody: trimmedLong,
        expertEmail: trimmedEmail,
        ...(replaceImage ? { image: imageDataUrl } : {}),
      });
      onupdated?.(item);
      notify({ textKey: 'kimchi.mentor_updated' }, DEFAULT_NOTIFICATION_DURATION);
      editingId = '';
    } catch (error) {
      formError = error.message || $t('admin.mentors_save_error');
    } finally {
      saving = false;
    }
  }
</script>

<div id="admin-mentor-list" class="admin-mentor-list" aria-label={$t('admin.mentors')}>
  {#if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {/if}
  {#if loading && !hasLoaded}
    <Skeleton count={4} avatar label={$t('admin.loading')} />
  {:else if sortedMentors.length > 0}
    <!-- No aria-busy while editing: it would hold back the form's alert. -->
    <ul
      class="admin-item-list"
      class:list-refreshing={loading}
      aria-busy={(loading && !editingId) || undefined}
    >
      {#each sortedMentors as mentor (mentor.id)}
        <li
          class="admin-item-row admin-item-row--mentor"
          class:admin-item-row--mentor-editing={editingId === mentor.id}
        >
          {#if editingId === mentor.id}
            <form class="admin-mentor-editor" novalidate onsubmit={handleSubmit}>
              <img
                class="admin-mentor-editor__photo"
                src={replaceImage && imageDataUrl ? imageDataUrl : mentor.image}
                alt=""
                {@attach revealOnLoad}
              />

              <label for="mentor-name">{$t('add_item.expert_name_label')}</label>
              <input
                id="mentor-name"
                name="title"
                type="text"
                required
                bind:value={name}
                placeholder={$t('add_item.expert_name_placeholder')}
              />
              <p class="field-hint">{$t('admin.mentors_slug_hint')}</p>

              <label for="mentor-email">{$t('add_item.expert_email_label')}</label>
              <input
                id="mentor-email"
                name="expertEmail"
                type="email"
                bind:value={expertEmail}
                placeholder={$t('add_item.expert_email_placeholder')}
              />
              <p class="field-hint">{$t('add_item.expert_email_hint')}</p>

              <label for="mentor-short-text">{$t('add_item.short_text_label')}</label>
              <textarea
                id="mentor-short-text"
                class="add-item-short-text"
                name="body"
                rows="2"
                maxlength={EXPERT_SHORT_TEXT_MAX}
                required
                bind:value={shortText}
                placeholder={$t('add_item.short_text_placeholder')}
              ></textarea>
              <p class="field-hint">{$t('add_item.short_text_hint')}</p>

              <label for="mentor-long-text">{$t('add_item.long_text_label')}</label>
              <textarea
                id="mentor-long-text"
                name="longBody"
                rows="6"
                maxlength={EXPERT_LONG_TEXT_MAX}
                required
                bind:value={longText}
                placeholder={$t('add_item.long_text_placeholder')}
              ></textarea>
              <p class="field-hint">{$t('add_item.long_text_hint')}</p>

              <label for="mentor-image">{$t('add_item.image_label')}</label>
              <div class="image-upload">
                <input
                  bind:this={imageInput}
                  id="mentor-image"
                  name="image"
                  type="file"
                  accept="image/*"
                  hidden
                  onchange={handleImageChange}
                />
                <button
                  type="button"
                  class="btn-secondary image-upload-btn"
                  disabled={processingImage || saving}
                  onclick={() => imageInput?.click()}
                >
                  <BusyLabel
                    label={$t('add_item.choose_image')}
                    busyLabel={$t('add_item.processing')}
                    busy={processingImage}
                  />
                </button>
                {#if imageFileName}
                  <p class="image-file-name">{imageFileName}</p>
                {/if}
              </div>
              <p class="admin-mentor-note">{$t('admin.mentors_image_hint')}</p>

              {#if formError}
                <p class="admin-status admin-status-error" role="alert">{formError}</p>
              {/if}

              <div class="admin-mentor-actions">
                <button type="button" class="btn-secondary" disabled={saving} onclick={cancelEdit}>
                  {$t('auth.cancel')}
                </button>
                <button type="submit" class="btn-primary" disabled={saving || processingImage}>
                  <BusyLabel
                    label={$t('admin.mentors_save')}
                    busyLabel={$t('admin.mentors_saving')}
                    busy={saving}
                  />
                </button>
              </div>
            </form>
          {:else}
            <div class="admin-mentor-summary">
              {#if mentor.image}
                <img class="admin-mentor-photo" src={mentor.image} alt="" {@attach revealOnLoad} />
              {/if}
              <div class="admin-mentor-meta">
                <span class="admin-item-title">{mentor.title}</span>
                {#if mentor.expertEmail}
                  <span class="admin-mentor-email">{mentor.expertEmail}</span>
                {:else}
                  <span class="admin-mentor-email admin-mentor-email--missing">
                    {$t('admin.mentors_no_email')}
                  </span>
                {/if}
                {#if mentor.body}
                  <span class="admin-mentor-blurb">{splitExpertiseCopy(mentor).shortText}</span>
                {/if}
              </div>
            </div>
            <button
              type="button"
              class="btn-secondary admin-mentor-edit"
              disabled={Boolean(editingId) || saving}
              aria-label={$t('admin.mentors_edit_aria', { name: mentor.title })}
              onclick={() => startEdit(mentor)}
            >
              {$t('admin.mentors_edit')}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if hasLoaded || !loadError}
    <p class="empty-state">{$t('admin.mentors_empty')}</p>
  {/if}
</div>
