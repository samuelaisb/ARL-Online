<script>
  import { signInWithEmail, signUpWithEmail } from '../lib/auth.js';

  let dialog = $state();
  let activeMode = $state('login');
  let email = $state('');
  let password = $state('');
  let submitting = $state(false);
  let formStatus = $state('');
  let formStatusType = $state('');

  export function open(nextMode = 'login') {
    activeMode = nextMode;
    email = '';
    password = '';
    formStatus = '';
    formStatusType = '';
    dialog?.showModal();
  }

  export function close() {
    dialog?.close();
  }

  function clearFormStatus() {
    formStatus = '';
    formStatusType = '';
  }

  function showFormStatus(message, type) {
    formStatus = message;
    formStatusType = type;
  }

  function handleCancel(event) {
    event.preventDefault();
    close();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearFormStatus();

    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();

    if (!trimmedEmail || !trimmedPassword) {
      showFormStatus('Please enter your email and password.', 'error');
      return;
    }

    if (trimmedPassword.length < 6) {
      showFormStatus('Password must be at least 6 characters.', 'error');
      return;
    }

    submitting = true;

    try {
      if (activeMode === 'register') {
        const { session: newSession } = await signUpWithEmail(trimmedEmail, trimmedPassword);
        if (!newSession) {
          showFormStatus('Account created. Check your email to confirm, then log in.', 'success');
          activeMode = 'login';
          password = '';
          return;
        }
      } else {
        await signInWithEmail(trimmedEmail, trimmedPassword);
      }

      close();
    } catch (error) {
      showFormStatus(error.message || 'Authentication failed.', 'error');
    } finally {
      submitting = false;
    }
  }

  function switchMode(nextMode) {
    activeMode = nextMode;
    clearFormStatus();
    password = '';
  }
</script>

<dialog bind:this={dialog} class="modal" oncancel={handleCancel}>
  <form method="dialog" novalidate onsubmit={handleSubmit}>
    <header class="modal-header">
      <h2>{activeMode === 'register' ? 'Create account' : 'Log in'}</h2>
      <button type="button" class="icon-btn" aria-label="Close" onclick={close}>
        &times;
      </button>
    </header>

    <label for="auth-email">Email</label>
    <input
      id="auth-email"
      name="email"
      type="email"
      autocomplete="email"
      placeholder="you@example.com"
      required
      bind:value={email}
    />

    <label for="auth-password">Password</label>
    <input
      id="auth-password"
      name="password"
      type="password"
      autocomplete={activeMode === 'register' ? 'new-password' : 'current-password'}
      placeholder="••••••••"
      required
      bind:value={password}
    />

    {#if formStatus}
      <p class="status {formStatusType}" role="status" aria-live="polite">
        {formStatus}
      </p>
    {/if}

    <div class="modal-actions">
      <button type="button" class="btn-secondary" onclick={close}>Cancel</button>
      <button type="submit" class="btn-primary" disabled={submitting}>
        {#if submitting}
          {activeMode === 'register' ? 'Creating...' : 'Logging in...'}
        {:else}
          {activeMode === 'register' ? 'Create account' : 'Log in'}
        {/if}
      </button>
    </div>

    <p class="auth-modal-switch">
      {#if activeMode === 'register'}
        Already have an account?
        <button type="button" class="link-btn" onclick={() => switchMode('login')}>Log in</button>
      {:else}
        Need an account?
        <button type="button" class="link-btn" onclick={() => switchMode('register')}>Register</button>
      {/if}
    </p>
  </form>
</dialog>
