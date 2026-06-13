<script>
  import {
    isAboutRoute,
    isHowThisWorksRoute,
    isInventoryHomePath,
    navigate,
    path,
  } from '../lib/router.js';
  import { t } from '../lib/i18n.js';

  const links = [
    { href: '/', labelKey: 'site.nav_inventory', isInventory: true },
    { href: '/howthisworks', labelKey: 'site.nav_how_it_works' },
    { href: '/about', labelKey: 'site.nav_about' },
  ];

  function isActive(link) {
    const current = $path.replace(/\/$/, '') || '/';

    if (link.isInventory) {
      return isInventoryHomePath(current);
    }

    if (link.href === '/about') {
      return isAboutRoute(current);
    }

    if (link.href === '/howthisworks') {
      return isHowThisWorksRoute(current);
    }

    const target = link.href.replace(/\/$/, '') || '/';
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
      class:site-nav__link--active={isActive(link)}
      aria-current={isActive(link) ? 'page' : undefined}
      onclick={(event) => handleNavClick(event, link.href)}
    >
      {$t(link.labelKey)}
    </a>
  {/each}
</nav>
