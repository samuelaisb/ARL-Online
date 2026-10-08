<script>
  import { tick } from 'svelte';
  import {
    PASSWORD_MIN_LENGTH,
    closePasswordPrompt,
    passwordPrompt,
    passwordUpdateErrorKey,
    session,
    updatePassword,
  } from '../lib/auth.js';
  import { t } from '../lib/i18n.js';
  import { notify } from '../lib/notification-store.js';
  import BusyLabel from './BusyLabel.svelte';

  const titleId = $props.id();

  /** Errors about what was typed; anything else (rate limit, expired session) isn't a field error. */
  const FIELD_ERROR_KEYS = ['auth.password_weak', 'auth.password_same'];

  let dialog = $state();
  let passwordInput = $state();
  let confirmInput = $state();
  let submitButton = $state();
  let password = $state('');
  let confirmPassword = $state('');
  let submitting = $state(false);
  let formStatus = $state('');
  /** Input the error is about ('password' | 'confirm' | ''): marked invalid and described by it. */
  let errorField = $state('');
  let statusMessage = $state('');

  // 'recovery' (signed in from a reset link) or 'change' (from /account); needs a session.
  const mode = $derived($session?.user ? $passwordPrompt : null);
  const accountEmail = $derived($session?.user?.email ?? '');

  $effect(() => {
    if (!dialog) return;
    if (mode && !dialog.open) {
      password = '';
      confirmPassword = '';
      formStatus = '';
      errorField = '';
      statusMessage = '';
      dialog.showModal();
    } else if (!mode && dialog.open) {
      dialog.close();
    }
  });

  function handleCancel(event) {
    event.preventDefault();
    closePasswordPrompt();
  }

  /**
   * A field error is set first so focusing the input reads it. Otherwise focus returns to
   * the submit button (disabled while saving) before the status region changes, so the
   * focus announcement doesn't cut the message off.
   */
  async function showError(message, field = '') {
    errorField = field;
    if (field) {
      formStatus = message;
      await tick();
      (field === 'confirm' ? confirmInput : passwordInput)?.focus();
    } else {
      await tick();
      submitButton?.focus();
      formStatus = message;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    formStatus = '';
    errorField = '';

    if (password.length < PASSWORD_MIN_LENGTH) {
      showError($t('auth.password_min_length'), 'password');
      return;
    }
    if (password !== confirmPassword) {
      showError($t('auth.password_mismatch'), 'confirm');
      return;
    }

    submitting = true;
    try {
      await updatePassword(password);
    } catch (error) {
      submitting = false;
      const errorKey = passwordUpdateErrorKey(error);
      showError($t(errorKey), FIELD_ERROR_KEYS.includes(errorKey) ? 'password' : '');
      return;
    }
    submitting = false;
    closePasswordPrompt();
    // Kimchi stays quiet while asleep, so screen readers also get a status line.
    statusMessage = $t('auth.password_updated');
    notify({ textKey: 'kimchi.password_updated' });
  }
</script>

<dialog bind:this={dialog} class="modal" aria-labelledby={titleId} oncancel={handleCancel}>
  <form method="dialog" novalidate onsubmit={handleSubmit}>
    <header class="modal-header">
      <h2 id={titleId}>
        {mode === 'change' ? $t('auth.change_password_title') : $t('auth.set_password_title')}
      </h2>
      <button
        type="button"
        class="icon-btn"
        aria-label={$t('auth.close_aria')}
        onclick={closePasswordPrompt}
      >
        &times;
      </button>
    </header>

    <p class="auth-intro">{$t('auth.set_password_intro', { email: accountEmail })}</p>

    <!-- Lets password managers save the new password under the right account. -->
    <input type="email" name="username" autocomplete="username" value={accountEmail} readonly hidden />

    <label for="set-password-new">{$t('auth.new_password')}</label>
    <input
      bind:this={passwordInput}
      id="set-password-new"
      name="new-password"
      type="password"
      autocomplete="new-password"
      minlength={PASSWORD_MIN_LENGTH}
      aria-describedby={errorField === 'password'
        ? 'set-password-status set-password-hint'
        : 'set-password-hint'}
      aria-invalid={errorField === 'password' || undefined}
      required
      bind:value={password}
    />
    <p id="set-password-hint" class="field-hint">{$t('auth.password_hint')}</p>

    <label for="set-password-confirm">{$t('auth.confirm_password')}</label>
    <input
      bind:this={confirmInput}
      id="set-password-confirm"
      name="confirm-password"
      type="password"
      autocomplete="new-password"
      minlength={PASSWORD_MIN_LENGTH}
      aria-describedby={errorField === 'confirm' ? 'set-password-status' : undefined}
      aria-invalid={errorField === 'confirm' || undefined}
      required
      bind:value={confirmPassword}
    />

    <!-- Always in the page (empty when there is no message) so screen readers announce changes. -->
    <p id="set-password-status" class="status error" role="status" aria-live="polite">{formStatus}</p>

    <div class="modal-actions">
      <button type="button" class="btn-secondary" onclick={closePasswordPrompt}>
        {$t('auth.cancel')}
      </button>
      <button bind:this={submitButton} type="submit" class="btn-primary" disabled={submitting}>
        <BusyLabel label={$t('auth.save_password')} busyLabel={$t('auth.saving')} busy={submitting} />
      </button>
    </div>
  </form>
</dialog>

<p class="visually-hidden" role="status">{statusMessage}</p>
