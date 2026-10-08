<script>
  import { onMount } from 'svelte';
  import { INVENTORY_PATH, navigate } from '../lib/router.js';
  import { t } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import { sendContactMessage } from '../lib/contact.js';
  import BusyLabel from './BusyLabel.svelte';

  let contactSection = $state();
  let name = $state('');
  let email = $state('');
  let message = $state('');
  let website = $state('');
  let submitting = $state(false);
  let formStatus = $state('');
  let formStatusType = $state('');

  function goToInventory(event) {
    event.preventDefault();
    navigate(INVENTORY_PATH);
  }

  function goToPrivacy(event) {
    event.preventDefault();
    navigate('/privacy');
  }

  function clearFormStatus() {
    formStatus = '';
    formStatusType = '';
  }

  function showFormStatus(messageText, type) {
    formStatus = messageText;
    formStatusType = type;
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  /**
   * `/about#contact` (a shared link, Back/Forward to one): bring the contact form into
   * view and focus its section. This page renders after its chunk loads, so on a fresh
   * load the browser's own jump to the hash found nothing. Kimchi's `/about#contact`
   * links don't change the URL hash; KimchiNotification scrolls to the section itself.
   */
  function showContactFromHash() {
    if (window.location.hash !== '#contact' || !contactSection) {
      return;
    }

    contactSection.scrollIntoView({ block: 'start' });
    contactSection.focus({ preventScroll: true });
  }

  onMount(() => {
    showContactFromHash();
    window.addEventListener('hashchange', showContactFromHash);
    return () => window.removeEventListener('hashchange', showContactFromHash);
  });

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormStatus();

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedMessage = message.trim();

    if (!trimmedName || !trimmedEmail || !trimmedMessage) {
      showFormStatus($t('about.contact_validation'), 'error');
      return;
    }

    if (!isValidEmail(trimmedEmail)) {
      showFormStatus($t('about.contact_invalid_email'), 'error');
      return;
    }

    submitting = true;

    try {
      await sendContactMessage({
        name: trimmedName,
        email: trimmedEmail,
        message: trimmedMessage,
        website,
      });
      showFormStatus($t('about.contact_success'), 'success');
      // The status line above stays the carrier: Kimchi may be asleep.
      notify({ textKey: 'kimchi.contact_sent' });
      name = '';
      email = '';
      message = '';
      website = '';
    } catch (error) {
      showFormStatus(error.message || $t('about.contact_error'), 'error');
    } finally {
      submitting = false;
    }
  }
</script>

<main id="main-content" class="container about-page">
  <header class="page-header">
    <h1>{$t('about.heading')}</h1>
    <p class="subtitle">{$t('about.subtitle')}</p>
    <p class="page-header__back">
      <a href={INVENTORY_PATH} class="page-header__back-link" onclick={goToInventory}>
        {$t('about.back_to_inventory')}
      </a>
    </p>
  </header>

  <section class="about-section" aria-labelledby="about-mission-heading">
    <h2 id="about-mission-heading" class="about-section__title">{$t('about.mission_heading')}</h2>
    <p class="about-section__body">{$t('about.mission_body')}</p>
  </section>

  <section class="about-section" aria-labelledby="about-canada-heading">
    <h2 id="about-canada-heading" class="about-section__title">{$t('about.canada_heading')}</h2>
    <p class="about-section__body">{$t('about.canada_body')}</p>
  </section>

  <section class="about-section" aria-labelledby="about-partners-heading">
    <h2 id="about-partners-heading" class="about-section__title">{$t('about.partners_heading')}</h2>
    <p class="about-section__body">{$t('about.partners_intro')}</p>

    <ul class="about-partners">
      <li class="about-partner">
        <h3 class="about-partner__name">
          <a
            href="https://www.apathyisboring.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            {$t('about.partner_aib_name')}
          </a>
        </h3>
        <p class="about-partner__body">{$t('about.partner_aib_body')}</p>
      </li>
      <li class="about-partner">
        <h3 class="about-partner__name">
          <a
            href="https://www.fesplanet.org"
            target="_blank"
            rel="noopener noreferrer"
          >
            {$t('about.partner_fes_name')}
          </a>
        </h3>
        <p class="about-partner__body">{$t('about.partner_fes_body')}</p>
      </li>
    </ul>
  </section>

  <section class="about-section" aria-labelledby="about-privacy-heading">
    <h2 id="about-privacy-heading" class="about-section__title">{$t('about.privacy_heading')}</h2>
    <p class="about-section__body">
      {$t('about.privacy_body')}
      <a href="/privacy" class="about-section__link" onclick={goToPrivacy}>
        {$t('about.privacy_link')}
      </a>
    </p>
  </section>

  <!-- id="contact": /about#contact links (Kimchi's "Contact us") land here; the
       tabindex lets them move focus to the section. -->
  <section
    bind:this={contactSection}
    id="contact"
    class="about-section"
    aria-labelledby="about-contact-heading"
    tabindex="-1"
  >
    <h2 id="about-contact-heading" class="about-section__title">{$t('about.contact_heading')}</h2>
    <p class="about-section__body">{$t('about.contact_intro')}</p>

    <form class="about-contact-form" novalidate onsubmit={handleSubmit}>
      <div class="visually-hidden" aria-hidden="true">
        <label for="about-contact-website">{$t('about.contact_website_label')}</label>
        <input
          id="about-contact-website"
          name="website"
          type="text"
          tabindex="-1"
          autocomplete="off"
          bind:value={website}
        />
      </div>

      <label for="about-contact-name">{$t('about.contact_name')}</label>
      <input
        id="about-contact-name"
        name="name"
        type="text"
        autocomplete="name"
        required
        maxlength="120"
        placeholder={$t('about.contact_name_placeholder')}
        bind:value={name}
        disabled={submitting}
      />

      <label for="about-contact-email">{$t('about.contact_email')}</label>
      <input
        id="about-contact-email"
        name="email"
        type="email"
        autocomplete="email"
        required
        placeholder={$t('about.contact_email_placeholder')}
        bind:value={email}
        disabled={submitting}
      />

      <label for="about-contact-message">{$t('about.contact_message')}</label>
      <textarea
        id="about-contact-message"
        name="message"
        required
        maxlength="5000"
        rows="6"
        placeholder={$t('about.contact_message_placeholder')}
        bind:value={message}
        disabled={submitting}
      ></textarea>

      {#if formStatus}
        <p class="status {formStatusType}" role="status" aria-live="polite">
          {formStatus}
        </p>
      {/if}

      <button type="submit" class="btn-primary about-contact-form__submit" disabled={submitting}>
        <BusyLabel
          label={$t('about.contact_submit')}
          busyLabel={$t('about.contact_submitting')}
          busy={submitting}
        />
      </button>
    </form>
  </section>
</main>
