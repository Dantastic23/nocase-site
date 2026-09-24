// Hearing Day guide + printed hearing binder (Dan, 2026-09-24): "give me the right words to
// say at the right time, and guide me through the process as much as humanly possible."
//   window.ncHearingGuide.open()  cue cards, one moment of the hearing per card, built by the
//                                 Lambda's hearing_guide task FROM the hearing kit (so it
//                                 carries the kit's verified law, exhibits and cautions).
//   window.ncPrintBinder()        one printable page: the hearing kit, then EVERY uploaded
//                                 document printed as a numbered exhibit (numbers from the
//                                 kit's exhibit list), then any other uploads in an appendix.
// Both read the open case's folder only. Nothing is stored on a server.
(function () {
  const FUNCTION_URL = "https://gwz2q7it5d264sob3rqsy4puly0xvfmd.lambda-url.us-east-1.on.aws/";
  const GUIDE_FILE = "hearing-guide.json", KIT_FILE = "hearing-kit.md";
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const folder = () => (typeof folderHandle !== "undefined" && folderHandle) || window.__nci_folderHandle;
  const cs = () => (typeof caseState !== "undefined" && caseState) || {};
  const toast = m => (typeof showToast === "function" ? showToast(m) : alert(m));
  async function fileOf(name) { try { return await (await folder().getFileHandle(name)).getFile(); } catch { return null; } }
  async function readText(name) { const f = await fileOf(name); return f ? f.text() : null; }
  async function writeText(name, text) { const w = await (await folder().getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close(); }

  /* ───────────────────────── Hearing Day guide ───────────────────────── */
  const CSS = `
  .hd { position: fixed; inset: 0; z-index: 950; background: #0f1216; color: #f4f5f7; display: flex; flex-direction: column; font-family: inherit; }
  .hd-top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.7rem 1rem; border-bottom: 1px solid #2a313b; font-size: 0.85rem; color: #aeb6c2; }
  .hd-top button { font: inherit; font-size: 0.85rem; background: #1a1f26; color: #f4f5f7; border: 1px solid #39414d; border-radius: 6px; padding: 0.4rem 0.7rem; cursor: pointer; }
  .hd-bar { height: 4px; background: #2a313b; } .hd-bar i { display: block; height: 100%; background: #d9b86a; transition: width 200ms; }
  .hd-body { flex: 1; overflow-y: auto; padding: 1.1rem 1.1rem 1.5rem; max-width: 760px; width: 100%; margin: 0 auto; }
  .hd-phase { font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; color: #d9b86a; font-weight: 700; }
  .hd h2 { font-size: 1.55rem; line-height: 1.25; margin: 0.25rem 0 0.4rem; color: #fff; }
  .hd-when { font-style: italic; color: #c9d1dc; margin: 0 0 0.8rem; font-size: 1rem; }
  .hd-happening { font-size: 1rem; line-height: 1.5; color: #dfe4ea; margin-bottom: 0.9rem; }
  .hd-label { font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; color: #8fa0b5; font-weight: 700; margin: 0.9rem 0 0.35rem; }
  .hd-do { margin: 0; padding-left: 1.2rem; font-size: 1.02rem; line-height: 1.5; } .hd-do li { margin-bottom: 0.3rem; }
  .hd-say { background: #fff; color: #111; border-radius: 10px; padding: 0.95rem 1.05rem; font-size: 1.28rem; line-height: 1.45; font-family: Georgia, serif; border-left: 6px solid #d9b86a; }
  .hd-ex { display: inline-block; margin: 0 0.35rem 0.35rem 0; background: #213047; border: 1px solid #3c5a86; color: #cfe0ff; border-radius: 99px; padding: 0.25rem 0.7rem; font-size: 0.9rem; font-weight: 600; }
  .hd details { background: #1a1f26; border: 1px solid #2f3742; border-radius: 8px; padding: 0.55rem 0.75rem; margin-bottom: 0.45rem; }
  .hd summary { cursor: pointer; font-weight: 600; font-size: 1rem; } .hd details p { margin: 0.5rem 0 0.1rem; font-size: 1.05rem; line-height: 1.45; color: #fff; font-family: Georgia, serif; }
  .hd-caution { border: 2px solid #b33a3a; background: #2a1414; border-radius: 8px; padding: 0.7rem 0.85rem; font-size: 0.95rem; line-height: 1.45; margin-top: 0.9rem; }
  .hd-nav { display: flex; gap: 0.6rem; padding: 0.7rem 1rem calc(0.7rem + env(safe-area-inset-bottom, 0px)); border-top: 1px solid #2a313b; background: #0f1216; }
  .hd-nav button { flex: 1; font: inherit; font-size: 1.05rem; font-weight: 700; padding: 0.9rem; border-radius: 10px; cursor: pointer; border: 1px solid #39414d; background: #1a1f26; color: #f4f5f7; }
  .hd-nav button.next { background: #d9b86a; color: #16120c; border-color: #b8954a; }
  .hd-nav button:disabled { opacity: 0.35; cursor: default; }
  .hd-list { list-style: none; padding: 0; margin: 0; } .hd-list li { padding: 0.65rem 0.4rem; border-bottom: 1px solid #262d36; cursor: pointer; font-size: 1rem; } .hd-list li.cur { color: #d9b86a; font-weight: 700; }
  .hd-stale { background: #3a2f12; border: 1px solid #8a6d20; color: #f3e2b0; border-radius: 8px; padding: 0.6rem 0.8rem; margin-bottom: 0.9rem; font-size: 0.9rem; }
  .hd-stale button { margin-left: 0.4rem; }
  .hd-wait { padding: 3rem 1.2rem; text-align: center; font-size: 1.05rem; line-height: 1.6; color: #dfe4ea; }`;
  function addCss() { if (document.getElementById("hdCss")) return; const s = document.createElement("style"); s.id = "hdCss"; s.textContent = CSS; document.head.appendChild(s); }

  let wake = null;
  async function keepAwake(on) {
    try { if (on && "wakeLock" in navigator) wake = await navigator.wakeLock.request("screen"); else if (!on && wake) { await wake.release(); wake = null; } } catch { /* not supported or refused */ }
  }

  async function build(shell) {
    const kit = await readText(KIT_FILE);
    if (!kit) { toast("Build your hearing kit first. The guide is made from it."); return null; }
    const brief = (await readText("case-brief.md")) || "";
    if (shell) shell.querySelector(".hd-body").innerHTML = `<div class="hd-wait">Writing your Hearing Day guide from your hearing kit…<br>This takes about 2 minutes. Keep NoCase open.</div>`;
    const r = await fetch(FUNCTION_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "hearing_guide", kit, brief }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error || !data.result || !(data.result.cards || []).length) throw new Error(data.error || "the server answered " + r.status);
    const kitFile = await fileOf(KIT_FILE);
    const guide = { cards: data.result.cards, generatedAt: data.result.generatedAt, kitAt: kitFile ? kitFile.lastModified : 0 };
    await writeText(GUIDE_FILE, JSON.stringify(guide, null, 2));
    return guide;
  }

  async function open() {
    addCss();
    const shell = document.createElement("div");
    shell.className = "hd"; shell.setAttribute("role", "dialog"); shell.setAttribute("aria-label", "Hearing Day guide");
    shell.innerHTML = `<div class="hd-top"><span>Hearing Day guide · ${esc(cs().title || "")}</span><span><button data-h="list">All steps</button> <button data-h="close">Close</button></span></div><div class="hd-bar"><i></i></div><div class="hd-body"></div><div class="hd-nav"><button data-h="back">Back</button><button class="next" data-h="next">Next</button></div>`;
    document.body.appendChild(shell);
    const close = () => { shell.remove(); keepAwake(false); document.removeEventListener("keydown", onKey); };
    shell.querySelector('[data-h="close"]').onclick = close;
    let guide = null;
    try { guide = JSON.parse((await readText(GUIDE_FILE)) || "null"); } catch {}
    if (!guide) {
      try { guide = await build(shell); } catch (e) { shell.querySelector(".hd-body").innerHTML = `<div class="hd-wait">The guide didn't finish: ${esc(e.message)}.<br>Close this and press Hearing Day guide again.</div>`; return; }
      if (!guide) { close(); return; }
    }
    keepAwake(true);
    const kitFile = await fileOf(KIT_FILE);
    const stale = kitFile && guide.kitAt && kitFile.lastModified > guide.kitAt;
    const key = "ncGuidePos:" + (cs().caseId || "");
    let i = Math.min(Number(localStorage.getItem(key) || 0), guide.cards.length - 1), listing = false;
    const body = shell.querySelector(".hd-body"), bar = shell.querySelector(".hd-bar i");
    const back = shell.querySelector('[data-h="back"]'), next = shell.querySelector('[data-h="next"]');
    function render() {
      try { localStorage.setItem(key, String(i)); } catch {}
      const c = guide.cards[i], n = guide.cards.length;
      bar.style.width = ((i + 1) / n * 100) + "%";
      back.disabled = i === 0; next.textContent = i === n - 1 ? "Done" : "Next";
      if (listing) {
        body.innerHTML = `<ol class="hd-list">${guide.cards.map((x, k) => `<li data-k="${k}" class="${k === i ? "cur" : ""}">${k + 1}. ${esc(x.title)}</li>`).join("")}</ol>`;
        body.querySelectorAll("[data-k]").forEach(li => li.onclick = () => { i = +li.dataset.k; listing = false; render(); });
        return;
      }
      body.innerHTML = (stale ? `<div class="hd-stale">Your hearing kit changed after this guide was written.<button class="obj-btn" data-h="rebuild">Rewrite the guide</button></div>` : "") +
        `<div class="hd-phase">Step ${i + 1} of ${n}</div><h2>${esc(c.title)}</h2>` +
        (c.when ? `<p class="hd-when">${esc(c.when)}</p>` : "") +
        (c.happening ? `<div class="hd-happening">${esc(c.happening)}</div>` : "") +
        (c.exhibits && c.exhibits.length ? `<div class="hd-label">Have ready</div>${c.exhibits.map(x => `<span class="hd-ex">Exhibit ${esc(x)}</span>`).join("")}` : "") +
        (c.do && c.do.length ? `<div class="hd-label">Do this</div><ul class="hd-do">${c.do.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "") +
        (c.say ? `<div class="hd-label">Say this</div><div class="hd-say">${esc(c.say)}</div>` : "") +
        (c.ifAsked && c.ifAsked.length ? `<div class="hd-label">If they ask…</div>${c.ifAsked.map(x => `<details><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join("")}` : "") +
        (c.caution ? `<div class="hd-caution">${esc(c.caution)}</div>` : "");
      body.scrollTop = 0;
      const rb = body.querySelector('[data-h="rebuild"]');
      if (rb) rb.onclick = async () => { try { guide = await build(shell); i = 0; render(); } catch (e) { toast("The guide didn't finish: " + e.message); render(); } };
    }
    back.onclick = () => { if (listing) { listing = false; } else if (i > 0) i--; render(); };
    next.onclick = () => { if (listing) listing = false; else if (i < guide.cards.length - 1) i++; else { close(); return; } render(); };
    shell.querySelector('[data-h="list"]').onclick = () => { listing = !listing; render(); };
    function onKey(e) { if (e.key === "ArrowRight") next.click(); if (e.key === "ArrowLeft") back.click(); if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && document.body.contains(shell)) keepAwake(true); });
    render();
  }
  window.ncHearingGuide = { open };

  /* ───────────────────────── Printed hearing binder ───────────────────────── */
  const IMG = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i, TXT = /\.(txt|md|csv|json|html?)$/i;
  function dataUrl(blob) { return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(blob); }); }
  async function renderDoc(file) {
    try {
      if (IMG.test(file.name) || (file.type || "").startsWith("image/")) {
        const norm = window.__ncImageToJpeg ? await window.__ncImageToJpeg(file) : null;
        if (!norm && /\.(heic|heif)$/i.test(file.name)) return `<p class="miss">This iPhone photo couldn't be shown here. Print the original photo (${esc(file.name)}) and put it behind this page.</p>`;
        return `<img class="doc-img" src="${await dataUrl(norm ? norm.blob : file)}" alt="${esc(file.name)}">`;
      }
      if (/\.pdf$/i.test(file.name) && window.pdfjsLib) {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        const pages = [];
        for (let p = 1; p <= Math.min(pdf.numPages, 60); p++) {
          const page = await pdf.getPage(p), vp = page.getViewport({ scale: 1.7 });
          const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
          await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
          pages.push(`<img class="doc-page" src="${c.toDataURL("image/jpeg", 0.85)}" alt="page ${p}">`);
        }
        return pages.join("") + (pdf.numPages > 60 ? `<p class="miss">Only the first 60 of ${pdf.numPages} pages are shown. Print the rest from the original file.</p>` : "");
      }
      if (TXT.test(file.name)) return `<pre class="doc-txt">${esc(await file.text())}</pre>`;
    } catch (e) { return `<p class="miss">This file couldn't be shown here (${esc(e.message)}). Print the original (${esc(file.name)}) and put it behind this page.</p>`; }
    return `<p class="miss">This type of file can't be printed from here. Print the original (${esc(file.name)}) and put it behind this page.</p>`;
  }
  // Exhibit numbers come from the kit's section 4 table: a row that starts with the number
  // and names the file ("| 2 | ... (IMG_1440.jpg) |") gives that file that number.
  function exhibitMap(kit, names) {
    const sec = (kit.split(/\n##\s*4\b/)[1] || "").split(/\n##\s/)[0];
    const map = new Map();
    for (const row of sec.split("\n")) {
      const m = row.match(/^\|\s*(\d{1,2})\s*\|(.*)$/); if (!m) continue;
      for (const n of names) { const stem = n.replace(/\.[^.]+$/, ""); if (!map.has(n) && (row.includes(n) || (stem.length > 5 && row.includes(stem)))) map.set(n, +m[1]); }
    }
    return map;
  }
  async function printBinder() {
    const w = window.open("", "_blank");   // inside the click, or the popup is blocked
    if (!w) { toast("Popup blocked. Allow popups for nocase.org, then try again."); return; }
    w.document.write("<p style='font-family:Georgia,serif;padding:2rem;font-size:16px'>Putting your binder together: your hearing kit, then every document as a numbered exhibit…</p>");
    try {
      const kit = await readText(KIT_FILE);
      if (!kit) throw new Error("build your hearing kit first");
      const docs = typeof listDocuments === "function" ? await listDocuments() : [];
      const dir = await folder().getDirectoryHandle("documents");
      const map = exhibitMap(kit, docs.map(d => d.name));
      const ordered = docs.filter(d => map.has(d.name)).sort((a, b) => map.get(a.name) - map.get(b.name) || a.name.localeCompare(b.name));
      const rest = docs.filter(d => !map.has(d.name));
      const section = async (d, label) => {
        const f = await (await dir.getFileHandle(d.name)).getFile();
        const added = d.meta && d.meta.addedAt ? new Date(d.meta.addedAt).toLocaleString() : "";
        return `<section class="exh"><div class="exh-head"><div class="exh-no">${esc(label)}</div><div class="exh-name">${esc(d.name)}</div>` +
          `<div class="exh-meta">${added ? "Added to the case file " + esc(added) + " · " : ""}${d.meta && d.meta.sha256 ? "SHA-256 " + esc(d.meta.sha256.slice(0, 16)) + "…" : ""}</div></div>${await renderDoc(f)}</section>`;
      };
      const exhibits = [];
      for (const d of ordered) exhibits.push(await section(d, "Exhibit " + map.get(d.name)));
      const appendix = [];
      for (const d of rest) appendix.push(await section(d, "Other document"));
      const title = cs().title || "Case file";
      // The cue cards go first: many courtrooms (this one included) allow no phones, so the
      // Hearing Day guide has to exist on paper too.
      let guide = null; try { guide = JSON.parse((await readText(GUIDE_FILE)) || "null"); } catch {}
      const cardsHtml = guide && guide.cards && guide.cards.length ? `<section class="cards"><h2>Hearing Day cue cards</h2><p>Read these in order during the hearing. The words in the boxes are what you say.</p>` +
        guide.cards.map(c => `<div class="card"><div class="card-no">Step ${c.n} of ${guide.cards.length}</div><h3>${esc(c.title)}</h3>` +
          (c.when ? `<p class="when">${esc(c.when)}</p>` : "") + (c.happening ? `<p>${esc(c.happening)}</p>` : "") +
          (c.exhibits && c.exhibits.length ? `<p><b>Have ready:</b> ${c.exhibits.map(x => "Exhibit " + esc(x)).join(", ")}</p>` : "") +
          (c.do && c.do.length ? `<ul>${c.do.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "") +
          (c.say ? `<div class="say"><b>Say:</b> ${esc(c.say)}</div>` : "") +
          (c.ifAsked && c.ifAsked.length ? `<div class="asked">${c.ifAsked.map(x => `<p><b>If asked:</b> ${esc(x.q)}<br><b>Answer:</b> ${esc(x.a)}</p>`).join("")}</div>` : "") +
          (c.caution ? `<div class="caut">${esc(c.caution)}</div>` : "") + `</div>`).join("") + `</section>`
        : `<p class="miss">Your Hearing Day cue cards aren't in this binder yet. Open "Hearing Day guide" once to create them, then print the binder again.</p>`;
      const kitHtml = window.__ncRenderKit ? window.__ncRenderKit(kit) : `<pre>${esc(kit)}</pre>`;
      w.document.open();
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hearing binder — ${esc(title)}</title><style>
        body { font-family: Georgia, 'Times New Roman', serif; color: #111; max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; line-height: 1.55; font-size: 14px; }
        h1 { font-size: 1.7rem; } h2 { font-size: 1.2rem; border-bottom: 2px solid #111; padding-bottom: 0.2rem; margin-top: 1.8rem; } h3 { font-size: 1.02rem; }
        table { width: 100%; border-collapse: collapse; font-size: 0.85rem; } th, td { border: 1px solid #bbb; padding: 0.3rem 0.45rem; text-align: left; vertical-align: top; }
        blockquote { border-left: 3px solid #999; margin: 0.5rem 0; padding-left: 0.8rem; } blockquote.caution { border: 2px solid #9a1c1c; background: #fdf3f2; padding: 0.6rem 0.8rem; }
        .bar { position: sticky; top: 0; background: #fff; padding: 0.6rem 0; border-bottom: 1px solid #ddd; margin-bottom: 1rem; display: flex; gap: 1rem; align-items: center; }
        .bar button { font: inherit; padding: 0.5rem 1rem; } .bar span { font-size: 0.85rem; color: #555; }
        .toc li { margin: 0.2rem 0; }
        .exh { page-break-before: always; break-before: page; }
        .exh-head { border: 2px solid #111; padding: 0.6rem 0.8rem; margin-bottom: 0.8rem; page-break-after: avoid; }
        .exh-no { font-size: 1.6rem; font-weight: bold; letter-spacing: 0.04em; text-transform: uppercase; } .exh-name { font-size: 0.95rem; } .exh-meta { font-size: 0.75rem; color: #555; }
        .doc-img, .doc-page { display: block; max-width: 100%; max-height: 9.3in; margin: 0 auto 0.6rem; object-fit: contain; page-break-inside: avoid; }
        .doc-page { page-break-after: always; } .doc-page:last-child { page-break-after: auto; }
        .doc-txt { white-space: pre-wrap; font-family: Georgia, serif; font-size: 12.5px; line-height: 1.5; }
        .miss { border: 1px dashed #999; padding: 1rem; font-style: italic; }
        .cards { page-break-before: always; break-before: page; } .exh-kit { page-break-before: always; break-before: page; }
        .card { border: 1.5px solid #111; border-radius: 6px; padding: 0.6rem 0.8rem; margin: 0 0 0.8rem; page-break-inside: avoid; }
        .card-no { font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; color: #555; } .card h3 { margin: 0.1rem 0 0.3rem; font-size: 1.1rem; }
        .card .when { font-style: italic; margin: 0 0 0.3rem; } .card ul { margin: 0.2rem 0 0.4rem; padding-left: 1.2rem; }
        .card .say { border-left: 5px solid #b8954a; background: #faf6ec; padding: 0.45rem 0.6rem; font-size: 1.05rem; margin: 0.35rem 0; }
        .card .asked p { margin: 0.3rem 0; font-size: 0.92rem; } .card .caut { border: 1.5px solid #9a1c1c; padding: 0.4rem 0.55rem; font-size: 0.88rem; margin-top: 0.35rem; }
        @media print { .bar { display: none; } body { padding: 0; } }
      </style></head><body>
        <div class="bar"><button onclick="window.print()">Print / Save as PDF</button><span>Print 3 copies of each exhibit: one for the judge, one for the other side, one for you.</span></div>
        <h1>Hearing binder — ${esc(title)}</h1>
        <p>Your Hearing Day cue cards, your hearing kit, then every document in your case file. Exhibit numbers match the exhibit list in the kit and the cue cards.</p>
        <ol class="toc">${ordered.map(d => `<li>Exhibit ${map.get(d.name)}: ${esc(d.name)}</li>`).join("")}${rest.length ? `<li>Other documents (not in the exhibit list): ${rest.map(d => esc(d.name)).join(", ")}</li>` : ""}</ol>
        ${cardsHtml}
        <section class="exh-kit">${kitHtml}</section>
        ${exhibits.join("")}${appendix.join("")}
        <p style="margin-top:2rem;font-size:0.8rem;color:#555">Prepared by the user with NoCase (nocase.org) from their own case file. Legal information, not legal advice.</p>
      </body></html>`);
      w.document.close();
    } catch (e) {
      w.document.open(); w.document.write("<p style='font-family:Georgia,serif;padding:2rem'>The binder didn't finish: " + esc(e.message) + ". Close this tab and try again.</p>"); w.document.close();
    }
  }
  window.ncPrintBinder = printBinder;
  // Used by the attorney packet: every document, printed in full, labelled by `label(d, i)`.
  window.ncDocumentsHtml = async function (docs, label) {
    const dir = await folder().getDirectoryHandle("documents");
    const out = [];
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i], f = await (await dir.getFileHandle(d.name)).getFile();
      const added = d.meta && d.meta.addedAt ? new Date(d.meta.addedAt).toLocaleString() : "";
      out.push(`<section class="exh"><div class="exh-head"><div class="exh-no">${esc(label(d, i))}</div><div class="exh-name">${esc(d.name)}</div><div class="exh-meta">${added ? "Added " + esc(added) + " · " : ""}${d.meta && d.meta.sha256 ? "SHA-256 " + esc(d.meta.sha256.slice(0, 16)) + "…" : ""}</div></div>${await renderDoc(f)}</section>`);
    }
    return out.join("");
  };
  window.ncDocumentsCss = `.exh { page-break-before: always; break-before: page; } .exh-head { border: 2px solid #111; padding: 0.6rem 0.8rem; margin-bottom: 0.8rem; } .exh-no { font-size: 1.5rem; font-weight: bold; text-transform: uppercase; } .exh-name { font-size: 0.95rem; } .exh-meta { font-size: 0.75rem; color: #555; }
    .doc-img, .doc-page { display: block; max-width: 100%; max-height: 9.3in; margin: 0 auto 0.6rem; object-fit: contain; page-break-inside: avoid; } .doc-page { page-break-after: always; } .doc-page:last-child { page-break-after: auto; }
    .doc-txt { white-space: pre-wrap; font-family: Georgia, serif; font-size: 12.5px; line-height: 1.5; } .miss { border: 1px dashed #999; padding: 1rem; font-style: italic; }`;
})();
