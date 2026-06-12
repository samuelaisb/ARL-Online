<script>
  import { navigate, path } from '../lib/router.js';
  import { t } from '../lib/i18n.js';

  const links = [
    { href: '/', labelKey: 'site.nav_inventory' },
    { href: '/howthisworks', labelKey: 'site.nav_how_it_works' },
  ];

  function isActive(href) {
    const current = $path.replace(/\/$/, '') || '/';
    const target = href.replace(/\/$/, '') || '/';
    return current === target;
  }

  function handleNavClick(event, href) {
    event.preventDefault();
    navigate(href);
  }
</script>

<nav class="site-nav" aria-label={$t('site.nav_aria')}>
  {#each links as link (link.href)}
    <a
      href={link.href}
      class="site-nav__link"
      class:site-nav__link--active={isActive(link.href)}
      aria-current={isActive(link.href) ? 'page' : undefined}
      onclick={(event) => handleNavClick(event, link.href)}
    >
      {$t(link.labelKey)}
    </a>
  {/each}
</nav>
