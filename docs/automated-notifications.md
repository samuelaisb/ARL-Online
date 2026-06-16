# Automated in-app notifications (Kimchi)

Kimchi chat bubbles are the only client-side automated notification system. They are queued via `notify()` in `src/lib/notification-store.js` and rendered by `KimchiNotification.svelte` + `KimchiBubble.svelte`.

**Locale source:** `locales/en.json` and `locales/fr.json` under the `kimchi` key.

---

## System behavior

| Setting | Value | Notes |
|---------|-------|-------|
| Default duration | **5000 ms** | `DEFAULT_NOTIFICATION_DURATION` in `notification-store.js` |
| Auto-dismiss | Per-bubble timer | Set in `KimchiBubble.svelte` on mount |
| Manual dismiss | Close button (×) | Calls `dismiss(id)` |
| Stack order | Newest above avatar | Multiple bubbles visible at once |
| Exit animation | 350 ms fade | Bubble pinned absolute during fade |
| Sleep mode | Suppresses all `notify()` | Except `{ force: true }` (sleep “Zzz…” bubble only) |
| Sleep toggle | Status dot click | Awake → sleep: clears queue, shows `kimchi.sleep`, disables notifications. Sleep → awake: re-enables, shows random tap message |
| Avatar tap (awake) | Random `kimchi.taps` | No-op while asleep |
| Shuffle (taps & item reactions) | No repeat until all shown | Reshuffles when cycle completes |

### Sleep suppression

When Kimchi is asleep (`setKimchiNotificationsEnabled(false)`):

- `notify()` returns `-1` and does **not** queue a bubble (unless `options.force === true`).
- The only forced bubble is `kimchi.sleep` (“Zzz…”).
- Waking Kimchi re-enables notifications and immediately shows one random tap message.

---

## Notifications by trigger

### Page load / auth state

| Trigger | Component | Locale key(s) | EN text | FR text | Duration | Conditions |
|---------|-----------|---------------|---------|---------|----------|------------|
| First visit, signed out | `KimchiNotification.svelte` | `kimchi.greeting` | Meow! I'm Kimchi, the library cat. | Miaou ! Je suis Kimchi, le chat de la bibliothèque. | **8000 ms** | Runs once when auth is ready (or immediately if Supabase not configured) and user has no session |
| Greeting follow-up (CTA) | `KimchiNotification.svelte` | `kimchi.greeting_cta`, `kimchi.greeting_link` | “New around here?” + link “See how this works” → `/howthisworks` | “C'est ta première visite ?” + “Découvre comment ça marche” | **8000 ms** | **1 s** after greeting bubble; link uses client-side `navigate()` |
| First visit, signed in | `KimchiNotification.svelte` | `kimchi.logged_in` | Meow! You're logged in, you can reserve inventory now. | Miaou ! Tu es connecté(e), tu peux réserver du matériel maintenant. | **5000 ms** | Session exists on first auth-ready check |
| Login during visit | `KimchiNotification.svelte` | `kimchi.logged_in` | (same) | (same) | **5000 ms** | User id transitions from `null` → signed-in after initial greeting handled |

### User interaction (Kimchi widget)

| Trigger | Component | Locale key(s) | EN text | FR text | Duration | Conditions |
|---------|-----------|---------------|---------|---------|----------|------------|
| Avatar click | `KimchiNotification.svelte` | `kimchi.taps` (random) | See [Tap messages](#kimchi-taps-array) | See [Tap messages](#kimchi-taps-array) | **5000 ms** | Only when awake; shuffle/no-repeat |
| Status dot → sleep | `KimchiNotification.svelte` | `kimchi.sleep` | Zzz… | Zzz… | **3500 ms** | `{ force: true }`; clears existing bubbles first |
| Status dot → wake | `KimchiNotification.svelte` | `kimchi.taps` (random) | (same as avatar tap) | (same) | **5000 ms** | Re-enables notifications, then shows tap message |

### Auth actions

| Trigger | Component | Locale key | EN text | FR text | Duration | Conditions |
|---------|-----------|------------|---------|---------|----------|------------|
| Header **Register** click | `HeaderAuth.svelte` | `kimchi.register_click` | You want to join? Awesome! 🎉 | Tu veux nous rejoindre ? Super ! 🎉 | **5000 ms** (default) | Before opening register modal |
| Reserve modal **Register** | `ReserveAuthRequiredModal.svelte` | `kimchi.register_click` | (same) | (same) | **5000 ms** (default) | Signed-out user clicks Register in auth-required dialog |
| Sign out success | `HeaderAuth.svelte`, `AccountPage.svelte` | `kimchi.signed_out` | You've signed out! See you next time 👋 | Tu t'es déconnecté(e) ! À bientôt 👋 | **5000 ms** (default) | After `signOut()` succeeds |

### Inventory browsing

| Trigger | Component | Locale key | EN text | FR text | Duration | Conditions |
|---------|-----------|------------|---------|---------|----------|------------|
| Card hover **4 s** | `InventoryCard.svelte` | `kimchi.item_reactions` (random) | See [Item reactions](#kimchi-item_reactions-array) | See [Item reactions](#kimchi-item_reactions-array) | **5000 ms** (default) | Shared 3 s cooldown across all cards; shuffle/no-repeat |
| **Reserve Inventory** click | `InventoryCard.svelte` | `kimchi.item_reactions` (random) | (same) | (same) | **5000 ms** (default) | Same cooldown/shuffle as hover; fires before opening calendar modal |

### Reservation flow (member)

| Trigger | Component | Locale key | EN text | FR text | Duration | Conditions |
|---------|-----------|------------|---------|---------|----------|------------|
| Pending reservation saved | `ItemCalendar.svelte` | `kimchi.reservation_sent` | Meow! Your reservation request is sent, AisB will review it. | Miaou ! Ta demande de réservation est envoyée, AisB va l'examiner. | **5000 ms** | After successful `POST /api/inventory/:id/reservations` when `status === 'pending'` |

### Admin actions

| Trigger | Component | Locale key | EN text | FR text | Duration | Conditions |
|---------|-----------|------------|---------|---------|----------|------------|
| Item added | `AddItemModal.svelte` | `kimchi.item_added` | Meow! New item added to the library. | Miaou ! Nouvel article ajouté à la bibliothèque. | **5000 ms** | After successful `POST /api/inventory` |
| Item removed | `AdminPanel.svelte` | `kimchi.item_removed` | Meow! Item removed from the library. | Miaou ! Article retiré de la bibliothèque. | **5000 ms** | After successful `DELETE /api/inventory/:id` |
| Reservation approved | `AdminPanel.svelte` | `kimchi.reservation_approved` | Meow! Reservation approved, the member will get an email. | Miaou ! Réservation approuvée, le membre recevra un courriel. | **5000 ms** | After successful approve API call |
| Reservation deleted | `AdminPanel.svelte` | `kimchi.reservation_deleted` | Meow! Reservation deleted. | Miaou ! Réservation supprimée. | **5000 ms** | After successful delete reservation API call |

---

## Locale arrays

### `kimchi.taps` array

| # | EN | FR |
|---|----|----|
| 1 | Meow! | Miaou ! |
| 2 | Hello! | Coucou ! |
| 3 | How's it going? | Ça va ? |
| 4 | Purr… | Ronron… |
| 5 | Meow meow! | Miaou miaou ! |
| 6 | Welcome to the Activist Resource Library! | Bienvenue à la Bibliothèque ressources activistes ! |

### `kimchi.item_reactions` array

| # | EN | FR |
|---|----|----|
| 1 | What do you think? 🤔 | Qu'est-ce que tu en penses ? 🤔 |
| 2 | Oh I haven't tried that one… | Oh, je n'ai pas encore essayé celui-là… |
| 3 | Looks nifty! | Ça a l'air sympa ! |
| 4 | That one's pretty cool 😸 | Celui-là est vraiment cool 😸 |

---

## UI-only locale keys (not `notify()` messages)

These keys support the widget chrome and accessibility; they do not queue bubbles:

| Key | EN | FR | Used in |
|-----|----|----|---------|
| `kimchi.name` | Kimchi | Kimchi | Bubble header |
| `kimchi.widget_aria` | Messages from Kimchi the cat | Messages de Kimchi le chat | Widget container |
| `kimchi.avatar_alt` | Kimchi the cat | Kimchi le chat | Avatar `<img>` |
| `kimchi.dismiss_aria` | Dismiss message | Fermer le message | Close button |
| `kimchi.tap_aria` | Say hello to Kimchi | Dire bonjour à Kimchi | Avatar button |
| `kimchi.status_online_aria` | Kimchi is awake — click to put Kimchi to sleep | Kimchi est éveillé — clique pour endormir Kimchi | Status dot (awake) |
| `kimchi.status_offline_aria` | Kimchi is asleep — click to wake Kimchi up | Kimchi dort — clique pour réveiller Kimchi | Status dot (asleep) |

---

## Related in-app messages (not Kimchi)

These are **not** queued via `notify()` but are automated UI feedback on the same flows:

| Location | Locale key(s) | When |
|----------|---------------|------|
| `InventoryCard.svelte` | `inventory.reservation_pending` / `inventory.reservation_complete` | Card status line after reserve success (5 s fade) |
| `ItemCalendar.svelte` | `calendar.reservation_pending` / `calendar.reservation_saved` | Inline calendar status after confirm |
| `AuthModal.svelte` | Various `auth.*` keys | Login/register errors and “check your email” (Supabase-driven) |

---

## Gaps / not covered

| Gap | Notes |
|-----|-------|
| **Refuse reservation** | Admin refuse succeeds with **no** Kimchi bubble (approve and delete do notify) |
| **Supabase auth emails** | Sign-up confirmation and password reset are sent by Supabase Auth, not this app |
| **Quote footer** | Rotating activist quotes (`quotes.items`) are decorative, not notifications |

---

## Source files

| File | Role |
|------|------|
| `src/lib/notification-store.js` | `notify()`, `dismiss()`, sleep gate |
| `src/components/KimchiNotification.svelte` | Widget shell, greeting/auth/tap/sleep logic |
| `src/components/KimchiBubble.svelte` | Single bubble render + auto-dismiss |
| `src/components/InventoryCard.svelte` | Item reaction hover + reserve click |
| `src/components/HeaderAuth.svelte` | Register click, sign-out |
| `src/components/AccountPage.svelte` | Sign-out |
| `src/components/ReserveAuthRequiredModal.svelte` | Register from reserve gate |
| `src/components/ItemCalendar.svelte` | Reservation sent confirmation |
| `src/components/AddItemModal.svelte` | Item added confirmation |
| `src/components/AdminPanel.svelte` | Admin action confirmations |
