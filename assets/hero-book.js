// The open book on the desk in the NoCase hero: the First Amendment on the left page,
// the Fourth on the right. The pages are flat HTML boxes warped onto the photographed
// pages with a perspective transform (a homography from a rectangle to each page's
// four measured corners). Decorative and aria-hidden. If this file fails, the book
// stays [hidden].
(function () {
  const book = document.getElementById('deskBook');
  if (!book) return;

  // Page corners in the book photo, as fractions of its width/height:
  // top-left, top-right, bottom-right, bottom-left. Re-measure if book.webp changes.
  const PAGES = {
    left:  JSON.parse(book.dataset.left),
    right: JSON.parse(book.dataset.right)
  };

  // Solve the 3x3 homography mapping the rectangle (0,0)-(w,h) onto quad q.
  function matrixFor(w, h, q) {
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = q[i];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    for (let c = 0; c < 8; c++) {                 // Gaussian elimination
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h8 = b.map((v, i) => v / A[i][i]);
    return `matrix3d(${h8[0]},${h8[3]},0,${h8[6]},${h8[1]},${h8[4]},0,${h8[7]},0,0,1,0,${h8[2]},${h8[5]},0,1)`;
  }

  function place() {
    const W = book.clientWidth, H = book.clientHeight;
    if (!W) return;
    for (const side of ['left', 'right']) {
      const el = book.querySelector('.book-' + side);
      const q = PAGES[side].map(([fx, fy]) => [fx * W, fy * H]);
      el.style.transform = matrixFor(el.offsetWidth, el.offsetHeight, q);
    }
  }

  book.hidden = false;
  const img = book.querySelector('img');
  if (img.complete) place(); else img.addEventListener('load', place);
  if ('ResizeObserver' in window) new ResizeObserver(place).observe(book);
})();
