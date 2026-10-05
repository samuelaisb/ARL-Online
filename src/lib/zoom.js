/**
 * Zoom Server-to-Server OAuth client (server only).
 * Creates and deletes consultation meetings hosted by ZOOM_HOST_USER (default "me").
 */

const ZOOM_OAUTH_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE = 'https://api.zoom.us/v2';
const ZOOM_TIMEOUT_MS = 10000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

export const CONSULTATION_TIMEZONE = 'America/Toronto';
export const CONSULTATION_DURATION_MINUTES = 60;

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let hostSharingEnsured = false;

function zoomEnv() {
  return {
    accountId: process.env.ZOOM_ACCOUNT_ID?.trim() || '',
    clientId: process.env.ZOOM_CLIENT_ID?.trim() || '',
    clientSecret: process.env.ZOOM_CLIENT_SECRET?.trim() || '',
    hostUser: process.env.ZOOM_HOST_USER?.trim() || 'me',
  };
}

export function isZoomConfigured() {
  const { accountId, clientId, clientSecret } = zoomEnv();
  return Boolean(accountId && clientId && clientSecret);
}

async function readZoomError(response) {
  const body = await response.json().catch(() => null);
  const message = body?.message || body?.reason || body?.error || response.statusText;
  const error = new Error(`Zoom API ${response.status}: ${message}`);
  error.status = response.status;
  error.code = body?.code;
  return error;
}

export async function getZoomAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return { token: cachedToken, scope: null };
  }

  const { accountId, clientId, clientSecret } = zoomEnv();
  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom is not configured (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET).');
  }

  const url = `${ZOOM_OAUTH_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(ZOOM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw await readZoomError(response);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return { token: cachedToken, scope: data.scope ?? '' };
}

export async function zoomRequest(method, pathname, body) {
  const { token } = await getZoomAccessToken();
  const response = await fetch(`${ZOOM_API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ZOOM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw await readZoomError(response);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json().catch(() => null);
}

/**
 * Screen sharing for all participants is a host-user setting in Zoom (not a
 * per-meeting field), so it is attempted once per process before creating meetings.
 */
async function ensureHostScreenSharing() {
  if (hostSharingEnsured) {
    return;
  }

  hostSharingEnsured = true;
  const { hostUser } = zoomEnv();
  try {
    await zoomRequest('PATCH', `/users/${encodeURIComponent(hostUser)}/settings`, {
      in_meeting: {
        screen_sharing: true,
        who_can_share_screen: 'all',
        who_can_share_screen_when_someone_is_sharing: 'all',
      },
    });
  } catch (error) {
    console.warn(
      'Could not set Zoom host screen-sharing settings (needs user:update:settings:admin scope, or set it in the Zoom web portal):',
      error.message,
    );
  }
}

/** Zoom expects local wall-clock time without an offset when `timezone` is set. */
function toZoomLocalStartTime(isoString, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(isoString))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export async function createConsultationMeeting({ topic, agenda, startTime }) {
  await ensureHostScreenSharing();

  const { hostUser } = zoomEnv();
  const meeting = await zoomRequest('POST', `/users/${encodeURIComponent(hostUser)}/meetings`, {
    topic: topic.slice(0, 200),
    type: 2,
    start_time: toZoomLocalStartTime(startTime, CONSULTATION_TIMEZONE),
    timezone: CONSULTATION_TIMEZONE,
    duration: CONSULTATION_DURATION_MINUTES,
    agenda: agenda ? agenda.slice(0, 2000) : undefined,
    settings: {
      join_before_host: true,
      jbh_time: 0,
      waiting_room: false,
      host_video: true,
      participant_video: true,
      mute_upon_entry: false,
      approval_type: 2,
    },
  });

  return {
    id: String(meeting.id),
    joinUrl: meeting.join_url,
    password: meeting.password ?? '',
  };
}

/** Deletes a meeting; already-deleted meetings (404) count as success. */
export async function deleteConsultationMeeting(meetingId) {
  if (!meetingId) {
    return;
  }

  try {
    await zoomRequest('DELETE', `/meetings/${encodeURIComponent(meetingId)}`);
  } catch (error) {
    if (error.status === 404) {
      return;
    }
    throw error;
  }
}
