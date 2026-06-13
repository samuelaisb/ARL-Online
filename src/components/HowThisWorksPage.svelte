<script>
  import { navigate } from '../lib/router.js';
  import { faq, t } from '../lib/i18n.js';

  const steps = [
    'browse',
    'account',
    'reserve',
    'approval',
    'pickup',
  ];

  function goHome(event) {
    event.preventDefault();
    navigate('/');
  }
</script>

<main id="main-content" class="container how-this-works-page">
  <p class="how-this-works-page__back">
    <a href="/" class="how-this-works-page__back-link" onclick={goHome}>
      {$t('how_this_works.back_to_inventory')}
    </a>
  </p>

  <header class="page-header">
    <h1>{$t('how_this_works.heading')}</h1>
    <p class="subtitle">{$t('how_this_works.subtitle')}</p>
  </header>

  <ol class="how-this-works-steps">
    {#each steps as step, index (step)}
      <li class="how-this-works-step">
        <span class="how-this-works-step__number" aria-hidden="true">{index + 1}</span>
        <div class="how-this-works-step__content">
          <h2 class="how-this-works-step__title">{$t(`how_this_works.steps.${step}.title`)}</h2>
          <p class="how-this-works-step__body">{$t(`how_this_works.steps.${step}.body`)}</p>
        </div>
      </li>
    {/each}
  </ol>

  <section class="how-this-works-faq" aria-labelledby="how-this-works-faq-heading">
    <h2 id="how-this-works-faq-heading" class="how-this-works-faq__heading">
      {$t('how_this_works.faq_heading')}
    </h2>

    <div class="how-this-works-faq__list">
      {#each $faq as item, index (index)}
        <details class="how-this-works-faq__item">
          <summary class="how-this-works-faq__question">{item.question}</summary>
          <p class="how-this-works-faq__answer">{item.answer}</p>
        </details>
      {/each}
    </div>
  </section>
</main>
