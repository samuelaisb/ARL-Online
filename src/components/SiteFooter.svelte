<script>
  import { t } from '../lib/i18n.js';
  import { INVENTORY_TAGS } from '../lib/inventory.js';
  import {
    categoryToPath,
    isPlainLeftClick,
    navigateToPage,
    navigateToSection,
    path,
  } from '../lib/router.js';

  const nameKeys = {
    equipment: 'inventory.filter_equipment',
    books: 'inventory.filter_books',
    rooms: 'inventory.filter_rooms',
    expertise: 'inventory.filter_expertise',
  };

  const helpLinks = [
    { href: '/howthisworks', labelKey: 'site.nav_how_it_works' },
    { href: '/about', labelKey: 'site.nav_about' },
    { href: '/about#contact', labelKey: 'footer.contact' },
    { href: '/privacy', labelKey: 'footer.privacy' },
  ];

  const year = new Date().getFullYear();

  // Only the page itself is marked current: an item overlay's category, or /about while
  // the contact link is the one followed, aren't "this page".
  function isCurrent(href) {
    return !href.includes('#') && $path === href;
  }

  // The footer stays put across pages, so a followed link would keep focus at the
  // bottom of the next page: start it like a fresh load instead (top, focus on <h1>).
  function openPage(event, href) {
    if (!isPlainLeftClick(event)) {
      return;
    }

    event.preventDefault();
    if (href.includes('#')) {
      navigateToSection(href);
    } else {
      navigateToPage(href);
    }
  }
</script>

<footer class="site-footer">
  <div class="site-footer__inner">
    <div class="site-footer__about">
      <p class="site-footer__name">{$t('site.title')}</p>
      <p class="site-footer__blurb">{$t('footer.blurb')}</p>

      <div class="site-footer__partners">
        <span class="site-footer__partner">
          <span class="site-footer__partner-label">{$t('footer.created_by')}</span>
          <a
            class="site-footer__partner-link"
            href="https://www.fesplanet.org"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={$t('footer.fes_link_aria')}
          >
            <img
              class="site-footer__partner-logo"
              src="/assets/brand/fes-logo.webp"
              alt={$t('footer.fes_name')}
              width="120"
              height="40"
              loading="lazy"
            />
          </a>
        </span>
        <span class="site-footer__partner">
          <span class="site-footer__partner-label">{$t('footer.run_by')}</span>
          <a
            class="site-footer__partner-link"
            href="https://www.apathyisboring.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={$t('footer.aisb_link_aria')}
          >
            <img
              class="site-footer__partner-logo"
              src="/assets/brand/apathy-is-boring-wordmark.png"
              alt={$t('site.brand_name')}
              width="830"
              height="385"
              loading="lazy"
            />
          </a>
        </span>
      </div>
    </div>

    <nav class="site-footer__nav" aria-label={$t('footer.nav_aria')}>
      <div class="site-footer__group">
        <h2 id="site-footer-library" class="site-footer__heading">{$t('footer.library_heading')}</h2>
        <ul class="site-footer__links" aria-labelledby="site-footer-library">
          {#each INVENTORY_TAGS as tag (tag)}
            {@const href = categoryToPath(tag)}
            <li>
              <a
                {href}
                class="site-footer__link"
                aria-current={isCurrent(href) ? 'page' : undefined}
                onclick={(event) => openPage(event, href)}
              >
                {$t(nameKeys[tag])}
              </a>
            </li>
          {/each}
        </ul>
      </div>

      <div class="site-footer__group">
        <h2 id="site-footer-help" class="site-footer__heading">{$t('footer.help_heading')}</h2>
        <ul class="site-footer__links" aria-labelledby="site-footer-help">
          {#each helpLinks as link (link.href)}
            <li>
              <a
                href={link.href}
                class="site-footer__link"
                aria-current={isCurrent(link.href) ? 'page' : undefined}
                onclick={(event) => openPage(event, link.href)}
              >
                {$t(link.labelKey)}
              </a>
            </li>
          {/each}
          <li>
            <a
              href={$t('site.psa_link')}
              class="site-footer__link"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={$t('footer.discord_aria')}
            >
              {$t('footer.discord')}
            </a>
          </li>
        </ul>
      </div>
    </nav>
  </div>

  <p class="site-footer__legal">{$t('footer.copyright', { year })}</p>
</footer>
