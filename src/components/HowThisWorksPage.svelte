<script>
  import { INVENTORY_PATH, isPlainLeftClick, navigate, navigateToPage } from '../lib/router.js';
  import { session } from '../lib/auth.js';
  import { faq, t } from '../lib/i18n.js';

  let { onOpenRegister } = $props();

  const steps = [
    'browse',
    'account',
    'reserve',
    'approval',
    'pickup',
  ];

  function goToInventory(event) {
    event.preventDefault();
    navigate(INVENTORY_PATH);
  }

  // Below the steps, so start the homepage like a fresh load (top, focus on its <h1>).
  function goToLibrary(event) {
    if (!isPlainLeftClick(event)) {
      return;
    }

    event.preventDefault();
    navigateToPage('/');
  }
</script>

<main id="main-content" class="container how-this-works-page">
  <header class="page-header">
    <h1>{$t('how_this_works.heading')}</h1>
    <p class="subtitle">{$t('how_this_works.subtitle')}</p>
    <p class="page-header__back">
      <a href={INVENTORY_PATH} class="page-header__back-link" onclick={goToInventory}>
        {$t('how_this_works.back_to_inventory')}
      </a>
    </p>
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

  <!-- Signed-out visitors can start here: the button opens the Register dialog. -->
  <div class="how-this-works-cta">
    {#if !$session}
      <button type="button" class="btn-header btn-header--primary" aria-haspopup="dialog" onclick={onOpenRegister}>
        {$t('how_this_works.cta_register')}
      </button>
    {/if}
    <a
      href="/"
      class="btn-header"
      class:btn-header--primary={!!$session}
      class:btn-header--secondary={!$session}
      onclick={goToLibrary}
    >
      {$t('how_this_works.cta_browse')}
    </a>
  </div>

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
