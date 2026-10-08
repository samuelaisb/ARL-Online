<script>
  // {:pending} branch of a lazy route or overlay import: Mint hairline at the top of
  // the viewport (after 250ms) plus a status announced only if the wait passes 1s.
  import { t } from '../lib/i18n.js';
  import LoadingStatus from './LoadingStatus.svelte';
</script>

<div class="route-progress" aria-hidden="true"></div>
<LoadingStatus text={$t('loading.page')} />
