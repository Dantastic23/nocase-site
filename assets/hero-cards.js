// Case cards in the NoCase hero: what NoCase builds, flying out of the book and tied
// to the intake sheet by hairlines. Typing in #caseDesc sends a spark down one line.
// Decorative and aria-hidden; READS the textarea, never writes it. The flight is CSS;
// this file only places the cards and draws the lines. If it fails, cards stay [hidden].
(function () {
  const wrap = document.getElementById('caseCards');
  const svg = document.getElementById('caseLines');
  const grid = wrap && wrap.parentElement;
  const book = document.getElementById('heroBook');
  const sheet = document.querySelector('.lobby-desk');
  const box = document.getElementById('caseDesc');
  if (!wrap || !svg || !grid || !book || !sheet || !box) return;
  const wide = window.matchMedia('(min-width: 1200px)');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cards = Array.from(wrap.querySelectorAll('.case-card'));
  const NS = 'http://www.w3.org/2000/svg';
  let paths = [];
  const born = performance.now();

  function layout() {
    if (!wide.matches) return;
    // Offsets, not getBoundingClientRect: the book is mid-flight (transformed) when
    // this first runs, and the cards must aim at where it lands. Both boxes are
    // positioned children of the grid, so their offsets are grid coordinates.
    const box_ = el => ({ left: el.offsetLeft, top: el.offsetTop, right: el.offsetLeft + el.offsetWidth,
                          bottom: el.offsetTop + el.offsetHeight, width: el.offsetWidth, height: el.offsetHeight });
    const g = { left: 0, top: 0, width: grid.clientWidth };
    const s = box_(sheet);
    // The book is [hidden] if hero-book.js did not run; fall back to the sheet.
    const b = book.hidden ? s : box_(book);
    const top = b.top, bottom = s.bottom;
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    svg.textContent = '';
    paths = [];
    ['left', 'right'].forEach((side, si) => {
      const group = cards.filter(c => c.dataset.side === side);
      const h = group[0].offsetHeight, w = group[0].offsetWidth;
      const step = (bottom - top - h) / Math.max(group.length - 1, 1);
      group.forEach((c, i) => {
        // A shallow arc: the middle card sits further out than the two ends.
        const gap = i === 1 ? 76 : 36;
        const x = side === 'left' ? Math.max(0, s.left - g.left - gap - w)
                                  : Math.min(g.width - w, s.right - g.left + gap);
        const y = top + step * i;
        c.style.left = x + 'px';
        c.style.top = y + 'px';
        c.style.setProperty('--from-x', (bx - x - w / 2) + 'px');
        c.style.setProperty('--from-y', (by - y - h / 2) + 'px');
        const delay = 2.4 + (i * 2 + si) * 0.12;
        c.style.setProperty('--card-delay', delay + 's');
        // Line from the card's inner edge to the facing edge of the book or sheet.
        const cx = side === 'left' ? x + w : x, cy = y + h / 2;
        const target = cy < s.top - g.top ? b : s;
        const tx = (side === 'left' ? target.left : target.right) - g.left;
        const ty = Math.min(Math.max(cy, target.top - g.top + 16), target.bottom - g.top - 16);
        const mx = (cx + tx) / 2;
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', `M${tx},${ty} C${mx},${ty} ${mx},${cy} ${cx},${cy}`);
        p.setAttribute('pathLength', '1');
        // Relayouts (resize, results opening) rebuild the paths; don't replay the draw.
        const wait = delay + 0.6 - (performance.now() - born) / 1000;
        p.style.setProperty('--line-delay', wait > 0 ? wait + 's' : '-1s');
        svg.appendChild(p);
        paths.push({ p, card: c });
      });
      // Network links down each column: card to card, a slow flowing dash.
      group.slice(1).forEach((c, i) => {
        const a = group[i];
        const ax = a.offsetLeft + w / 2, ay = a.offsetTop + h;
        const cx = c.offsetLeft + w / 2, cy = c.offsetTop;
        const l = document.createElementNS(NS, 'path');
        l.setAttribute('d', `M${ax},${ay} C${ax},${(ay + cy) / 2} ${cx},${(ay + cy) / 2} ${cx},${cy}`);
        l.setAttribute('pathLength', '1');
        l.setAttribute('class', 'link');
        const wait = 3.4 - (performance.now() - born) / 1000;
        l.style.setProperty('--line-delay', wait > 0 ? wait + 's' : '-1s');
        svg.appendChild(l);
      });
    });
    motes(b);
  }

  // Motes of light rising off the book, like dust in a lamp beam. Built once.
  const moteBox = document.getElementById('caseMotes');
  function motes(b) {
    if (!moteBox || still) return;
    if (!moteBox.childElementCount) {
      for (let i = 0; i < 26; i++) {
        const m = document.createElement('i');
        const r = Math.random;
        m.style.setProperty('--sz', (2 + r() * 3).toFixed(1) + 'px');
        m.style.setProperty('--c', r() < 0.6 ? '#e9cf86' : '#8fc3ff');
        m.style.setProperty('--dur', (5 + r() * 5).toFixed(1) + 's');
        m.style.setProperty('--dl', (2.2 + r() * 6).toFixed(1) + 's');
        m.style.setProperty('--dx', ((r() - 0.5) * 80).toFixed(0) + 'px');
        m.dataset.fx = r(); m.dataset.fy = r();
        moteBox.appendChild(m);
      }
    }
    for (const m of moteBox.children) {
      m.style.left = (b.left - 60 + m.dataset.fx * (b.width + 120)) + 'px';
      m.style.top = (b.top + 30 + m.dataset.fy * b.height) + 'px';
    }
  }

  // Typing: one spark per burst, travelling from the sheet out to the next card.
  let next = 0, busy = false;
  function spark() {
    if (still || busy || !wide.matches || !paths.length) return;
    busy = true;
    const { p, card } = paths[next++ % paths.length];
    const len = p.getTotalLength();
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', '3');
    dot.setAttribute('class', 'spark');
    svg.appendChild(dot);
    const t0 = performance.now(), dur = 650;
    (function frame(now) {
      const k = Math.min((now - t0) / dur, 1);
      const pt = p.getPointAtLength(len * (1 - Math.pow(1 - k, 3)));
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);
      if (k < 1) return requestAnimationFrame(frame);
      dot.remove();
      card.classList.add('lit');
      setTimeout(() => card.classList.remove('lit'), 900);
      setTimeout(() => { busy = false; }, 250);
    })(t0);
  }

  wrap.hidden = false;
  layout();
  if (document.fonts) document.fonts.ready.then(layout);
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(grid);
  else window.addEventListener('resize', layout);
  box.addEventListener('input', spark);
})();
