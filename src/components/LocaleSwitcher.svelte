<script>
  import { locale, t } from '../lib/i18n.js';

  function setLocale(next) {
    locale.set(next);
  }
</script>

<div class="locale-switcher" role="group" aria-label={$t('language.switch_aria')}>
  <button
    type="button"
    class="locale-switcher__btn"
    class:locale-switcher__btn--active={$locale === 'en'}
    aria-pressed={$locale === 'en'}
    onclick={() => setLocale('en')}
  >
    {$t('language.en')}
  </button>
  <button
    type="button"
    class="locale-switcher__btn"
    class:locale-switcher__btn--active={$locale === 'fr'}
    aria-pressed={$locale === 'fr'}
    onclick={() => setLocale('fr')}
  >
    {$t('language.fr')}
  </button>
</div>
