// The flying book in the NoCase hero. Mirrors the intake box (#caseDesc) as gold
// handwriting. It READS the textarea and never writes it: the textarea is the real,
// labelled control, and the book is aria-hidden decoration. The flight is pure CSS;
// this file only unhides the book. If it fails to load, the book stays [hidden].
(function () {
  const box = document.getElementById('caseDesc');
  const book = document.getElementById('heroBook');
  const ink = document.getElementById('heroBookInk');
  if (!box || !book || !ink) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let shown = '';

  function render() {
    const text = box.value;
    if (text === shown) return;
    if (still || !text.startsWith(shown)) {
      ink.textContent = text;              // delete, paste-over, restore: redraw plainly
    } else {
      const wet = document.createElement('span');
      wet.className = 'wet';
      wet.textContent = text.slice(shown.length);
      wet.addEventListener('animationend', () => { wet.replaceWith(wet.textContent); ink.normalize(); }, { once: true });
      ink.appendChild(wet);
    }
    shown = text;
    ink.scrollTop = ink.scrollHeight;      // the page shows its newest lines
  }

  box.addEventListener('input', render);
  // The draft script and the patch's saved-analysis restore set .value directly,
  // which fires no input event. A string compare every 500ms catches them.
  setInterval(render, 500);
  render();
  book.hidden = false;

  // Desktop only, and never for reduced motion: phones keep the still photo and
  // don't download a few MB of video on cellular.
  const video = document.querySelector('.lobby-video');
  if (video && !still && window.matchMedia('(min-width: 921px)').matches) {
    for (const s of video.querySelectorAll('source[data-src]')) s.src = s.dataset.src;
    video.load();
    video.play().catch(() => {});          // autoplay refused: the poster stays
  }
})();
