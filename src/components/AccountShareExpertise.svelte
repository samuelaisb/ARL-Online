<script>
  import { onMount } from 'svelte';
  import { session } from '../lib/auth.js';
  import {
    EXPERT_LONG_TEXT_MAX,
    EXPERT_NAME_MAX,
    EXPERT_SHORT_TEXT_MAX,
    splitExpertiseCopy,
  } from '../lib/expertise-fields.js';
  import { compressImageFile } from '../lib/image.js';
  import {
    createMentorProfile,
    fetchMentorProfile,
    updateMentorProfile,
  } from '../lib/inventory.js';
  import { itemToPath, navigate } from '../lib/router.js';
  import { t, translateKey } from '../lib/i18n.js';
  import { notify, DEFAULT_NOTIFICATION_DURATION } from '../lib/notification-store.js';

  let { onProfileSaved } = $props();

  let loading = $state(true);
  let loadError = $state('');
  let emailConfirmed = $state(true);
  let profile = $state(null);
  let name = $state('');
  let shortText = $state('');
  let longText = $state('');
  let currentImage = $state('');
  let selectedImageDataUrl = $state('');
  let imageFileName = $state('');
  let processingImage = $state(false);
  let saving = $state(false);
  let formStatus = $state('');
  let formStatusType = $state('');

  let imageInput = $state();

  const accountEmail = $derived($session?.user?.email ?? '');
  const previewImage = $derived(selectedImageDataUrl || currentImage);
  const profilePath = $derived(
    profile ? itemToPath({ ...profile, tag: 'expertise' }) : '',
  );

  function applyProfile(next) {
    profile = next;

    if (next) {
      const copy = splitExpertiseCopy(next);
      name = next.title ?? '';
      shortText = copy.shortText;
      longText = copy.longText;
      currentImage = next.image ?? '';
    } else {
      name = '';
      shortText = '';
      longText = '';
      currentImage = '';
    }

    selectedImageDataUrl = '';
    imageFileName = '';
    if (imageInput) {
      imageInput.value = '';
    }
  }

  async function load() {
    loading = true;
    loadError = '';

    try {
      const result = await fetchMentorProfile();
      emailConfirmed = result.emailConfirmed;
      applyProfile(result.profile);
    } catch (error) {
      loadError = error.message || $t('share_expertise.load_error');
    } finally {
      loading = false;
    }
  }

  function showFormStatus(message, type) {
    formStatus = message;
    formStatusType = type;
  }

  async function handleImageChange(event) {
    formStatus = '';
    formStatusType = '';

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

  function openProfile(event) {
    event.preventDefault();
    if (profilePath) {
      navigate(profilePath);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    formStatus = '';
    formStatusType = '';

    const trimmedName = name.trim();
    const trimmedShort = shortText.trim();
    const trimmedLong = longText.trim();
    const isEdit = Boolean(profile);

    if (!trimmedName || !trimmedShort || !trimmedLong) {
      showFormStatus($t(isEdit ? 'share_expertise.fill_text' : 'share_expertise.fill_fields'), 'error');
      return;
    }

    if (!isEdit && !selectedImageDataUrl) {
      showFormStatus($t('share_expertise.fill_fields'), 'error');
      return;
    }

    if (trimmedName.length > EXPERT_NAME_MAX) {
      showFormStatus($t('share_expertise.name_too_long'), 'error');
      return;
    }

    if (trimmedShort.length > EXPERT_SHORT_TEXT_MAX) {
      showFormStatus($t('add_item.short_text_too_long'), 'error');
      return;
    }

    if (trimmedLong.length > EXPERT_LONG_TEXT_MAX) {
      showFormStatus($t('add_item.long_text_too_long'), 'error');
      return;
    }

    saving = true;

    const payload = {
      title: trimmedName,
      body: trimmedShort,
      longBody: trimmedLong,
      ...(selectedImageDataUrl ? { image: selectedImageDataUrl } : {}),
    };

    try {
      const saved = isEdit
        ? await updateMentorProfile(payload)
        : await createMentorProfile(payload);
      applyProfile(saved);
      onProfileSaved?.(saved);
      showFormStatus(
        $t(isEdit ? 'share_expertise.saved' : 'share_expertise.published'),
        'success',
      );
      notify(
        translateKey(isEdit ? 'kimchi.mentor_profile_updated' : 'kimchi.mentor_profile_published'),
        DEFAULT_NOTIFICATION_DURATION,
      );
    } catch (error) {
      if (error.profile) {
        applyProfile(error.profile);
        onProfileSaved?.(error.profile);
      }
      showFormStatus(
        error.status === 409
          ? $t('share_expertise.already_exists')
          : error.message || $t('share_expertise.save_error'),
        'error',
      );
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<section id="share-expertise-panel" class="account-share-expertise" aria-labelledby="share-expertise-heading">
  <h2 id="share-expertise-heading">{$t('share_expertise.heading')}</h2>

  {#if loading}
    <p class="admin-status" role="status">{$t('share_expertise.loading')}</p>
  {:else if loadError}
    <p class="admin-status admin-status-error" role="alert">{loadError}</p>
  {:else if !emailConfirmed}
    <p class="account-share-expertise__intro">{$t('share_expertise.intro')}</p>
    <p class="account-share-expertise__notice">{$t('share_expertise.confirm_email')}</p>
  {:else}
    <p class="account-share-expertise__intro">
      {profile ? $t('share_expertise.intro_edit') : $t('share_expertise.intro')}
    </p>
    <form novalidate onsubmit={handleSubmit}>
      <label for="mentor-name">{$t('share_expertise.name_label')}</label>
      <input
        id="mentor-name"
        name="name"
        type="text"
        maxlength={EXPERT_NAME_MAX}
        autocomplete="name"
        placeholder={$t('share_expertise.name_placeholder')}
        required
        bind:value={name}
      />

      <span class="consultation-field account-share-expertise__email">
        <span class="consultation-field__label">{$t('share_expertise.email_label')}</span>
        <span class="consultation-field__value">{accountEmail}</span>
      </span>
      <p class="field-hint account-share-expertise__email-hint">{$t('share_expertise.email_hint')}</p>

      <label for="mentor-short-text">{$t('add_item.short_text_label')}</label>
      <textarea
        id="mentor-short-text"
        class="add-item-short-text"
        name="body"
        rows="2"
        maxlength={EXPERT_SHORT_TEXT_MAX}
        placeholder={$t('add_item.short_text_placeholder')}
        required
        bind:value={shortText}
      ></textarea>
      <p class="field-hint">{$t('add_item.short_text_hint')}</p>

      <label for="mentor-long-text">{$t('add_item.long_text_label')}</label>
      <textarea
        id="mentor-long-text"
        name="longBody"
        rows="5"
        maxlength={EXPERT_LONG_TEXT_MAX}
        placeholder={$t('add_item.long_text_placeholder')}
        required
        bind:value={longText}
      ></textarea>
      <p class="field-hint">{$t('add_item.long_text_hint')}</p>

      <label for="mentor-image">{$t('share_expertise.photo_label')}</label>
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
          {processingImage ? $t('add_item.processing') : $t('add_item.choose_image')}
        </button>
        {#if imageFileName}
          <p class="image-file-name">{imageFileName}</p>
        {:else if profile}
          <p class="field-hint account-share-expertise__photo-hint">{$t('share_expertise.photo_hint_edit')}</p>
        {/if}
        {#if previewImage}
          <img class="image-preview account-share-expertise__photo" src={previewImage} alt="" />
        {/if}
      </div>

      {#if formStatus}
        <p
          class="status {formStatusType}"
          class:account-share-expertise__success={formStatusType === 'success'}
          role="status"
          aria-live="polite"
        >
          {formStatus}
        </p>
      {/if}

      <button type="submit" class="btn-primary" disabled={saving || processingImage}>
        {#if saving}
          {profile ? $t('share_expertise.saving') : $t('share_expertise.publishing')}
        {:else}
          {profile ? $t('share_expertise.save') : $t('share_expertise.publish')}
        {/if}
      </button>

      {#if profilePath}
        <p class="account-share-expertise__view">
          <a href={profilePath} onclick={openProfile}>{$t('share_expertise.view_profile')}</a>
        </p>
      {/if}
    </form>
  {/if}
</section>
