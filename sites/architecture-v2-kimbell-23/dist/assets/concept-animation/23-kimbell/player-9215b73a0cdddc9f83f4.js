/* Native playback stays user-initiated. No viewer state or global styles change. */
(() => {
  'use strict';
  const panel = document.getElementById('concept-animation');
  const video = document.getElementById('concept-animation-video');
  const summary = document.getElementById('concept-animation-summary');
  const close = document.getElementById('concept-animation-close');
  const error = document.getElementById('concept-animation-error');
  if (!panel || !video || !summary || !close) return;

  const captionsOff = () => {
    for (const track of Array.from(video.textTracks || [])) track.mode = 'disabled';
  };
  captionsOff();
  // Run once when the actual media tracks become available; later user choices persist.
  video.addEventListener('loadedmetadata', captionsOff, { once: true });
  const collapse = () => {
    video.pause();
    panel.open = false;
    summary.focus({ preventScroll: true });
  };
  close.addEventListener('click', collapse);
  panel.addEventListener('toggle', () => { if (!panel.open) video.pause(); });
  panel.addEventListener('keydown', (event) => {
    // Keep player arrow/space controls away from the viewer's window keydown handler.
    // Do not cancel native video key behavior; keyup still bubbles to clear held walks.
    event.stopPropagation();
    if (event.key === 'Escape' && panel.open && document.fullscreenElement !== video) {
      event.preventDefault();
      collapse();
    }
  });
  video.addEventListener('error', () => { if (error) error.hidden = false; });
  window.addEventListener('pagehide', () => video.pause());
})();
