<script>
  import { onMount } from 'svelte';
  import { supabaseConfigured } from '../lib/supabase.js';
  import { authReady, initAuth, session, signOut } from '../lib/auth.js';
  import AuthModal from './AuthModal.svelte';

  let authModal = $state();
  let signingOut = $state(false);
  let signOutError = $state('');

  onMount(() => {
    initAuth();
  });

  function openLogin() {
    authModal?.open('login');
  }

  function openRegister() {
    authModal?.open('register');
  }

  async function handleSignOut() {
    signOutError = '';
    signingOut = true;

    try {
      await signOut();
    } catch (error) {
      signOutError = error.message || 'Could not sign out.';
    } finally {
      signingOut = false;
    }
  }
</script>

{#if supabaseConfigured}
  <div class="header-auth">
    {#if !$authReady}
      <span class="header-auth__loading" aria-live="polite">Loading...</span>
    {:else if $session}
      <span class="header-auth__email" title={$session.user.email}>{$session.user.email}</span>
      <button
        type="button"
        class="btn-header btn-header--secondary"
        disabled={signingOut}
        onclick={handleSignOut}
      >
        {signingOut ? 'Signing out...' : 'Sign out'}
      </button>
      {#if signOutError}
        <p class="header-auth__error" role="alert">{signOutError}</p>
      {/if}
    {:else}
      <button type="button" class="btn-header btn-header--secondary" onclick={openLogin}>
        Log in
      </button>
      <button type="button" class="btn-header btn-header--primary" onclick={openRegister}>
        Register
      </button>
    {/if}
  </div>

  <AuthModal bind:this={authModal} />
{/if}
