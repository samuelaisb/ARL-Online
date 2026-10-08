<script>
  // Placeholder shaped like the content it stands in for, built on the real
  // containers so nothing jumps when the content arrives. Styles: "Loading & motion"
  // in app.css. The bones are aria-hidden; `label` adds a status that screen readers
  // hear only if the wait passes 1s.
  //   rows   — .admin-item-list with `count` rows, `actions` pill(s) per row;
  //            `avatar` = mentor rows, `heading` = subheading bone above (account
  //            sections; rows then stack on phones like .consultation-row).
  //   form   — intro lines, `fields` label + field pairs (last is a textarea), submit.
  //   page   — page header (h1 + one line); use with `gate` for auth gates.
  //   detail — the .item-detail grid (media, title, badge, lines, calendar);
  //            `expert` = avatar, name, bio and consultation form.
  import LoadingStatus from './LoadingStatus.svelte';

  let {
    variant = 'rows',
    count = 2,
    actions = 1,
    avatar = false,
    heading = false,
    fields = 3,
    gate = false,
    expert = false,
    label = '',
  } = $props();

  const DETAIL_LINES = ['100%', '95%', '85%', '60%'];
</script>

{#if variant === 'rows'}
  <div class="skeleton" class:skeleton--gate={gate} aria-hidden="true">
    {#if heading}
      <div class="skeleton-subheading"><span class="bone"></span></div>
    {/if}
    <ul class="admin-item-list">
      {#each Array(count) as _, index (index)}
        <li
          class="admin-item-row skeleton-sheen"
          class:admin-item-row--mentor={avatar}
          class:admin-item-row--pending={heading}
          class:consultation-row={heading}
        >
          <span class="skeleton-row__main">
            {#if avatar}
              <span class="bone bone--circle skeleton-row__avatar"></span>
            {/if}
            <span class="skeleton-row__text">
              <span class="bone bone--title" style:width={avatar ? '45%' : '55%'}></span>
              <span class="bone bone--line" style:width="35%"></span>
              {#if avatar}
                <span class="bone bone--line" style:width="75%"></span>
              {/if}
            </span>
          </span>
          {#if actions > 0}
            <span class="skeleton-row__actions">
              {#each Array(actions) as _pill, action (action)}
                <span class="bone bone--pill"></span>
              {/each}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{:else if variant === 'form'}
  <div class="skeleton skeleton-form skeleton-sheen" class:skeleton--gate={gate} aria-hidden="true">
    <div class="skeleton-form__intro">
      <span class="bone bone--line" style:width="90%"></span>
      <span class="bone bone--line" style:width="60%"></span>
    </div>
    {#each Array(fields) as _, index (index)}
      <span class="bone skeleton-form__label"></span>
      <span class="bone {index === fields - 1 ? 'bone--textarea' : 'bone--input'}"></span>
    {/each}
    <span class="bone skeleton-form__submit"></span>
  </div>
{:else if variant === 'page'}
  <div class="skeleton skeleton-page" class:skeleton--gate={gate} aria-hidden="true">
    <span class="bone skeleton-page__title"></span>
    <span class="bone bone--line skeleton-page__line"></span>
  </div>
{:else if variant === 'detail'}
  <div class="skeleton" class:skeleton--gate={gate} aria-hidden="true">
    {#if expert}
      <div class="item-detail item-detail--expertise skeleton-sheen">
        <div class="expert-detail__heading">
          <span class="bone skeleton-detail__avatar"></span>
          <span class="bone skeleton-detail__name"></span>
        </div>
        <div class="skeleton-detail__lines skeleton-detail__lines--bio">
          {#each DETAIL_LINES as width (width)}
            <span class="bone bone--line" style:width></span>
          {/each}
        </div>
        <span class="bone skeleton-detail__form"></span>
      </div>
    {:else}
      <div class="item-detail">
        <div class="item-detail__media skeleton-sheen">
          <span class="skeleton-detail__media"></span>
        </div>
        <div class="item-detail__content skeleton-sheen">
          <div class="item-detail__header">
            <span class="bone skeleton-detail__title"></span>
            <span class="bone skeleton-detail__badge"></span>
          </div>
          <div class="skeleton-detail__lines">
            {#each DETAIL_LINES as width (width)}
              <span class="bone bone--line" style:width></span>
            {/each}
          </div>
        </div>
        <div class="item-detail__calendar skeleton-sheen">
          <span class="bone skeleton-detail__calendar"></span>
        </div>
      </div>
    {/if}
  </div>
{/if}

{#if label}
  <LoadingStatus text={label} />
{/if}
