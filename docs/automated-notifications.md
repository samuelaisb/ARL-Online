# Automated in-app notifications (Kimchi)

Kimchi chat bubbles are the only client-side automated notification system. They are queued via `notify()` or `notifyWhenIdle()` in `src/lib/notification-store.js` and rendered by `KimchiNotification.svelte` + `KimchiBubble.svelte`. What Kimchi remembers between visits (so a bubble doesn't repeat) lives in `src/lib/kimchi-memory.js`; the calendar lines and quiet days live in `src/lib/kimchi-calendar.js`.

**Locale source:** `locales/en.json` and `locales/fr.json` under the `kimchi` key.

Codes in parentheses (A1, B4, D14, F2…) are the proposal ids from the 2026-10-07 Kimchi round; the code comments use the same ids.

---

## System behavior

| Setting | Value | Notes |
|---------|-------|-------|
| Default duration | **5000 ms** | `DEFAULT_NOTIFICATION_DURATION` in `notification-store.js` |
| Message form | `{ textKey, vars?, link?: { href, ctaKey?, labelKey, vars? } }` | The bubble renders `$t(textKey, vars)` reactively, so it re-translates when the language changes. Array entries use numeric segments (`'kimchi.taps.2'`). A plain string or `{ text, link: { href, cta, label } }` still works but is frozen text (legacy). Every call site in `src/` uses the key form |
| Auto-dismiss | Per-bubble timer from mount | Pauses while the pointer is over the bubble or focus is inside it, and resumes with the time that was left (at least **1.5 s**) (F2) |
| Manual dismiss | Close button (×) | Calls `onClose` → `handleUserClose(id)` in `KimchiNotification` (dismiss, plus the nap-hint count). Timer expiry calls `dismiss(id)` directly, so it never counts as a close |
| Focus | Avatar takes it | When a bubble that holds focus leaves (timer, ×, `dismiss`, `dismissKind`, `clearNotifications`), focus moves to the Kimchi avatar button instead of dropping to `<body>` |
| Kinds | `options.kind` | A tag stored on the bubble; `dismissKind(kind)` removes every bubble with it. In use: `tap`, `sleep`, `sleep_talk`, `wake`, `nap_hint`, `offline`, `back_online`, `not_found`, `new-in-library`, `admin-arrival`, `account-consultations` |
| Stack order | Newest above avatar | Multiple bubbles visible at once |
| Exit animation | None | A closed or expired bubble leaves at once (no fade); the bubbles still showing spring into their new places (`springSlide` in `KimchiNotification`). The pop-in rises and scales with a `backOut` overshoot and never fades |
| Reduced motion | No animation | The pop-in and the stack slide are instant (`{ duration: 0 }`); no wiggle or hover growth, and the avatar's hover glow switches on without an ease. The online dot is steady in every mode (its pulse was removed on 2026-10-09) |
| Short viewports | `@media (max-height: 500px)` | 2.75rem avatar, narrower bubbles (15rem), 13 px text, and only the newest bubble visible (plus an older one that holds focus) (F7) |
| Links | In-app `/path` links | A plain left click uses `navigateToPage(path)` (scroll to top, focus the page's `h1`, waiting up to 4 s for a lazy page). `/path#id` then scrolls `#id` into view and focuses it (adding `tabindex="-1"` when needed); the URL hash isn't set. The bubble then closes. Modifier and middle clicks keep the browser's default (F5). `InventoryPanel`'s "New in the library" link opens the item with `navigateToItem` instead (see [Inventory browsing](#inventory-browsing)) |
| Sleep toggle | Status dot | A 24×24 px button over the avatar's lower-right corner around a 14 px visible dot (F4; it overlaps the avatar and takes clicks there). Awake → sleep: clears the queue, shows `kimchi.sleep`, disables notifications. Sleep → awake: re-enables and shows a wake line (D7) above the Zzz |
| Avatar tap | Awake: a tap line; asleep: sleep-talk | See [User interaction](#user-interaction-kimchi-widget) |
| Shuffle (taps & item reactions) | No repeat until all shown | Reshuffles when cycle completes |
| Hidden status line | `KimchiNotification.svelte` | A visually hidden `role="status"` line outside every dialog, filled only when `kimchi.signup_complete` or `kimchi.email_confirmed` couldn't show as a bubble (asleep, or the wait timed out). Translated once, so a language switch doesn't re-announce it |

### Sleep

Kimchi's asleep state is remembered across visits (F4): `localStorage` `arl-kimchi-asleep` = `{ since: <ms> }` while asleep, removed on wake.

- Asleep on load: notifications start disabled, the sleep photo shows, and there is no greeting or welcome.
- `notify()` returns `-1` and does **not** queue a bubble unless `options.force === true`. `notifyWhenIdle()` resolves `-1` at once.
- The forced bubbles are `kimchi.sleep` ("Zzz…") and `kimchi.sleep_talk`.
- Waking shows a wake line chosen by nap length (`kimchi.wake.short` / `.normal` / `.long`), not a tap message. A nap carried over from an earlier visit counts from when it started.
- `isKimchiAwake()` and `getKimchiAsleepSince()` expose the state. What a bubble would say must still reach the visitor while Kimchi sleeps: every confirmation has an inline message or a hidden status line (see [Related in-app messages](#related-in-app-messages-not-kimchi)).

### Ambient budget

Unprompted bubbles pass `{ ambient: true }` (S1). `notify` returns `-1` for one when:

- another ambient bubble is on screen;
- the last ambient bubble showed less than **60 s** ago;
- **3** ambient bubbles already showed in this tab session (`sessionStorage` `arl-kimchi-ambient` = `{ count, lastAt }`, with an in-memory copy when storage is blocked);
- today is a quiet day (Montréal date, `libraryTodayKey()`): Sep 30, Nov 11, Dec 6 (see [Calendar days](#calendar-days-kimchidays)).

`{ allowOnQuietDay: true }` lifts only the quiet-day block for that one call (the day's own calendar line); the rest of the budget still applies and it counts. `{ ambient: 'intro' }` (the first-visit greeting and its "how this works" link) counts toward the budget, the two together as one, but is never blocked. `isAmbientAllowed({ allowOnQuietDay })` answers whether an ambient bubble could show right now, so a caller can skip work whose only use is that bubble.

Ambient bubbles: the introduction and deep-link welcome (`'intro'`), the returning-visitor line, the calendar line, the library-versary, "New in the library", the admin pickup-day note and "all caught up". Confirmations of the visitor's own actions are never ambient.

### Waiting for idle

`notifyWhenIdle(message, duration, options)` (F1) waits until no modal `<dialog>` is open (bubbles would land behind its backdrop), and the tab is visible; then it calls `notify` and resolves its id. The bubble joins the stack like any other, **1 s** after the newest bubble (`STACK_GAP_MS`), so bubbles that waited arrive one by one instead of replacing each other; an ambient call also waits for another ambient bubble on screen to leave. Options: `timeoutMs` (default **20000**), `cancelOnPathChange` (default true), plus every `notify` option. It resolves `-1` on timeout, when the page changes while waiting, or when the bubble is suppressed (asleep, or by the ambient budget). When Kimchi is asleep, or an ambient call meets a quiet day or a spent session budget, it resolves `-1` without waiting. Load-time and deferred bubbles use it; confirmations of a click use plain `notify`.

### Memory (once-only keys)

Rule for every caller: spend a once-key only when `notify` / `notifyWhenIdle` returned an id other than `-1`, so a bubble suppressed while Kimchi sleeps (or by the budget) can still show later. `kimchi-memory.js` (S3) wraps every storage access in try/catch and stores ids, statuses, date keys and counts only (never titles, names or emails). `hasSeen()` answers true when storage is unavailable, so nothing repeats on every load.

| Key | Storage | Holds | Written by |
|-----|---------|-------|------------|
| `arl-kimchi-asleep` | local | `{ since }` while asleep | `notification-store.js` |
| `arl-kimchi-ambient` | session | `{ count, lastAt }` | `notification-store.js` |
| `arl-kimchi-logged-in` | local | `{ userId, at }` of the last "you're logged in" (or similar welcome) | `KimchiNotification.svelte` |
| `arl-kimchi-greeted` | local | `true` once this browser was greeted | `KimchiNotification.svelte` |
| `arl-kimchi-greeted-session` | session | `true` once this tab session was greeted | `KimchiNotification.svelte` |
| `arl-kimchi-tap-spam` | session | rapid-tap levels already shown (`[0, 1]`) | `KimchiNotification.svelte` |
| `arl-kimchi-seen:hints:browser` | local | `['nap']` once the nap hint showed | `KimchiNotification.svelte` |
| `arl-kimchi-seen:anniversary:<userId>` | local | years whose library-versary showed | `KimchiNotification.svelte` |
| `arl-kimchi-day:calendar` | local | Montréal date of the last calendar line | `KimchiNotification.svelte` |
| `arl-kimchi-first-seen` | local | `{ at }`, when this browser first showed a category grid | `InventoryPanel.svelte` |
| `arl-kimchi-new-item-shown` | session | `true` once "New in the library" showed in this tab | `InventoryPanel.svelte` |
| `arl-kimchi-seen:new-in-library:browser` | local | item ids already announced | `InventoryPanel.svelte` |
| `arl-kimchi-card-lines` | session | `<line>:<itemId>` card status lines already said | `InventoryCard.svelte` |
| `arl-kimchi:consultation-statuses:<userId>` | local | `{ 'role:id': status }` snapshot of `/account` consultations | `AccountConsultations.svelte` |
| `arl-kimchi-seen:consultation-closed:<userId>` | local | `role:id` keys already announced (B4) | `AccountConsultations.svelte` |
| `arl-kimchi-seen:consultation-request:<userId>` | local | request ids already announced (B5) | `AccountConsultations.svelte` |
| `arl-kimchi-seen:consultation-waiting:<userId>` | local | request ids already mentioned (C8) | `AccountConsultations.svelte` |
| `arl-kimchi-meeting-nudges` | session | `id:phase` meeting nudges shown (last 50) | `AccountConsultations.svelte` |
| `arl-kimchi-day:admin-arrival` | local | Montréal date of the last arrival note | `AdminPanel.svelte` |
| `arl-kimchi-day:admin-pickup-day` | local | Montréal date of the last pickup-day note | `AdminPanel.svelte` |
| `arl-kimchi-day:admin-queue-clear` | local | Montréal date of the last "all caught up" | `AdminPanel.svelte` |
| `arl-kimchi-probe` | local | test write, removed at once (`storageAvailable()`) | `kimchi-memory.js` |

`seen` lists keep the newest 200 ids. The privacy policy (EN/FR, "Kimchi, our library cat") discloses these notes.

---

## Notifications by trigger

### Page load / auth state

All in `KimchiNotification.svelte` unless noted. The load's welcome runs once auth is ready (or at once if Supabase isn't configured). If the page loaded on an item URL, it waits until the item overlay closes and then about **600 ms** more (D2). While the member agreement is pending (`$needsMemberAgreement`), signed-in welcomes are held; signing it gets `kimchi.signup_complete` instead.

| Trigger | Locale key(s) | EN text | FR text | Duration | Conditions |
|---------|---------------|---------|---------|----------|------------|
| First visit, signed out | `kimchi.greeting` | Meow! I'm Kimchi, the library cat. | Miaou ! Je suis Kimchi, le chat de la bibliothèque. | **8000 ms** | `localStorage` `arl-kimchi-greeted` unset and this tab session not greeted. Ambient `'intro'`. Waits for no modal dialog (`notifyWhenIdle`, `requireEmptyQueue: false`). Showing it writes both greeted keys |
| Greeting follow-up (CTA) | `kimchi.greeting_cta`, `kimchi.greeting_link` | "New around here?" + link "See how this works" → `/howthisworks` | "C'est ta première visite ?" + "Découvre comment ça marche" | **8000 ms** | **1 s** after the greeting or the deep-link welcome. Ambient `'intro'`. Not on `/howthisworks`; on a 404 the 404 line takes this slot. The link uses `navigateToPage` |
| Deep-link welcome (D2) | `kimchi.deep_link_welcome` | Meow! I'm Kimchi, the library cat. Have a look around, there's lots more to discover 🐾 | Miaou ! Je suis Kimchi, le chat de la bibliothèque. Jette un œil, il y a plein d'autres choses à découvrir 🐾 | **8000 ms** | First visit that landed on an item URL: shown about 600 ms after the overlay closes (straight into another item waits for that one), then the CTA. Ambient `'intro'`. Returning visitors get their D1 line instead, members their member welcome |
| Returning visitor (D1) | `kimchi.greeting_returning` (random of 3) | See [Returning greetings](#kimchigreeting_returning-array) | (same) | **5000 ms** | This browser was greeted before (`arl-kimchi-greeted`) and this tab session wasn't (`arl-kimchi-greeted-session`). Ambient, `notifyWhenIdle`. Same tab session: no greeting. Replaced by the calendar line on a calendar day |
| Calendar day (D14) | `kimchi.days.<id>` | See [Calendar days](#calendar-days-kimchidays) | (same) | **10000 ms** | Once per Montréal day per browser (`arl-kimchi-day:calendar`; not tried without storage). Ambient with `allowOnQuietDay`, `notifyWhenIdle`. Signed out: replaces the D1 line on that load, and also shows in an already-greeted tab session; first-time visitors never get it on their introduction load. Signed in: after the member welcome has left, if the budget allows (otherwise a later load that day). On the three quiet days it is the only ambient bubble |
| First visit, signed in | `kimchi.logged_in` | Meow! You're logged in, you can reserve inventory now. | Miaou ! Tu es connecté(e), tu peux réserver du matériel maintenant. | **5000 ms** | Session exists on the first auth-ready check, no library-versary today, and the bubble hasn't been shown to this user in the last hour (`localStorage` `arl-kimchi-logged-in` = `{ userId, at }`; if storage is unavailable it shows every load). Waits for no modal dialog (`notifyWhenIdle`, `requireEmptyQueue: false`), so it no longer lands behind **Set a new password**. Held while the member agreement is pending |
| Library-versary (D12) | `kimchi.anniversary` (`{year}`) | Meow! Happy library-versary! 🎂 You've been a member since {year}. | Miaou ! Joyeux anniversaire de membre ! 🎂 Tu es membre depuis {year}. | **8000 ms** | Today's month and day (Montréal) match `user.created_at` (Montréal) and at least one year has passed; Feb 29 accounts celebrate on Feb 28 in common years. Once per user per year (`arl-kimchi-seen:anniversary:<userId>`). Ambient, waits for dialogs. Replaces `logged_in`, which shows instead if this is suppressed |
| Email confirmed (A4) | `kimchi.email_confirmed` | Meow! Your email is confirmed. Welcome to the library! 🎉 | Miaou ! Ton courriel est confirmé. Bienvenue à la bibliothèque ! 🎉 | **8000 ms** | The page was opened from the sign-up confirmation link (`#type=signup` with `access_token`, read by `takeAuthCallback` → `authCallbackSignupConfirmed` in `supabase.js`). Replaces `logged_in` and writes `arl-kimchi-logged-in`. Waits for dialogs. If it can't show (asleep), the hidden status line carries it |
| Login during visit | `kimchi.logged_in` | (same) | (same) | **5000 ms** | User id goes from `null` to signed in after the load's welcome; always shows and refreshes the hourly timestamp. Held while the member agreement is pending (that path gets `signup_complete`). Signing out removes `arl-kimchi-logged-in`, so a login after an OAuth redirect still confirms |
| Sign-up complete (A2) | `kimchi.signup_complete` | Meow! You're all set, welcome to the library! 🎉 | Miaou ! C'est tout bon, bienvenue à la bibliothèque ! 🎉 | **8000 ms** | `needsMemberAgreement` goes from true to false for the same user (**Finish creating your account** submit, or `applyPendingOAuthSignup`). Waits for dialogs for up to 60 s and keeps waiting while an item overlay closes (`cancelOnPathChange: false`). Writes `arl-kimchi-logged-in`, so no "you can reserve now" behind the agreement dialog. If it can't show, the hidden status line carries it |
| Page not found (D9) | `kimchi.not_found` | Mrrp? I've sniffed every shelf, and this page isn't on any of them 🐾 | Mrrp ? J'ai reniflé toutes les étagères et cette page n'y est pas 🐾 | **6000 ms** | Unknown path (`!isKnownAppPath`), once per path per page load, kind `not_found`. On a cold landing it comes 1 s after the welcome (in the CTA's slot), or alone in an already-greeted tab session; it also fires on in-app navigation to an unknown path. Never on item routes; it never repeats the path |
| Inventory failed to load (C5) | `kimchi.inventory_load_failed` | Hmm, I can't get the shelves open right now 😿 Try reloading the page in a moment. | Hum, je n'arrive pas à ouvrir les étagères pour l'instant 😿 Recharge la page dans un moment. | **8000 ms** | `App.svelte`. `loadError` is set and the visitor is on `/` or a category grid. `notifyWhenIdle` (no modal, visible tab; stacks on any bubble already showing). Once per failed load, spent only when shown; a wait cancelled by a page change retries on the next homepage or grid page. Inline carriers: `HomePage`'s `home.load_error` (`role="alert"`) and `InventoryPanel`'s existing alert |

### User interaction (Kimchi widget)

All in `KimchiNotification.svelte`.

| Trigger | Locale key(s) | EN text | FR text | Duration | Conditions |
|---------|---------------|---------|---------|----------|------------|
| Avatar click (awake) | `kimchi.taps` (random) | See [Tap messages](#kimchitaps-array) | See [Tap messages](#kimchitaps-array) | **5000 ms** | Shuffle/no-repeat, sent as `kimchi.taps.<index>` with kind `tap`. Stacks on whatever is already showing, like every bubble |
| Rapid taps (D3) | `kimchi.tap_spam.0` / `.1` | See [Rapid taps](#kimchitap_spam-array) | (same) | **5000 ms** | `.0` at 5 taps within 3 s, `.1` at 12 within 8 s, each once per tab session (`sessionStorage` `arl-kimchi-tap-spam`). Kind `tap`. While one is on screen, taps only count |
| Avatar click (asleep) (D4) | `kimchi.sleep_talk` | Zzz… mrrp? I'm napping. The little dot next to me wakes me up. | Zzz… mrrp ? Je fais la sieste. Le petit point à côté de moi me réveille. | **4000 ms** | `{ force: true }`, kind `sleep_talk`. At most once per 20 s and 3 times per nap |
| Status dot → sleep | `kimchi.sleep` | Zzz… | Zzz… | **3500 ms** | `{ force: true }`, kind `sleep`; clears existing bubbles first; writes `arl-kimchi-asleep` |
| Status dot → wake (D7) | `kimchi.wake.short` / `.normal` / `.long` | See [Wake lines](#kimchiwake) | (same) | **5000 ms** | `.short` for a nap under 10 s, `.long` over an hour (including a nap carried over from an earlier visit), `.normal` otherwise. Kind `wake`. Stacks above the Zzz and any sleep-talk, which leave on their own timers |
| × on 3 bubbles within 2 min (D5) | `kimchi.nap_hint` | Too chatty? Click the little green dot by my photo and I'll take a nap 😴 | Je jase trop ? Clique sur le petit point vert à côté de ma photo et je vais faire une sieste 😴 | **8000 ms** | While awake; timer expiries don't count. Once per browser (`arl-kimchi-seen:hints:browser`), kind `nap_hint` |
| Connection lost (B7) | `kimchi.offline` | Mrrp… looks like you're offline. Wait for the connection before sending anything, I'll keep watch 🐾 | Mrrp… on dirait que tu es hors ligne. Attends que la connexion revienne avant d'envoyer quoi que ce soit, je fais le guet 🐾 | **10000 ms** | Browser `offline` and still offline 2.5 s later. At most one per 2 minutes. Kind `offline` |
| Back online (B7) | `kimchi.back_online` | Meow! You're back online 😺 | Miaou ! Te revoilà en ligne 😺 | **4000 ms** | Browser `online` after an offline notice actually showed: it stacks above that notice. Kind `back_online` |

### Auth actions

| Trigger | Component | Locale key | EN text | FR text | Duration | Conditions |
|---------|-----------|------------|---------|---------|----------|------------|
| Header **Register** click | `HeaderAuth.svelte` | `kimchi.register_click` | You want to join? Awesome! 🎉 | Tu veux nous rejoindre ? Super ! 🎉 | **5000 ms** (default) | Before opening register modal |
| Reserve modal **Register** | `ReserveAuthRequiredModal.svelte` | `kimchi.register_click` | (same) | (same) | **5000 ms** (default) | Signed-out user clicks Register in auth-required dialog |
| Sign out success | `HeaderAuth.svelte`, `AccountPage.svelte` | `kimchi.signed_out` | You've signed out! See you next time 👋 | Tu t'es déconnecté(e) ! À bientôt 👋 | **5000 ms** (default) | After `signOut()` succeeds |
| Header **Sign out** fails (C3) | `HeaderAuth.svelte` | `kimchi.sign_out_failed` | Mrrp… I couldn't sign you out. Check your connection and try again. | Mrrp… je n'ai pas pu te déconnecter. Vérifie ta connexion et réessaie. | **8000 ms** | `signOut()` throws (session kept). The header also shows `auth.sign_out_error` as a visible `role="alert"` under the buttons until the next attempt or sign-out, and focus goes back to **Sign out** |
| Sign out from **Finish creating your account** (A9) | `CompleteSignupModal.svelte` | `kimchi.signup_paused` | You're signed out. No rush! Browse all you like, and sign in again when you're ready to finish joining 👋 | Tu es déconnecté(e). Pas de presse ! Explore autant que tu veux, et reconnecte-toi quand tu seras prêt(e) à finir ton inscription 👋 | **8000 ms** | Replaces `kimchi.signed_out` on this path only |
| New password saved | `SetPasswordModal.svelte` | `kimchi.password_updated` | Meow! Your password is updated. | Miaou ! Ton mot de passe est à jour. | **5000 ms** (default) | After `updatePassword()` succeeds, from a reset link or **Change password** on `/account` |

### Pages

| Trigger | Component | Locale key | EN text | FR text | Duration | Conditions |
|---------|-----------|------------|---------|---------|----------|------------|
| About contact form sent (A5) | `AboutPage.svelte` | `kimchi.contact_sent` | Meow! Your message is on its way, the team will get back to you by email. | Miaou ! Ton message est en route, l'équipe te répondra par courriel. | **5000 ms** (default) | `POST /api/contact` returns 200; the inline `about.contact_success` status stays the carrier |

### Inventory browsing

| Trigger | Component | Locale key(s) | EN text | FR text | Duration | Conditions |
|---------|-----------|---------------|---------|---------|----------|------------|
| Card hover **4 s** (mouse pointers only) | `InventoryCard.svelte` | `kimchi.card_reactions.unavailable` / `check_availability` / `expertise`, then `kimchi.item_reactions` (random) | See [Card status lines](#kimchicard_reactions) and [Item reactions](#kimchiitem_reactions-array) | (same) | **5000 ms** (default) | Starts only for `pointerType === 'mouse'` (touch and pen don't) (F6). The card's status line comes first (Unavailable badge, Check availability badge, or a mentor card), once per item per tab session (`sessionStorage` `arl-kimchi-card-lines` = `[<line>:<itemId>]`, spent only when the bubble shows) (D8). After that, random reactions as `kimchi.item_reactions.<index>`, except on mentor cards, which stay quiet. Shared 3 s cooldown across all cards; shuffle/no-repeat. Clicking the card title or **Reserve Inventory** / **Request Consultation** cancels a pending hover reaction |
| New in the library (D13) | `InventoryPanel.svelte` | `kimchi.new_in_library` (`{title}`) + link `kimchi.new_in_library_link` | New in the library: {title}! 🆕 + link "Take a look" | Nouveauté à la bibliothèque : {title} ! 🆕 + lien « Jette un œil » | **8000 ms** | A category grid other than Expertise, not under an item overlay, for non-admins. The newest item on that shelf (mentors excluded) created after this browser's first-seen time (`localStorage` `arl-kimchi-first-seen` = `{ at }`, written the first time this browser shows a grid; nothing is announced on that load, or when the key is unreadable) and within the last 14 days (`createdAt` from `GET /api/inventory`). `notifyWhenIdle` with `ambient: true`, kind `new-in-library`. One per tab session (`arl-kimchi-new-item-shown`); each item once per browser (`arl-kimchi-seen:new-in-library:browser`). Keys are spent only when the bubble shows. The link opens the item with `navigateToItem` (a capturing click listener scoped to the bubble, removed when it leaves); modifier clicks keep the browser default |

### Reservation flow (member)

| Trigger | Component | Locale key | EN text | FR text | Duration | Conditions |
|---------|-----------|------------|---------|---------|----------|------------|
| Pending reservation saved | `ItemCalendar.svelte` | `kimchi.reservation_sent` | Meow! Your reservation request is sent, AisB will review it. | Miaou ! Ta demande de réservation est envoyée, AisB va l'examiner. | **5000 ms** | After successful `POST /api/inventory/:id/reservations` when `status === 'pending'` |
| Item overlay closed after a pending request (C1) | `App.svelte` | `kimchi.track_request_cta` + link `kimchi.track_request_link` (→ `/account`) | Want to follow your request? + link "See your reservations" | Tu veux suivre ta demande ? + lien « Voir tes réservations » | **8000 ms** | Armed in `handleReserveSuccess` when `status === 'pending'` and the item isn't expertise. Fires about 600 ms after the overlay closes onto a page other than `/account`, via `notifyWhenIdle` (waits out `reservation_sent` and any dialog). Once per page load, spent only when shown; if it didn't show it stays armed for the next close; reaching `/account` disarms it. Inline carrier: the sentence about the account page in `calendar.reservation_pending` / `inventory.reservation_pending` |
| Consultation request sent | `ConsultationRequestForm.svelte` | `kimchi.consultation_sent` | Meow! Your consultation request is sent to the expert. | Miaou ! Ta demande de consultation est envoyée à l'expert. | **5000 ms** | After successful consultation submit on an expertise item |
| Reservation request withdrawn | `AccountReservations.svelte` | `kimchi.reservation_withdrawn` | Meow! Your request is withdrawn. | Miaou ! Ta demande est retirée. | **5000 ms** | Member withdraws a pending equipment/book/room request from `/account` |
| Reservation cancelled | `AccountReservations.svelte` | `kimchi.reservation_cancelled` | Meow! Reservation cancelled, the team has been told. | Miaou ! Réservation annulée, l'équipe est avisée. | **5000 ms** | Member cancels an approved booking that has not started from `/account` |
| Mentor profile published | `AccountShareExpertise.svelte` | `kimchi.mentor_profile_published` | Meow! Your mentor profile is on the Expertise list. | Miaou ! Ton profil de mentor est dans la liste Expertise. | **5000 ms** | After successful `POST /api/account/mentor-profile` |
| Mentor profile updated | `AccountShareExpertise.svelte` | `kimchi.mentor_profile_updated` | Meow! Your mentor profile is updated. | Miaou ! Ton profil de mentor est à jour. | **5000 ms** | After successful `PATCH /api/account/mentor-profile` |

### Consultations on `/account`

All in `AccountConsultations.svelte`. Texts are in [Consultation messages](#consultation-messages). `/account` shows **at most one load-time consultation bubble per visit**, in the priority B6 > B4 > B5 > C8. Those bubbles use `notifyWhenIdle` with kind `account-consultations` and are removed when the panel unmounts ("on this page" and "below" stop being true). None of them contains a Zoom link, a member's email, time slots or a summary.

| Trigger | Locale key(s) | Duration | Conditions |
|---------|---------------|----------|------------|
| Consultation scheduled | `kimchi.consultation_scheduled`, or `kimchi.consultation_scheduled_plain` | **5000 ms** | Expert schedules from `/account`. The plain version (no "invitations are on their way") shows when the response has `emailSent === false` |
| Follow-up booked | `kimchi.follow_up_booked`, or `kimchi.follow_up_booked_plain` | **5000 ms** | Expert books a follow-up (`POST /api/consultations/:id/follow-up` succeeded). Plain version when `emailSent === false` |
| Consultation cancelled (A7) | Member: `kimchi.consultation_withdrawn` (pending) / `consultation_cancelled_member` (scheduled). Expert: `consultation_closed_expert` (pending) / `consultation_cancelled_expert` (scheduled). Plain: `consultation_withdrawn_plain`, `consultation_cancelled_plain`, `consultation_closed_expert_plain` | **5000 ms** | Member or expert cancels on `/account`; the version depends on the role and the status before the cancel. The "has been told" versions need `emailSent !== false`; a member's also needs `otherPartyEmailed === true` from the server (a mentor may have no email), an expert's `otherPartyEmailed !== false`. Otherwise the plain version shows |
| Meeting starting soon / now (B6) | `kimchi.meeting_starting_soon` (`{minutes}`) / `kimchi.meeting_live` | **10000 ms** | The earliest scheduled meeting with a Zoom link, either role, starts within 15 min or started less than 15 min ago. Checked at load and on each tick of the shared 60 s clock, only on a visible tab (`notifyWhenIdle`). Once per id and phase per tab (`sessionStorage` `arl-kimchi-meeting-nudges`). The row also shows a **Starts in N min** or **Happening now** chip |
| Consultation closed by the other side (B4) | Member: `kimchi.consultation_cancelled_by_expert` / `consultation_declined` (refused). Expert: `kimchi.consultation_cancelled_by_member` | **8000 ms** | On load, a row this browser last saw as pending or scheduled is now refused, or cancelled by someone other than the viewer's role. Snapshot in `localStorage` `arl-kimchi:consultation-statuses:<userId>` (`{ 'role:id': status }`), so never on a first visit. Once per row via `arl-kimchi-seen:consultation-closed:<userId>`, spent only on a real id (while Kimchi is awake, an unannounced row keeps its old status in the snapshot until its bubble shows). Experts hear only about a member's cancel, with the member never named. Those rows show for that visit in a **Changed since your last visit** list (`account_consultations.recent_heading`) outside the collapsed Past list, which also carries them while Kimchi sleeps |
| New consultation requests (B5) | `kimchi.expert_requests_waiting_one` / `_other` (`{count}`) | **8000 ms** | On load, the mentor has pending requests not yet announced in this browser (`arl-kimchi-seen:consultation-request:<userId>`, ids marked only when the bubble shows). `/account` only |
| Consultation request still waiting (C8) | `kimchi.consultation_still_waiting` (`{title}`, `{date}`) + `_cta` / `_link` → `/about#contact` | **10000 ms** | On load, the member's oldest pending request is at least 7 Montréal days old and hasn't been mentioned (`arl-kimchi-seen:consultation-waiting:<userId>`). The date follows a language switch. The link scrolls to and focuses About's contact section |

### Admin actions

`AdminPanel.svelte` unless noted. Texts are in [Admin messages](#admin-messages). No admin bubble claims an email went out when the response says `emailSent === false`.

| Trigger | Locale key(s) | Duration | Conditions |
|---------|---------------|----------|------------|
| Item added (D11) | `kimchi.item_added_tag.equipment` / `books` / `rooms` / `expertise`, falling back to `kimchi.item_added` | **5000 ms** | `AddItemModal.svelte`, after successful `POST /api/inventory`; picked from the response's `item.tag` |
| Item removed (A8) | `kimchi.item_removed_notified` / `kimchi.mentor_removed_notified`, else `kimchi.item_removed` | **9000 ms** (notified) / **5000 ms** | After successful `DELETE /api/inventory/:id`. The "emailed" versions only when `emailSent === true` and the item had active rows (equipment, books, rooms: pending or upcoming; a mentor: pending, or scheduled and not held) |
| Mentor updated | `kimchi.mentor_updated` | **5000 ms** | `MentorBrowser.svelte`, after successful `PATCH /api/inventory/:id` from the admin Mentors list |
| Reservation approved | `kimchi.reservation_approved`, or `kimchi.reservation_approved_plain` | **5000 ms** | After a successful approve of an equipment, book or room request. Plain when `emailSent === false` |
| Consultation approved (A3) | `kimchi.consultation_scheduled`; no mentor email: `kimchi.consultation_scheduled_no_expert_email` (or `_no_expert_email_no_zoom` when the response has no `zoomJoinUrl`); `emailSent === false`: `kimchi.consultation_scheduled_plain` | **9000 ms** (no mentor email) / **5000 ms** | Approving a consultation schedules it, so the bubble says "scheduled". Plain wins over the no-email versions |
| Admin follow-up booked (A3) | `kimchi.follow_up_booked*`, the same four variants | **9000 ms** (no mentor email) / **5000 ms** | Edit Reservations → **Book a follow-up** succeeded |
| Request refused (A1) | `kimchi.reservation_refused` / `kimchi.consultation_refused`; `_plain` versions when `emailSent === false` | **5000 ms** | After `POST …/refuse` succeeds |
| Reservation deleted (A8) | `kimchi.reservation_deleted_notified` / `kimchi.consultation_deleted_notified`, else `kimchi.reservation_deleted` | **5000 ms** | After a successful delete. The "emailed" versions only when `emailSent === true` and the row was active (not a held meeting, not an ended or no-email booking) |
| Admin arrival (B2) | `kimchi.admin_arrival.staff_only` / `pending_due` / `consult_waiting` (`{count}`) | **9000 ms** | The first successful `GET /api/admin/inventory` of a page load. First match wins: pending consultations for a mentor with no email; pending equipment, book or room requests starting on or before today (Montréal); consultation requests made 7 or more days ago. Not ambient; `notifyWhenIdle`, kind `admin-arrival`. Once per Montréal day (`arl-kimchi-day:admin-arrival`), spent only when shown. The pending rows carry the same facts as pills (`admin.no_mentor_email`, `admin.starts_today`, `admin.start_overdue`) |
| Pickup day (B2) | `kimchi.admin_arrival.pickup_day` (`{pickups}`, `{returns}`) | **9000 ms** | Tuesdays only, after the arrival check: reserved equipment and books starting or ending today, when there is at least one. About 1 s after the arrival note. Ambient, `notifyWhenIdle`, kind `admin-arrival`. Once per Montréal day (`arl-kimchi-day:admin-pickup-day`). Both B2 notes are dismissed when `AdminPanel` unmounts |
| Pending queue cleared (D10) | `kimchi.pending_queue_clear` | **5000 ms** | 1.2 s after the admin's own approve or refuse empties Pending, when the queue held 3 or more requests during the visit. Ambient. Once per Montréal day (`arl-kimchi-day:admin-queue-clear`) |

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

### `kimchi.greeting_returning` array

| # | EN | FR |
|---|----|----|
| 1 | Meow! Welcome back 😸 | Miaou ! Content de te revoir 😸 |
| 2 | Oh, you're back! Purr… | Oh, te revoilà ! Ronron… |
| 3 | Meow! Nice to see you at the library again. | Miaou ! Ça fait plaisir de te revoir à la bibliothèque. |

### `kimchi.tap_spam` array

| # | EN | FR |
|---|----|----|
| 1 (5 taps in 3 s) | Okay, okay! Purr purr purr… 😹 | OK, OK ! Ronron ronron… 😹 |
| 2 (12 taps in 8 s) | Whoa, that's a lot of petting! I'm hiding under a bookshelf 🙀 | Wow, ça fait beaucoup de caresses ! Je vais me cacher sous une étagère 🙀 |

### `kimchi.wake`

| Key | EN | FR |
|-----|----|----|
| `kimchi.wake.normal` | Yawn… Meow, I'm awake! 😺 | Aaah… Miaou, je suis réveillé ! 😺 |
| `kimchi.wake.short` | Already? I was just getting comfy 😹 | Déjà ? Je venais juste de m'installer 😹 |
| `kimchi.wake.long` | What a nap! Did I miss anything? | Quelle sieste ! J'ai manqué quelque chose ? |

### `kimchi.card_reactions`

| Key | EN | FR |
|-----|----|----|
| `kimchi.card_reactions.unavailable` | This one's booked right now, but other dates may be free 📅 | C'est réservé en ce moment, mais d'autres dates sont peut-être libres 📅 |
| `kimchi.card_reactions.check_availability` | Busy week for this one! Try looking a bit further ahead on the calendar. | Semaine chargée ! Regarde un peu plus loin dans le calendrier. |
| `kimchi.card_reactions.expertise` | They know their stuff! Request a free consultation 💬 | Cette personne s'y connaît ! Demande-lui une consultation gratuite 💬 |

### Consultation messages

| Key | EN | FR |
|-----|----|----|
| `kimchi.consultation_scheduled` | Meow! Meeting scheduled, Zoom invitations are on their way. | Miaou ! Rencontre planifiée, les invitations Zoom sont en route. |
| `kimchi.consultation_scheduled_plain` | Meow! Meeting scheduled. | Miaou ! Rencontre planifiée. |
| `kimchi.follow_up_booked` | Meow! Follow-up booked, Zoom invitations are on their way. | Miaou ! Suivi planifié, les invitations Zoom sont en route. |
| `kimchi.follow_up_booked_plain` | Meow! Follow-up booked. | Miaou ! Suivi planifié. |
| `kimchi.consultation_withdrawn` | Meow! Request withdrawn, and {title} has been told. | Miaou ! Demande retirée, et on a prévenu {title}. |
| `kimchi.consultation_withdrawn_plain` | Meow! Request withdrawn. | Miaou ! Demande retirée. |
| `kimchi.consultation_cancelled_member` | Meow! Meeting cancelled, and {title} has been told. | Miaou ! Rencontre annulée, et on a prévenu {title}. |
| `kimchi.consultation_cancelled_plain` | Meow! Meeting cancelled. | Miaou ! Rencontre annulée. |
| `kimchi.consultation_closed_expert` | Meow! Request cancelled, and the member has been told. Thanks for answering 💛 | Miaou ! Demande annulée, et on a prévenu le membre. Merci d'avoir répondu 💛 |
| `kimchi.consultation_closed_expert_plain` | Meow! Request cancelled. Thanks for answering 💛 | Miaou ! Demande annulée. Merci d'avoir répondu 💛 |
| `kimchi.consultation_cancelled_expert` | Meow! Meeting cancelled, and the member has been told. | Miaou ! Rencontre annulée, et on a prévenu le membre. |
| `kimchi.consultation_cancelled_by_expert` | Oh no, {title} had to cancel your consultation 😿 You're welcome to send a new request whenever you're ready. | Oh non, {title} a dû annuler ta consultation 😿 Tu peux envoyer une nouvelle demande quand tu veux. |
| `kimchi.consultation_declined` | Your consultation request with {title} didn't go ahead this time 😿 Other experts are on the Expertise list. | Ta demande de consultation avec {title} n'a pas pu avoir lieu cette fois 😿 D'autres experts sont dans la liste Expertise. |
| `kimchi.consultation_cancelled_by_member` | Heads up: a member cancelled their consultation with you. Nothing more to do on that one 🐾 | Petite note : un membre a annulé sa consultation avec toi. Rien d'autre à faire de ton côté 🐾 |
| `kimchi.expert_requests_waiting_one` | Meow! A new consultation request is waiting for you. Pick a time on it below 🗓️ | Miaou ! Une nouvelle demande de consultation t'attend. Choisis un moment ci-dessous 🗓️ |
| `kimchi.expert_requests_waiting_other` | Meow! {count} new consultation requests are waiting for you. Pick a time on each one below 🗓️ | Miaou ! {count} nouvelles demandes de consultation t'attendent. Choisis un moment pour chacune ci-dessous 🗓️ |
| `kimchi.meeting_starting_soon` | Meow! Your consultation starts in {minutes} min ⏰ The Join Zoom meeting link is on this page. | Miaou ! Ta consultation commence dans {minutes} min ⏰ Le lien pour rejoindre la rencontre Zoom est sur cette page. |
| `kimchi.meeting_live` | Meow, it's meeting time! The Join Zoom meeting link is on this page 🐾 | Miaou, c'est l'heure de la rencontre ! Le lien pour rejoindre la rencontre Zoom est sur cette page 🐾 |
| `kimchi.consultation_still_waiting` | Your consultation request with {title} has been waiting since {date}. | Ta demande de consultation avec {title} attend depuis le {date}. |
| `kimchi.consultation_still_waiting_cta` / `_link` | Need a hand? + link "Contact us" | Besoin d'un coup de main ? + lien « Écris-nous » |

The older `kimchi.consultation_cancelled` ("…everyone has been notified") is no longer used: the A7 lines above replaced it.

### Admin messages

| Key | EN | FR |
|-----|----|----|
| `kimchi.item_added` | Meow! New item added to the library. | Miaou ! Nouvel article ajouté à la bibliothèque. |
| `kimchi.item_added_tag.equipment` | Meow! New equipment on the shelf, ready to lend. | Miaou ! Du nouveau matériel sur l'étagère, prêt à être emprunté. |
| `kimchi.item_added_tag.books` | Meow! A new book on the shelf 📚 I call dibs on the box. | Miaou ! Un nouveau livre sur l'étagère 📚 La boîte est à moi ! |
| `kimchi.item_added_tag.rooms` | Meow! New room added. Plenty of space for a cat nap. | Miaou ! Nouvelle salle ajoutée. Plein de place pour une sieste de chat. |
| `kimchi.item_added_tag.expertise` | Meow! A new mentor joined the Expertise list. | Miaou ! Un nouveau mentor s'est joint à la liste Expertise. |
| `kimchi.item_removed` | Meow! Item removed from the library. | Miaou ! Article retiré de la bibliothèque. |
| `kimchi.item_removed_notified` | Meow! Item removed. Everyone with a request or booking for it has been emailed. | Miaou ! Article retiré. Toutes les personnes qui avaient une demande ou une réservation pour cet article ont reçu un courriel. |
| `kimchi.mentor_removed_notified` | Meow! Mentor removed. Members with a pending or upcoming consultation have been emailed. | Miaou ! Mentor retiré. Les membres qui avaient une consultation en attente ou à venir ont reçu un courriel. |
| `kimchi.mentor_updated` | Meow! Mentor details saved. | Miaou ! Les détails du mentor sont enregistrés. |
| `kimchi.reservation_approved` | Meow! Reservation approved, the member will get an email. | Miaou ! Réservation approuvée, le membre recevra un courriel. |
| `kimchi.reservation_approved_plain` | Meow! Reservation approved. | Miaou ! Réservation approuvée. |
| `kimchi.consultation_scheduled_no_expert_email` | Meow! Meeting scheduled. This mentor has no email on file, so only the member was invited. The Zoom link is in Edit Reservations. | Miaou ! Rencontre planifiée. Ce mentor n'a pas de courriel au dossier, alors seul le membre a été invité. Le lien Zoom est dans Modifier les réservations. |
| `kimchi.consultation_scheduled_no_expert_email_no_zoom` | Meow! Meeting scheduled. This mentor has no email on file, so only the member was invited. | Miaou ! Rencontre planifiée. Ce mentor n'a pas de courriel au dossier, alors seul le membre a été invité. |
| `kimchi.follow_up_booked_no_expert_email` | Meow! Follow-up booked. This mentor has no email on file, so only the member was invited. The Zoom link is in Edit Reservations. | Miaou ! Suivi planifié. Ce mentor n'a pas de courriel au dossier, alors seul le membre a été invité. Le lien Zoom est dans Modifier les réservations. |
| `kimchi.follow_up_booked_no_expert_email_no_zoom` | Meow! Follow-up booked. This mentor has no email on file, so only the member was invited. | Miaou ! Suivi planifié. Ce mentor n'a pas de courriel au dossier, alors seul le membre a été invité. |
| `kimchi.reservation_refused` | Meow! Request refused, the member will get an email. | Miaou ! Demande refusée, le membre recevra un courriel. |
| `kimchi.reservation_refused_plain` | Meow! Request refused. | Miaou ! Demande refusée. |
| `kimchi.consultation_refused` | Meow! Consultation request refused, the member will get an email. | Miaou ! Demande de consultation refusée, le membre recevra un courriel. |
| `kimchi.consultation_refused_plain` | Meow! Consultation request refused. | Miaou ! Demande de consultation refusée. |
| `kimchi.reservation_deleted` | Meow! Reservation deleted. | Miaou ! Réservation supprimée. |
| `kimchi.reservation_deleted_notified` | Meow! Reservation deleted, the member has been emailed. | Miaou ! Réservation supprimée, le membre a reçu un courriel. |
| `kimchi.consultation_deleted_notified` | Meow! Consultation cancelled, the member has been emailed. | Miaou ! Consultation annulée, le membre a reçu un courriel. |
| `kimchi.admin_arrival.staff_only` | Psst! Consultation requests only staff can schedule (no mentor email): {count}. They're under Pending Reservations. | Psst ! Demandes de consultation que seule l'équipe peut planifier (mentor sans courriel) : {count}. Elles sont dans Réservations en attente. |
| `kimchi.admin_arrival.pending_due` | Psst! Pending requests that start today or earlier: {count}. Maybe review those first? | Psst ! Demandes en attente qui commencent aujourd'hui ou avant : {count}. Tu veux peut-être les regarder en premier ? |
| `kimchi.admin_arrival.consult_waiting` | Psst! Consultation requests waiting a week or more: {count}. Time to nudge the mentors? | Psst ! Demandes de consultation en attente depuis une semaine ou plus : {count}. Un petit rappel aux mentors ? |
| `kimchi.admin_arrival.pickup_day` | Meow! It's pickup day 🐾 Going out today: {pickups}. Coming back today: {returns}. | Miaou ! C'est jour de cueillette 🐾 À remettre aujourd'hui : {pickups}. À récupérer aujourd'hui : {returns}. |
| `kimchi.pending_queue_clear` | Purr… no requests left to review. All caught up! 🐾 | Ronron… plus aucune demande à examiner. Tout est à jour ! 🐾 |

---

## Calendar days (`kimchi.days`)

`src/lib/kimchi-calendar.js` (D14): pure functions on `YYYY-MM-DD` keys, always given Montréal's date (`libraryTodayKey()`). `calendarLineKey(dateKey)` returns `'kimchi.days.<id>'` or null, `calendarDayId(dateKey)` the id, and `isQuietDay(dateKey)` is true on Sep 30, Nov 11 and Dec 6. Movable days: Family Day = 3rd Monday of February, Easter = Gregorian computus (`easterDateKey`), Victoria Day / National Patriots' Day = the Monday on or before May 24, Labour Day = 1st Monday of September, Thanksgiving = 2nd Monday of October (`movableDayKeys(year)`). `CALENDAR_DAY_IDS` lists the 18 ids.

The three days of remembrance keep a sober tone (no "Meow", no jokes, no playful emoji) and are **quiet days**: their own line is the only ambient bubble allowed (`allowOnQuietDay`); the returning greeting, library-versary, "New in the library", pickup-day note and "all caught up" stay silent. No election days.

| Id | Date | EN | FR |
|----|------|----|----|
| `new_year` | Jan 1 | Happy New Year! 🎉 What will you organize this year? | Bonne année ! 🎉 Qu'est-ce que tu vas organiser cette année ? |
| `valentines` | Feb 14 | Happy Valentine's Day! 💌 Purrs and headbutts to you. | Joyeuse Saint-Valentin ! 💌 Ronrons et câlins pour toi. |
| `family_day` | 3rd Monday of Feb | Happy Family Day! 💛 Hope you get some time with your people. | Bonne fête de la Famille ! 💛 J'espère que tu passes du temps avec ton monde. |
| `st_patricks` | Mar 17 | Happy St. Patrick's Day! ☘️ Enjoy the parade if you're downtown. | Bonne Saint-Patrick ! ☘️ Profite du défilé si tu es au centre-ville. |
| `easter` | Easter Sunday | Happy Easter! 🐣 Hope you get a long weekend. | Joyeuses Pâques ! 🐣 J'espère que tu as une longue fin de semaine. |
| `victoria_day` | Monday on or before May 24 | Happy Victoria Day and National Patriots' Day! Enjoy the long weekend 🌷 | Bonne Journée nationale des patriotes ! Profite de la longue fin de semaine 🌷 |
| `indigenous_peoples_day` | Jun 21 | Today is National Indigenous Peoples Day. A good day to learn from and support Indigenous-led groups 🌿 | C'est la Journée nationale des peuples autochtones. Une belle journée pour apprendre et soutenir des organismes autochtones 🌿 |
| `fete_nationale` | Jun 24 | Happy Fête nationale! 💙⚜️ | Bonne Fête nationale ! 💙⚜️ |
| `canada_day` | Jul 1 | Happy Canada Day! 🍁 And good luck to everyone moving today 📦 | Bonne fête du Canada ! 🍁 Et bon courage à tout le monde qui déménage aujourd'hui 📦 |
| `labour_day` | 1st Monday of Sep | Happy Labour Day! ✊ Thanks to everyone who fought for the weekend. | Bonne fête du Travail ! ✊ Merci à celles et ceux qui se sont battus pour nos fins de semaine. |
| `truth_reconciliation` (quiet) | Sep 30 | Today is the National Day for Truth and Reconciliation. 🧡 Take a moment to learn about residential schools and listen to survivors. | C'est la Journée nationale de la vérité et de la réconciliation. 🧡 Prends un moment pour t'informer sur les pensionnats autochtones et écouter les survivantes et survivants. |
| `thanksgiving` | 2nd Monday of Oct | Happy Thanksgiving! 🍂 Thanks for being part of the library. | Joyeuse Action de grâce ! 🍂 Merci de faire partie de la bibliothèque. |
| `halloween` | Oct 31 | Happy Halloween! 🎃 This year I'm dressed as… a cat. | Joyeuse Halloween ! 🎃 Cette année, je suis déguisé en… chat. |
| `remembrance_day` (quiet) | Nov 11 | Today is Remembrance Day. Many people pause for a moment of silence at 11 am. | C'est le jour du Souvenir. Beaucoup de gens prennent un moment de silence à 11 h. |
| `violence_against_women` (quiet) | Dec 6 | Today we remember the 14 women killed at Polytechnique Montréal in 1989, and all women lost to gender-based violence. | Aujourd'hui, on se souvient des 14 femmes tuées à Polytechnique Montréal en 1989, et de toutes les femmes victimes de violence fondée sur le genre. |
| `holidays` | Dec 24 and Dec 25 | Happy holidays! ❄️ Stay warm out there. | Joyeuses fêtes ! ❄️ Reste bien au chaud. |
| `boxing_day` | Dec 26 | Happy Boxing Day! 📦 I'm more of an empty-box cat myself. | Joyeux lendemain de Noël ! 📦 Moi, je préfère les boîtes vides. |
| `new_years_eve` | Dec 31 | Happy New Year's Eve! 🎆 See you next year. | Bonne veille du jour de l'An ! 🎆 On se revoit l'an prochain. |

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

These are **not** queued via `notify()` but are automated UI feedback on the same flows. Most of them also carry a bubble's news while Kimchi sleeps:

| Location | Locale key(s) | When |
|----------|---------------|------|
| `InventoryCard.svelte` | `inventory.reservation_pending` / `inventory.reservation_complete` | Card status line after reserve success (5 s fade). The pending text ends with "You can follow it on your account page." |
| `ItemCalendar.svelte` | `calendar.reservation_pending` / `calendar.reservation_saved` | Inline calendar status after confirm (the pending text points to the account page too) |
| `ConsultationRequestForm.svelte` | `consultation.request_pending` / `consultation.create_error` | Inline form status after consultation submit |
| `AccountReservations.svelte` | `account_reservations.withdrawn_status` / `cancelled_status` | Visually hidden `role="status"` line after a withdraw / cancel, so screen readers hear it even while Kimchi is asleep |
| `AccountConsultations.svelte` | `account_consultations.scheduled_status` / `follow_up_booked_status` (`{time}`), `withdrawn_status` / `request_cancelled_status` / `meeting_cancelled_status`, each followed by `invitations_sent_status` / `expert_told_status` / `member_told_status` only when the email is known to have gone out (same rule as the bubbles) | One permanent visually hidden `role="status"` line. After schedule focus moves to the row's title, after cancel to the Past list toggle, after a follow-up to the new meeting's title; on an error back to the pressed button (F8) |
| `AccountConsultations.svelte` | `account_consultations.starts_in` (`{minutes}`) / `happening_now`; `account_consultations.recent_heading` | B6's chip on a scheduled row (`.consultation-status--soon` Lemon / `--live` Grape); B4's **Changed since your last visit** list |
| `AdminPanel.svelte` | `admin.approved_status`, `consultation_scheduled_status`, `refused_status`, `consultation_refused_status`, `deleted_status`, `consultation_deleted_status`, `held_consultation_deleted_status`, `follow_up_booked_status`, `removed_status` (`{title}`), plus a note only when `emailSent === true`: `admin.status_member_emailed`, `status_both_emailed`, `status_only_member_emailed` or `status_removed_emailed`. Mentors with no email: `admin.status_mentor_no_email` and, with a Zoom link, `admin.status_zoom_link_here` | One permanent visually hidden `role="status"` line for every approve, refuse, delete, removal and follow-up result (F8) |
| `AdminPanel.svelte` | `admin.starts_today` / `admin.start_overdue` / `admin.no_mentor_email` | Pills on pending rows (and `no_mentor_email` on scheduled, not-held consultations in Edit Reservations): what the B2 arrival note counts |
| `AddItemModal.svelte` | `admin.item_added_status` (`{title}`) | Visually hidden `role="status"` line outside the dialog, set once it has closed |
| `KimchiNotification.svelte` | `kimchi.signup_complete` / `kimchi.email_confirmed` | Its own hidden `role="status"` line, outside every dialog, only when that bubble couldn't show |
| `HomePage.svelte` | `home.load_error` | `role="alert"` under the intro when the inventory failed to load |
| `HeaderAuth.svelte` | `auth.sign_out_error` | `role="alert"` under the header buttons after a failed sign-out (`.header-auth__error`) |
| `AboutPage.svelte` | `about.contact_success` | Contact form status after a send |
| `AuthModal.svelte` | Various `auth.*` keys | Login/register errors and “check your email” (Supabase-driven); reset view: neutral `auth.reset_sent` after **Send reset link**, `auth.rate_limited` / `auth.enter_valid_email` / `auth.reset_send_failed` on real failures, `auth.reset_link_expired` when an expired reset link opens the view |
| `SetPasswordModal.svelte` | `auth.password_updated` (+ `auth.password_*` errors) | Visually hidden `role="status"` line after a new password is saved, so screen readers hear it even while Kimchi is asleep; errors show inline in the dialog's status line, which (like `AuthModal`'s) stays in the page between messages so each one is announced |

---

## Gaps / not covered

| Gap | Notes |
|-----|-------|
| **Bubbles from inside the item dialog** | `kimchi.reservation_sent` and `kimchi.consultation_sent` still fire while the item overlay is open, so they land behind its backdrop. The inline status lines carry the news, and after a pending equipment, book or room request Kimchi points to `/account` once the overlay closes (C1). `notifyWhenIdle` only covers load-time and deferred bubbles |
| **Bubble name contrast** | The "Kimchi" name in each bubble is still `#c4a800` (2.35:1 on white). Links (`#6b5b00`) and × (`#767676`) pass |
| **Failed emails** | When a response says `emailSent === false`, the admin and consultation bubbles and status lines drop their "emailed" claim, but nothing warns that an email failed |
| **Supabase auth emails** | Sign-up confirmation and password reset are sent by Supabase Auth, not this app (the app only requests the reset email from the **Forgot password?** view; see `docs/automated-emails.md`). The page a confirmation link opens gets `kimchi.email_confirmed` |

---

## Source files

| File | Role |
|------|------|
| `src/lib/notification-store.js` | `notify()`, `notifyWhenIdle()`, `dismiss()`, `dismissKind()`, `clearNotifications()`, sleep gate and remembered nap (`setKimchiNotificationsEnabled`, `isKimchiAwake`, `getKimchiAsleepSince`), ambient budget (`isAmbientAllowed`) |
| `src/lib/kimchi-memory.js` | Storage helpers: `storageAvailable`, `readJson` / `writeJson` / `removeKey`, `readSessionJson` / `writeSessionJson`, per-user snapshots (`readSnapshot` / `writeSnapshot`), once-per-id lists (`hasSeen` / `markSeen`), Montréal day flags (`getDayFlag` / `setDayFlag` / `isDayFlagToday`) |
| `src/lib/kimchi-calendar.js` | Calendar lines and quiet days (`calendarLineKey`, `calendarDayId`, `isQuietDay`, movable-day helpers) |
| `src/components/KimchiNotification.svelte` | Widget shell; greetings and welcomes (D1, D2, D9, D12, D14, A2, A4), taps and rapid taps, sleep, sleep-talk, wake lines, nap hint, offline notices, bubble links, focus hand-off, hidden status line |
| `src/components/KimchiBubble.svelte` | Single bubble render; auto-dismiss that pauses on hover and focus; `onClose` for × |
| `src/components/InventoryCard.svelte` | Item reaction on mouse hover (status line first, then random) |
| `src/components/InventoryPanel.svelte` | "New in the library" bubble (D13) |
| `src/App.svelte` | `/account` pointer after the item overlay closes (C1); inventory load failure (C5) |
| `src/components/HeaderAuth.svelte` | Register click, sign-out, failed sign-out |
| `src/components/CompleteSignupModal.svelte` | Sign out from **Finish creating your account** |
| `src/components/AboutPage.svelte` | Contact message sent |
| `src/components/AccountPage.svelte` | Sign-out |
| `src/components/SetPasswordModal.svelte` | New password saved |
| `src/components/ReserveAuthRequiredModal.svelte` | Register from reserve gate |
| `src/components/ItemCalendar.svelte` | Reservation sent confirmation |
| `src/components/ConsultationRequestForm.svelte` | Consultation request sent confirmation |
| `src/components/AccountConsultations.svelte` | Consultation scheduled / cancelled / follow-up confirmations; load-time consultation bubbles (B4, B5, B6, C8) |
| `src/components/AccountReservations.svelte` | Reservation withdrawn / cancelled confirmations |
| `src/components/AccountShareExpertise.svelte` | Mentor profile published / updated confirmations |
| `src/components/AddItemModal.svelte` | Item added confirmation (by category) |
| `src/components/MentorBrowser.svelte` | Mentor details saved |
| `src/components/AdminPanel.svelte` | Admin action confirmations; arrival and pickup-day notes (B2); "all caught up" (D10) |
