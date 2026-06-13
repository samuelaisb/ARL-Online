<script>
  import { navigate } from '../lib/router.js';
  import { t } from '../lib/i18n.js';

  function goHome(event) {
    event.preventDefault();
    navigate('/');
  }
</script>

<main id="main-content" class="container about-page">
  <p class="about-page__back">
    <a href="/" class="about-page__back-link" onclick={goHome}>
      {$t('about.back_to_inventory')}
    </a>
  </p>

  <header class="page-header">
    <h1>{$t('about.heading')}</h1>
    <p class="subtitle">{$t('about.subtitle')}</p>
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
</main>
