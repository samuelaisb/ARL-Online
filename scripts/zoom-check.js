#!/usr/bin/env node
// Verifies the Zoom Server-to-Server OAuth app: token, scopes, host user, and host share settings.
import 'dotenv/config';
import { getZoomAccessToken, isZoomConfigured, zoomRequest } from '../src/lib/zoom.js';

if (!isZoomConfigured()) {
  console.error('Zoom is not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET.');
  process.exit(1);
}

const hostUser = process.env.ZOOM_HOST_USER?.trim() || 'me';

try {
  const { scope } = await getZoomAccessToken();
  console.log('Token: ok');
  console.log('Scopes:', scope || '(none reported)');

  const user = await zoomRequest('GET', `/users/${encodeURIComponent(hostUser)}`);
  console.log(`Host user: ${user.email} (type ${user.type})`);

  try {
    const settings = await zoomRequest('GET', `/users/${encodeURIComponent(hostUser)}/settings`);
    console.log('Screen sharing:', settings?.in_meeting?.screen_sharing);
    console.log('Who can share:', settings?.in_meeting?.who_can_share_screen);
  } catch (error) {
    console.warn(
      'Could not read host settings (add user:read:settings:admin + user:update:settings:admin',
      'scopes, or set Screen sharing → Who can share = All Participants in the Zoom web portal):',
      error.message,
    );
  }
} catch (error) {
  console.error('Zoom check failed:', error.message);
  process.exit(1);
}
