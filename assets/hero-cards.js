// Hologram tiles in the NoCase hero: what NoCase builds, flying out of the laptop
// screen and wired to it. Typing in #caseDesc sends a spark down one wire. While the
// box is empty and untouched, an example types itself into the placeholder.
// Decorative and aria-hidden; READS the textarea, never writes its value. The flight
// is CSS; this file only places the tiles and draws the wires. If it fails, the
// tiles stay [hidden] and the laptop is a plain working form.
(function () {
  const wrap = document.getElementById('caseCards');
  const svg = document.getElementById('caseLines');
  const grid = wrap && wrap.parentElement;
  const lid = document.querySelector('.laptop-lid');
  const box = document.getElementById('caseDesc');
  if (!wrap || !svg || !grid || !lid || !box) return;
  const wide = window.matchMedia('(min-width: 1200px)');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cards = Array.from(wrap.querySelectorAll('.case-card'));
  const NS = 'http://www.w3.org/2000/svg';
  const born = performance.now();
  let paths = [];

  // Grid coordinates by summing offsets, not getBoundingClientRect: the laptop is
  // mid-rise (transformed) when this first runs, and the tiles aim at where it lands.
  function rect(el) {
    let x = 0, y = 0, n = el;
    while (n && n !== grid) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { left: x, top: y, right: x + el.offsetWidth, bottom: y + el.offsetHeight, width: el.offsetWidth, height: el.offsetHeight };
  }
  const since = () => (performance.now() - born) / 1000;

  function layout() {
    if (!wide.matches) return;
    const s = rect(lid);
    const W = grid.clientWidth;
    const sx = s.left + s.width / 2, sy = s.top + s.height / 2;
    svg.textContent = '';
    paths = [];
    const cx = s.left + s.width / 2;
    // A fan rising out of the top of the screen: per side, outer (low, beside the
    // laptop, above the statue / scales), middle, inner (high, over the screen).
    const FAN = [
      { dx: -230, dy: 20 },     // outer: centre relative to the lid's top-left corner
      { dx: -60,  dy: -60 },
      { dx: s.width * 0.22, dy: -105 }
    ];
    ['left', 'right'].forEach((side, si) => {
      const group = cards.filter(c => c.dataset.side === side);
      const h = group[0].offsetHeight, w = group[0].offsetWidth;
      group.forEach((c, i) => {
        const f = FAN[i];
        let mx0 = s.left + f.dx;
        if (side === 'right') mx0 = 2 * cx - mx0;
        const x = Math.min(Math.max(mx0 - w / 2, -120), W - w + 120);
        const y = s.top + f.dy - h / 2;
        c.style.left = x + 'px';
        c.style.top = y + 'px';
        c.style.setProperty('--from-x', (sx - x - w / 2) + 'px');
        c.style.setProperty('--from-y', (sy - y - h / 2) + 'px');
        const delay = 1.1 + ((2 - i) * 2 + si) * 0.12;   // inner tiles leave the screen first
        c.style.setProperty('--card-delay', delay + 's');
        // Stem out of the laptop: from the top edge up to a tile above the screen, or
        // from the side edge across to a tile that hangs beside it.
        const p = document.createElementNS(NS, 'path');
        if (y + h > s.top + 10) {
          const ex = side === 'left' ? x + w : x, ey = y + h / 2;
          const tx = side === 'left' ? s.left : s.right, ty = Math.max(ey + 40, s.top + 40);
          const mx = (ex + tx) / 2;
          p.setAttribute('d', `M${tx},${ty} C${mx},${ty} ${mx},${ey} ${ex},${ey}`);
        } else {
          const ex = x + w / 2, ey = y + h;
          const tx = Math.min(Math.max(ex, s.left + 36), s.right - 36), ty = s.top;
          p.setAttribute('d', `M${tx},${ty} C${tx},${ty - 40} ${ex},${ey + 40} ${ex},${ey}`);
        }
        p.setAttribute('pathLength', '1');
        // Relayouts (resize, results opening) rebuild the stems; don't replay the draw.
        const wait = delay + 0.6 - since();
        p.style.setProperty('--line-delay', wait > 0 ? wait + 's' : '-1s');
        svg.appendChild(p);
        paths.push({ p, card: c });
      });
      // Network links down each column: tile to tile, a slow flowing dash.
      group.slice(1).forEach((c, i) => {
        const a = group[i];
        const ax = a.offsetLeft + w / 2, ay = a.offsetTop + h;
        const cx = c.offsetLeft + w / 2, cy = c.offsetTop;
        const l = document.createElementNS(NS, 'path');
        l.setAttribute('d', `M${ax},${ay} C${ax},${(ay + cy) / 2} ${cx},${(ay + cy) / 2} ${cx},${cy}`);
        l.setAttribute('pathLength', '1');
        l.setAttribute('class', 'link');
        const wait = 2.2 - since();
        l.style.setProperty('--line-delay', wait > 0 ? wait + 's' : '-1s');
        svg.appendChild(l);
      });
    });
    motes(s);
  }

  // Points of light rising off the top of the screen. Built once.
  const moteBox = document.getElementById('caseMotes');
  function motes(s) {
    if (!moteBox || still) return;
    if (!moteBox.childElementCount) {
      for (let i = 0; i < 28; i++) {
        const m = document.createElement('i');
        const r = Math.random;
        m.style.setProperty('--sz', (2 + r() * 3).toFixed(1) + 'px');
        m.style.setProperty('--c', r() < 0.55 ? '#8fc3ff' : '#e9cf86');
        m.style.setProperty('--dur', (5 + r() * 5).toFixed(1) + 's');
        m.style.setProperty('--dl', (1 + r() * 6).toFixed(1) + 's');
        m.style.setProperty('--dx', ((r() - 0.5) * 90).toFixed(0) + 'px');
        m.dataset.fx = r(); m.dataset.fy = r();
        moteBox.appendChild(m);
      }
    }
    for (const m of moteBox.children) {
      m.style.left = (s.left - 40 + m.dataset.fx * (s.width + 80)) + 'px';
      m.style.top = (s.top + m.dataset.fy * s.height * 0.6) + 'px';
    }
  }

  // Typing: one spark per burst, travelling from the laptop out to the next tile.
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

  // The screen types an example into the placeholder until the visitor takes over.
  // Only the placeholder changes, never the value, and it stops for good on focus.
  const EXAMPLES = [
    'My landlord kept my whole $1,800 deposit after I moved out. I left the place clean and have photos.',
    'My contractor took a $25,000 deposit and never started the work. It has been six months.',
    'DPS says my license will be suspended. I have a hearing next month and no lawyer.'
  ];
  const original = box.placeholder;
  let typing = !still;
  function stopTyping() { if (!typing) return; typing = false; box.placeholder = original; }
  box.addEventListener('focus', stopTyping);
  box.addEventListener('input', stopTyping);
  (function type(ex, n) {
    if (!typing) return;
    if (box.value) return stopTyping();          // a restored draft: leave it alone
    const text = EXAMPLES[ex];
    box.placeholder = text.slice(0, n) + (n < text.length ? '▍' : '');
    if (n < text.length) setTimeout(type, 38 + Math.random() * 40, ex, n + 1);
    else setTimeout(type, 2600, (ex + 1) % EXAMPLES.length, 0);
  })(0, 0);

  wrap.hidden = false;
  layout();
  if (document.fonts) document.fonts.ready.then(layout);
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(grid);
  else window.addEventListener('resize', layout);
  box.addEventListener('input', spark);

  // A key on the laptop's keyboard lights up for every keystroke.
  const keys = document.querySelectorAll('#deckKeys i:not(.space)');
  const space = document.querySelector('#deckKeys .space');
  if (keys.length && !still) box.addEventListener('input', e => {
    const k = e.data === ' ' && space ? space : keys[Math.floor(Math.random() * keys.length)];
    k.classList.add('hit');
    setTimeout(() => k.classList.remove('hit'), 140);
  });
})();
