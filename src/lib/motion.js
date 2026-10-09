// Image loading for `<img {@attach revealOnLoad}>` (see "Images" in src/app.css):
// while an image loads it is hidden over its frame's fill, then it swaps in within
// one frame (no fade), so a half-drawn image never paints.

const IMAGE_FAILSAFE_MS = 8000;

/**
 * Attachment for `<img {@attach revealOnLoad}>`: hides the image (.img-pending) only
 * while it is still loading. On load it waits for `img.decode()`, so the swap lands
 * in one frame, then shows it. Images that are already complete (cached, or already
 * failed) are left alone, and load errors or an 8s failsafe show the image at once,
 * so it is never left invisible.
 */
export function revealOnLoad(img) {
  if (img.complete) return;

  img.classList.add('img-pending');

  let done = false;
  const timer = setTimeout(show, IMAGE_FAILSAFE_MS);
  img.addEventListener('load', decodeThenShow);
  img.addEventListener('error', show);

  function cleanup() {
    done = true;
    clearTimeout(timer);
    img.removeEventListener('load', decodeThenShow);
    img.removeEventListener('error', show);
  }

  function show() {
    if (done) return;
    cleanup();
    img.classList.remove('img-pending');
  }

  // decode() can reject (a src swap mid-decode, an undecodable file): show it anyway.
  // `done` stops a late decode from touching an image that has been torn down.
  function decodeThenShow() {
    img.decode().then(show, show);
  }

  return () => {
    cleanup();
    img.classList.remove('img-pending');
  };
}
