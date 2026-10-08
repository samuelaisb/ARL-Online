<script>
  import {
    authReady,
    isApathyAdmin,
    openPasswordChange,
    session,
    signOut,
    userHasPasswordLogin,
  } from '../lib/auth.js';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { INVENTORY_PATH, navigate } from '../lib/router.js';
  import { t } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import { reveal } from '../lib/motion.js';
  import AccountConsultations from './AccountConsultations.svelte';
  import AccountReservations from './AccountReservations.svelte';
  import AccountShareExpertise from './AccountShareExpertise.svelte';
  import BusyLabel from './BusyLabel.svelte';
  import MemberAgreementModal from './MemberAgreementModal.svelte';
  import Skeleton from './Skeleton.svelte';

  let { onOpenLogin, onOpenRegister, onProfileSaved } = $props();

  let signingOut = $state(false);
  let signOutError = $state('');
  let showShareExpertise = $state(false);
  let shareExpertiseMounted = $state(false);
  let agreementModal = $state();

  function toggleShareExpertise() {
    showShareExpertise = !showShareExpertise;
    if (showShareExpertise) {
      shareExpertiseMounted = true;
    }
  }

  function goToInventory(event) {
    event.preventDefault();
    navigate(INVENTORY_PATH);
  }

  function openAdmin(event) {
    event.preventDefault();
    navigate('/admin');
  }

  async function handleSignOut() {
    signOutError = '';
    signingOut = true;

    try {
      await signOut();
      notify({ textKey: 'kimchi.signed_out' });
    } catch (error) {
      signOutError = error.message || $t('auth.sign_out_error');
    } finally {
      signingOut = false;
    }
  }
</script>

{#snippet actionIcon(name)}
  <svg
    class="account-actions__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {#if name === 'expertise'}
      <!-- Speech bubbles, as on the homepage Expertise link -->
      <path d="M15 9.5V5.5A1.5 1.5 0 0 0 13.5 4h-9A1.5 1.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13H6v3l3-3" />
      <path d="M10.5 9.5h9A1.5 1.5 0 0 1 21 11v5.5a1.5 1.5 0 0 1-1.5 1.5H18v3l-3.5-3h-4a1.5 1.5 0 0 1-1.5-1.5V11a1.5 1.5 0 0 1 1.5-1.5Z" />
    {:else if name === 'agreement'}
      <!-- Document -->
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    {:else if name === 'password'}
      <!-- Padlock -->
      <path d="M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    {:else if name === 'admin'}
      <!-- Shield -->
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6Z" />
    {:else}
      <!-- Sign out -->
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    {/if}
  </svg>
{/snippet}

<main id="main-content" class="container account-page">
  <!-- The band is there from the first frame; only what's inside it changes while
       sign-in loads. -->
  <header class="page-header">
    {#if !supabaseConfigured}
      <h1>{$t('account.not_available_title')}</h1>
      <p class="page-intro">{$t('account.not_available_message')}</p>
    {:else if !$authReady}
      <Skeleton variant="page" gate label={$t('auth.loading')} />
    {:else if !$session}
      <div in:reveal>
        <h1>{$t('account.sign_in_required_title')}</h1>
        <p class="page-intro">{$t('account.sign_in_required_message')}</p>
        <div class="page-header__actions">
          <button type="button" class="btn-header btn-header--secondary" onclick={onOpenLogin}>
            {$t('auth.log_in')}
          </button>
          <button type="button" class="btn-header btn-header--primary" onclick={onOpenRegister}>
            {$t('auth.register')}
          </button>
        </div>
      </div>
    {:else}
      <div in:reveal>
        <h1>{$t('account.heading')}</h1>
        <p class="account-page__email">{$session.user.email}</p>
      </div>
    {/if}
    <p class="page-header__back">
      <a href={INVENTORY_PATH} class="page-header__back-link" onclick={goToInventory}>
        {$t('account.back_to_inventory')}
      </a>
    </p>
  </header>

  {#if supabaseConfigured && $authReady && $session}
    <div class="account-actions" in:reveal>
      <button
        type="button"
        class="btn-header btn-header--secondary"
        aria-expanded={showShareExpertise}
        aria-controls="share-expertise-panel"
        onclick={toggleShareExpertise}
      >
        {@render actionIcon('expertise')}
        {$t('share_expertise.heading')}
      </button>
      <button
        type="button"
        class="btn-header btn-header--secondary"
        aria-haspopup="dialog"
        onclick={() => agreementModal?.open()}
      >
        {@render actionIcon('agreement')}
        {$t('auth.member_agreement_title')}
      </button>
      {#if userHasPasswordLogin($session.user)}
        <button
          type="button"
          class="btn-header btn-header--secondary"
          aria-haspopup="dialog"
          onclick={openPasswordChange}
        >
          {@render actionIcon('password')}
          {$t('auth.change_password')}
        </button>
      {/if}
      {#if isApathyAdmin($session)}
        <a href="/admin" class="btn-header btn-header--secondary" onclick={openAdmin}>
          {@render actionIcon('admin')}
          {$t('auth.admin')}
        </a>
      {/if}
      <button
        type="button"
        class="btn-header btn-header--secondary"
        disabled={signingOut}
        onclick={handleSignOut}
      >
        {@render actionIcon('sign-out')}
        <BusyLabel label={$t('auth.sign_out')} busyLabel={$t('auth.signing_out')} busy={signingOut} />
      </button>
    </div>

    {#if signOutError}
      <p class="account-actions__error" role="alert">{signOutError}</p>
    {/if}

    {#if shareExpertiseMounted}
      <div class="account-share-expertise-slot" hidden={!showShareExpertise}>
        <AccountShareExpertise {onProfileSaved} />
      </div>
    {/if}

    <AccountReservations />

    <AccountConsultations />

    <MemberAgreementModal bind:this={agreementModal} readOnly />
  {/if}
</main>
