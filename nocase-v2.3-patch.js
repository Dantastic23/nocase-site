/*
 * NoCase v2.3 UI patch — three-stage flow + adaptive role labels
 *
 * What it does:
 *   • Hides the upfront "Case type" and "Your side" pickers in the input card.
 *   • After Run: calls classify_case, shows a Confirm card with the AI's pick and
 *     a "Not quite — change" override (curated 33-type catalog + adaptive role list).
 *   • After user confirms: runs judge_verdict + red_team_* + generate_questions
 *     in parallel and renders the verdict card, using role-pair labels instead of
 *     hardcoded "Plaintiff/Defendant".
 *   • Is idempotent — safe to load multiple times.
 *
 * Install: drop this file at the root of the site, then add
 *   <script src="/nocase-v2.3-patch.js?v=1" defer></script>
 * right before </body> in index.html. Requires Lambda v2.3 (benchmark-legal-research
 * zip in /outputs/benchmark-legal-research-v2.3.zip) deployed.
 */
(function () {
  'use strict';
  if (window.__ncV23PatchApplied) return;
  window.__ncV23PatchApplied = true;

  const PATCH_VERSION = 'v2.3.0';
  const API_URL = 'https://dxfdmuqx1a.execute-api.us-east-1.amazonaws.com/prod/analyze';

  // ─── Catalog ────────────────────────────────────────────────────────────
  const CASE_CATALOG = [
    { id: 'personal_injury',     label: 'Personal Injury',       group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'auto_accident',       label: 'Auto Accident',         group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'medical_malpractice', label: 'Medical Malpractice',   group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'premises_liability',  label: 'Premises Liability',    group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'product_liability',   label: 'Product Liability',     group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'wrongful_death',      label: 'Wrongful Death',        group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'defamation',          label: 'Defamation',            group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'fraud',               label: 'Fraud',                 group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'civil_rights',        label: 'Civil Rights (\u00A71983)', group: 'Civil',  rolePair: 'plaintiff_defendant' },
    { id: 'small_claims',        label: 'Small Claims',          group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'construction_defect', label: 'Construction Defect',   group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'breach_of_contract',  label: 'Breach of Contract',    group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'business_dispute',    label: 'Business Dispute',      group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'ip_dispute',          label: 'Intellectual Property', group: 'Civil',      rolePair: 'plaintiff_defendant' },
    { id: 'employment',          label: 'Employment',            group: 'Employment', rolePair: 'employee_employer' },
    { id: 'insurance_bad_faith', label: 'Insurance Bad Faith',   group: 'Civil',      rolePair: 'insured_insurer' },
    { id: 'landlord_tenant',     label: 'Landlord\u2013Tenant',  group: 'Housing',    rolePair: 'landlord_tenant' },
    { id: 'hoa_dispute',         label: 'HOA Dispute',           group: 'Housing',    rolePair: 'homeowner_hoa' },
    { id: 'felony',              label: 'Felony',                group: 'Criminal',   rolePair: 'prosecution_defendant' },
    { id: 'misdemeanor',         label: 'Misdemeanor',           group: 'Criminal',   rolePair: 'prosecution_defendant' },
    { id: 'dui_dwi',             label: 'DUI / DWI',             group: 'Criminal',   rolePair: 'prosecution_defendant' },
    { id: 'divorce',             label: 'Divorce',               group: 'Family',     rolePair: 'petitioner_respondent' },
    { id: 'child_custody',       label: 'Child Custody',         group: 'Family',     rolePair: 'petitioner_respondent' },
    { id: 'child_support',       label: 'Child Support',         group: 'Family',     rolePair: 'petitioner_respondent' },
    { id: 'protective_order',    label: 'Protective Order / DV', group: 'Family',     rolePair: 'petitioner_respondent' },
    { id: 'adoption',            label: 'Adoption',              group: 'Family',     rolePair: 'petitioner_respondent' },
    { id: 'guardianship',        label: 'Guardianship',          group: 'Family',     rolePair: 'petitioner_respondent' },
    { id: 'will_contest',        label: 'Will Contest',          group: 'Probate',    rolePair: 'petitioner_contestant' },
    { id: 'estate_dispute',      label: 'Estate Dispute',        group: 'Probate',    rolePair: 'petitioner_contestant' },
    { id: 'bankruptcy',          label: 'Bankruptcy',            group: 'Other',      rolePair: 'debtor_creditor' },
    { id: 'immigration',         label: 'Immigration',           group: 'Other',      rolePair: 'applicant_government' },
    { id: 'administrative',      label: 'Administrative Appeal', group: 'Other',      rolePair: 'appellant_agency' },
    { id: 'other',               label: 'Other',                 group: 'Other',      rolePair: 'generic' },
  ];

  const ROLE_PAIRS = {
    plaintiff_defendant:   { initiator: 'Plaintiff',   responder: 'Defendant'  },
    prosecution_defendant: { initiator: 'Prosecution', responder: 'Defendant'  },
    petitioner_respondent: { initiator: 'Petitioner',  responder: 'Respondent' },
    petitioner_contestant: { initiator: 'Petitioner',  responder: 'Contestant' },
    landlord_tenant:       { initiator: 'Landlord',    responder: 'Tenant'     },
    employee_employer:     { initiator: 'Employee',    responder: 'Employer'   },
    insured_insurer:       { initiator: 'Insured',     responder: 'Insurer'    },
    homeowner_hoa:         { initiator: 'Homeowner',   responder: 'HOA'        },
    debtor_creditor:       { initiator: 'Debtor',      responder: 'Creditor'   },
    applicant_government:  { initiator: 'Applicant',   responder: 'Government' },
    appellant_agency:      { initiator: 'Appellant',   responder: 'Agency'     },
    generic:               { initiator: 'Your Side',   responder: 'Other Side' },
  };

  function getCatalogEntry(id) {
    return CASE_CATALOG.find(c => c.id === id) || CASE_CATALOG.find(c => c.id === 'other');
  }
  function getRolePair(id) {
    const e = getCatalogEntry(id);
    return ROLE_PAIRS[e.rolePair] || ROLE_PAIRS.generic;
  }

  // ─── Utilities ──────────────────────────────────────────────────────────
  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style' && typeof attrs[k] === 'object') Object.assign(n.style, attrs[k]);
      else if (k === 'on' && typeof attrs[k] === 'object') for (const ev in attrs[k]) n.addEventListener(ev, attrs[k][ev]);
      else if (k in n) n[k] = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of [].concat(children)) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  function findFieldWrapper(input) {
    // Walk up to the enclosing <label> (or nearest block parent) that contains the label text
    let n = input;
    for (let i = 0; i < 5 && n && n !== document.body; i++) {
      if (n.tagName === 'LABEL') return n;
      n = n.parentElement;
    }
    return input.parentElement;
  }

  // ─── API ────────────────────────────────────────────────────────────────
  async function callTask(body) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('API ' + res.status);
    return res.json();
  }

  // judge_verdict now answers "WINNER: <literal role name>". The old Lambda answered
  // "VERDICT: PLAINTIFF|DEFENDANT", which is NOT safely mappable: the frontend used to
  // read PLAINTIFF as the case type's "initiator" role, but initiator is who typically
  // files that case type (a landlord evicts) -- not who filed this claim (a tenant
  // suing over a deposit). That inverted the verdict. If we see the legacy format we
  // refuse to name a winner rather than risk telling someone they lose when they win.
  function parseVerdict(text) {
    const t = String(text || '');
    const conf = parseInt((t.match(/CONFIDENCE:\s*(\d+)/) || [, '60'])[1], 10);
    return {
      winner: (t.match(/WINNER:\s*([^\n]+)/) || [, ''])[1].trim(),
      legacyToken: (t.match(/VERDICT:\s*(\w+)/) || [, ''])[1].toUpperCase(),
      confidence: isNaN(conf) ? 60 : conf,
      reasoning: (t.match(/REASONING:\s*([\s\S]*)/) || [, ''])[1].trim(),
    };
  }

  function parseQuestions(text) {
    const qs = [];
    const re = /Q\d:\s*([^\n]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) qs.push(m[1].trim());
    return qs.slice(0, 4);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // The model answers in markdown. Escape first, then render the small subset it
  // actually emits — otherwise the verdict lands as a wall of literal # and **.
  function mdToHtml(text) {
    const lines = escapeHtml(String(text || '').trim()).split('\n');
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (let line of lines) {
      const inline = s => s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (h) {
        closeList();
        const size = h[1].length <= 2 ? 14 : 13;
        out.push(`<div style="font-size:${size}px;font-weight:600;color:var(--ink,#1a1a1a);margin:12px 0 6px;">${inline(h[2])}</div>`);
      } else if (li) {
        if (!inList) { out.push('<ul style="margin:6px 0 6px 18px;padding:0;">'); inList = true; }
        out.push(`<li style="margin-bottom:4px;">${inline(li[1])}</li>`);
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        out.push(`<p style="margin:0 0 8px;">${inline(line)}</p>`);
      }
    }
    closeList();
    return out.join('');
  }

  // ─── Boot ───────────────────────────────────────────────────────────────
  onReady(() => {
    const caseSel = $('caseType');
    const userSel = $('userSide');
    if (!caseSel || !userSel) return; // not on the page we expect

    // 1. Expand caseType's options to the full 33-entry catalog — useful if
    //    anything else reads its value. Keep current value if still valid.
    const currentCase = caseSel.value;
    caseSel.innerHTML = '';
    for (const g of ['Civil', 'Employment', 'Housing', 'Criminal', 'Family', 'Probate', 'Other']) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const c of CASE_CATALOG.filter(x => x.group === g)) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.label;
        og.appendChild(o);
      }
      caseSel.appendChild(og);
    }
    if ([...caseSel.options].some(o => o.value === currentCase)) caseSel.value = currentCase;
    else caseSel.value = 'other';

    // 2. Hide the upfront pickers (keep in DOM as source of truth)
    const caseWrap = findFieldWrapper(caseSel);
    const userWrap = findFieldWrapper(userSel);
    if (caseWrap) caseWrap.style.display = 'none';
    if (userWrap) userWrap.style.display = 'none';

    // 3. Inject Confirm card after the input card containing the Run button
    const runBtn = $('ncRunBtn');
    if (!runBtn) return;
    const inputCard = runBtn.closest('.nc-card, [class*="card"], section, div.card, div') || runBtn.parentElement;
    // Find a container that's roughly the card — walk up until we find a block > 200px wide with padding
    let card = runBtn.parentElement;
    for (let i = 0; i < 8 && card && card !== document.body; i++) {
      const cs = getComputedStyle(card);
      if (cs.padding && parseInt(cs.padding) >= 8 && card.offsetWidth > 280) break;
      card = card.parentElement;
    }
    card = card || inputCard;

    if (!$('ncConfirmCard')) {
      const html = `
      <div id="ncConfirmCard" style="display:none;margin:16px 0;padding:20px;border:1px solid var(--rule, #e5e5e5);border-radius:12px;background:var(--paper, #fff);box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-muted, #888);font-weight:500;margin-bottom:10px;">Step 2 of 2 &middot; Confirm</div>
        <div style="font-size:15px;color:var(--ink, #1a1a1a);margin-bottom:12px;line-height:1.5;">Before we run the full analysis, does this look right?</div>
        <div id="ncConfirmSummary" style="font-size:15px;color:var(--ink, #1a1a1a);margin-bottom:16px;padding:12px 14px;background:#faf7f2;border-radius:8px;line-height:1.5;"></div>
        <div id="ncConfirmOverride" style="display:none;margin-bottom:16px;padding:12px;background:#fafafa;border:1px solid var(--rule, #eee);border-radius:8px;">
          <div style="margin-bottom:10px;">
            <label style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-muted, #888);margin-bottom:4px;">Case type</label>
            <select id="ncConfirmCaseType" style="width:100%;padding:8px 10px;border:1px solid var(--rule, #ddd);border-radius:6px;font-size:13px;font-family:inherit;background:#fff;"></select>
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-muted, #888);margin-bottom:4px;">Your role</label>
            <select id="ncConfirmUserRole" style="width:100%;padding:8px 10px;border:1px solid var(--rule, #ddd);border-radius:6px;font-size:13px;font-family:inherit;background:#fff;"></select>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="ncConfirmContinueBtn" type="button" style="flex:1 1 180px;padding:12px 20px;background:var(--ink, #1a1a1a);color:var(--paper, #fff);border:0;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit;">Looks good \u2014 analyze</button>
          <button id="ncConfirmOverrideBtn" type="button" style="padding:12px 18px;background:transparent;color:var(--ink, #1a1a1a);border:1px solid var(--rule, #ccc);border-radius:8px;font-weight:500;cursor:pointer;font-size:14px;font-family:inherit;">Not quite \u2014 change</button>
        </div>
      </div>`;
      card.insertAdjacentHTML('afterend', html);
    }

    // Populate override case type select with grouped options
    const confirmCaseType = $('ncConfirmCaseType');
    if (confirmCaseType && !confirmCaseType.options.length) {
      for (const g of ['Civil', 'Employment', 'Housing', 'Criminal', 'Family', 'Probate', 'Other']) {
        const og = document.createElement('optgroup');
        og.label = g;
        for (const c of CASE_CATALOG.filter(x => x.group === g)) {
          const o = document.createElement('option');
          o.value = c.id;
          o.textContent = c.label;
          og.appendChild(o);
        }
        confirmCaseType.appendChild(og);
      }
    }

    function populateRoleSelect(caseTypeId, currentRole) {
      const roleSel = $('ncConfirmUserRole');
      if (!roleSel) return;
      const pair = getRolePair(caseTypeId);
      roleSel.innerHTML = '';
      for (const r of [pair.initiator, pair.responder]) {
        const o = document.createElement('option');
        o.value = r;
        o.textContent = r;
        roleSel.appendChild(o);
      }
      if (currentRole && [pair.initiator, pair.responder].includes(currentRole)) roleSel.value = currentRole;
    }

    $('ncConfirmOverrideBtn').addEventListener('click', () => {
      const box = $('ncConfirmOverride');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
    $('ncConfirmCaseType').addEventListener('change', (e) => {
      const currRole = $('ncConfirmUserRole') ? $('ncConfirmUserRole').value : null;
      populateRoleSelect(e.target.value, currRole);
    });

    // 4. Replace the Run button handler entirely.
    // cloneNode(true) copies attributes, so the clone keeps the inline
    // onclick="ncRunAnalysis()" from index.html and the legacy flow fires alongside
    // this one — two flows racing on the same DOM nodes and double-billing Bedrock.
    // Strip it. If this patch never loads, the inline handler survives as the fallback.
    const newRunBtn = runBtn.cloneNode(true);
    newRunBtn.removeAttribute('onclick');
    newRunBtn.onclick = null;
    runBtn.parentNode.replaceChild(newRunBtn, runBtn);

    // Mutable state for the two-stage flow
    const state = {
      classified: null,        // parsed classify result
      caseTypeId: null,
      userRole: null,
      facts: '',
    };

    // Try to locate the facts textarea. Likely ids/names; fall back to first <textarea>.
    function getFacts() {
      const candidates = ['caseDesc', 'ncFacts', 'ncFactsInput', 'caseFacts', 'facts', 'description', 'ncDescription'];
      for (const id of candidates) {
        const n = $(id);
        if (n && (n.value || '').trim()) return n.value.trim();
      }
      const ta = document.querySelector('textarea');
      return ta ? (ta.value || '').trim() : '';
    }

    function setRunButtonText(t, disabled) {
      newRunBtn.textContent = t;
      newRunBtn.disabled = !!disabled;
      newRunBtn.style.opacity = disabled ? '0.6' : '1';
      newRunBtn.style.cursor = disabled ? 'default' : 'pointer';
    }

    function showError(msg) {
      const box = $('ncError');
      if (box) { box.textContent = msg; box.style.display = 'block'; }
      else console.error('[nc patch] ' + msg);
    }
    function clearError() {
      const box = $('ncError');
      if (box) { box.textContent = ''; box.style.display = 'none'; }
    }

    // STAGE 1: Run clicked → classify → show Confirm
    newRunBtn.addEventListener('click', async () => {
      clearError();
      const facts = getFacts();
      if (!facts || facts.length < 20) {
        showError('Please describe your case in a few sentences before running.');
        return;
      }
      state.facts = facts;
      setRunButtonText('Analyzing\u2026 (1/2)', true);
      try {
        const resp = await callTask({ task: 'classify_case', caseData: facts });
        const parsed = JSON.parse(resp.result);
        state.classified = parsed;
        state.caseTypeId = parsed.caseTypeId || 'other';
        state.userRole = parsed.userRole || getRolePair(state.caseTypeId).responder;

        // Mirror into hidden selects so any legacy readers still get a value
        if (caseSel) caseSel.value = state.caseTypeId;

        // Update confirm card
        const entry = getCatalogEntry(state.caseTypeId);
        const pair = getRolePair(state.caseTypeId);
        const otherRole = state.userRole === pair.initiator ? pair.responder : pair.initiator;
        const confPct = parsed.confidence || 60;
        const detectedEl = $('ncDetectedType');
        if (detectedEl) detectedEl.textContent = entry.label;

        $('ncConfirmSummary').innerHTML =
          `This looks like a <strong>${entry.label}</strong> case (${confPct}% confidence).<br>` +
          `You appear to be the <strong>${state.userRole}</strong>; the other side is the <strong>${otherRole}</strong>.` +
          (parsed.reasoning ? `<div style="margin-top:8px;font-size:13px;color:var(--ink-muted,#888);">${parsed.reasoning}</div>` : '');

        $('ncConfirmCaseType').value = state.caseTypeId;
        populateRoleSelect(state.caseTypeId, state.userRole);
        $('ncConfirmCard').style.display = 'block';
        $('ncConfirmCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
        setRunButtonText('Run again', false);
      } catch (e) {
        // Users here are mid-legal-crisis. "API 500" means nothing to them; the only
        // things that matter are that their typing is safe and what to press next.
        console.error(e);
        showError('We couldn’t reach the analysis engine. Your case description is saved — press “Run analysis” to try again. If it keeps failing, email hello@benchmark.com.');
        setRunButtonText('Run analysis', false);
      }
    });

    // STAGE 2: Confirm Continue → full analysis
    // Runnable more than once: a failed analysis re-shows the Confirm card and the
    // retry links call straight back in here, so state.facts survives. Never reload
    // the page to retry — that wipes the case description the user typed.
    let analysisRunning = false;
    async function runAnalysis() {
      if (analysisRunning) return;
      analysisRunning = true;
      clearError();

      const pair = getRolePair(state.caseTypeId);
      const entry = getCatalogEntry(state.caseTypeId);
      const otherRole = state.userRole === pair.initiator ? pair.responder : pair.initiator;

      // Mirror into hidden selects
      if (caseSel) caseSel.value = state.caseTypeId;

      const btn = $('ncConfirmContinueBtn');
      btn.disabled = true;
      btn.style.opacity = '0.6';

      const set = (id, val) => { const n = $(id); if (n) n.textContent = val; };
      const setHtml = (id, val) => { const n = $(id); if (n) n.innerHTML = val; };

      // The red-team calls take 45-90s. Show the courtroom immediately, label the
      // sides we already know, and paint each panel the moment its own call lands \u2014
      // rather than holding a finished verdict hostage until the slowest call returns.
      const courtroom = $('ncCourtroom');
      if (courtroom) courtroom.style.display = '';
      $('ncConfirmCard').style.display = 'none';
      set('ncProsLabel', pair.initiator.toUpperCase());
      set('ncDefLabel', pair.responder.toUpperCase());
      set('ncProsBadge', '\u2026');
      set('ncDefBadge', '\u2026');

      const pending = '<p style="margin:0;font-size:13px;color:var(--ink-muted,#888);">Working\u2026</p>';
      setHtml('ncProsBody', pending);
      setHtml('ncDefBody', pending);
      setHtml('ncJudgeBody', pending);
      if (courtroom) courtroom.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // #ncTimer is the only visible progress surface here \u2014 ncConfirmContinueBtn
      // lives inside ncConfirmCard, which we just hid, so don't bother writing to it.
      const timerEl = $('ncTimer');
      if (timerEl) timerEl.style.display = 'block';
      const startedAt = Date.now();
      let done = 0, failed = 0;
      const TOTAL = 4;
      const tick = () => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');
        if (timerEl) {
          timerEl.textContent = `Analyzing \u2014 ${mm}:${ss} elapsed \u00b7 ${done} of ${TOTAL} done \u00b7 a full analysis usually takes 60\u201390 seconds. You can leave this open.`;
        }
      };
      tick();
      const timerId = setInterval(tick, 1000);
      const step = () => { done++; tick(); };

      const common = {
        caseData: state.facts,
        caseType: entry.label,
        caseTypeId: state.caseTypeId,
        userRole: state.userRole,
        otherRole,
      };
      const panelError = (id, label) => {
        failed++;
        setHtml(id,
          `<p style="margin:0;font-size:13px;color:var(--ink-soft,#555);">Couldn\u2019t load the ${escapeHtml(label)}. <a href="#" class="nc-retry" style="color:inherit;">Try again</a>, or email hello@benchmark.com.</p>`);
        const node = $(id), link = node && node.querySelector('.nc-retry');
        // A panel can fail fast (429) while the slow calls are still running; runAnalysis()
        // early-returns on the analysisRunning guard, which made this link a silent no-op
        // exactly when it's shown. Say what's happening instead of doing nothing.
        if (link) link.addEventListener('click', (ev) => {
          ev.preventDefault();
          if (analysisRunning) { link.textContent = 'Waiting for the other panels to finish…'; return; }
          runAnalysis();
        });
      };

      const jobs = [
        callTask({ ...common, task: 'judge_verdict' }).then(r => {
          const verdict = parseVerdict(r.result || '');
          // Forgiving normalize: models decorate the WINNER line ('WINNER: "Tenant"',
          // '**Tenant**', 'The Tenant.') -- the Lambda prompt even shows the role names
          // in quotes, so decoration is the expected case, not the weird one.
          const norm = s => String(s || '').trim().toLowerCase()
            .replace(/[*_`"'\u201c\u201d]/g, '')
            .replace(/^the\s+/, '')
            .replace(/[.!:]+$/, '')
            .trim();
          const w = norm(verdict.winner);
          const roles = [norm(pair.initiator), norm(pair.responder)];

          const renderUnavailable = (why) => {
            set('ncProsBadge', '\u2014');
            set('ncDefBadge', '\u2014');
            setHtml('ncJudgeBody',
              `<p style="margin:0 0 8px;"><strong>Verdict unavailable.</strong></p>` +
              `<p style="margin:0 0 10px;font-size:13px;color:var(--ink-soft,#555);">The analysis engine returned a result this version can\u2019t read reliably, and we won\u2019t guess which side it favours. The arguments for each side are still shown.</p>` +
              mdToHtml(verdict.reasoning));
            console.warn('[nocase] ' + why);
          };

          // Old Lambda still deployed: PLAINTIFF/DEFENDANT can't be mapped to a role
          // without guessing who filed. Say so instead of risking an inverted verdict.
          if (!w && verdict.legacyToken) {
            renderUnavailable('judge_verdict returned the legacy VERDICT: token. Redeploy the Lambda \u2014 the new prompt answers WINNER: <role name>.');
            return;
          }

          // Same refusal for anything that names neither role of this case type: an
          // empty result, error prose, or a paraphrased winner must never be scored as
          // "the user lost" (a winner-vs-userRole mismatch used to do exactly that),
          // nor rendered as a real 50/50 verdict. INSUFFICIENT is the one non-role
          // answer the Lambda prompt allows, and keeps its too-close rendering below.
          const insufficient = w === 'insufficient';
          if (!insufficient && !roles.includes(w)) {
            renderUnavailable('judge_verdict named an unrecognized winner: ' + JSON.stringify(verdict.winner));
            return;
          }

          const userWins = !insufficient && w === norm(state.userRole);
          const userPct = insufficient ? 50 : (userWins ? verdict.confidence : 100 - verdict.confidence);
          const initiatorPct = norm(state.userRole) === norm(pair.initiator) ? userPct : 100 - userPct;

          set('ncProsBadge', initiatorPct + '%');
          set('ncDefBadge', (100 - initiatorPct) + '%');

          // #ncFill has to be built here. It was never a static element in index.html --
          // it only existed because the legacy flow injected it, which is why the bar
          // "worked" while the two flows were racing. This card owns it now.
          // The bar shows userPct: how strong THE USER'S side is, not the winner's.
          const barColor = userPct >= 60 ? 'var(--green,#2e7d32)'
            : userPct >= 40 ? 'var(--gold,#b8922a)'
            : 'var(--red,#c0392b)';
          // Display the canonical role name, not the model's raw WINNER text \u2014 the raw
          // string can carry markdown/quotes that norm() forgave.
          const winnerRole = w === roles[0] ? pair.initiator : pair.responder;
          const head = insufficient
            ? 'Too close to call on these facts.'
            : `${escapeHtml(winnerRole)} prevails \u2014 ${verdict.confidence}% confidence.`;
          setHtml('ncJudgeBody',
            `<p style="margin:0 0 10px;"><strong>${head}</strong></p>` +
            `<div style="margin:0 0 4px;font-size:11px;color:var(--ink-muted,#888);">Your position (${escapeHtml(state.userRole)}) \u2014 ${userPct}%</div>` +
            `<div style="height:6px;background:var(--paper-dark,#eee);border-radius:3px;overflow:hidden;margin-bottom:12px;">` +
            `<div id="ncFill" data-pct="${userPct}" style="height:100%;width:0%;background:${barColor};border-radius:3px;transition:width 1.2s ease;"></div></div>` +
            mdToHtml(verdict.reasoning));
          // Paint at 0% first, then animate \u2014 the transition needs a frame at the old width.
          requestAnimationFrame(() => {
            const fill = $('ncFill');
            if (fill) fill.style.width = userPct + '%';
          });

          // The hero headline is the biggest text on the page. Only the legacy flow used
          // to update it, so once that stopped firing it sat on its static default
          // ("You don't have a case.") no matter what the verdict said. Drive it here.
          const hero = document.querySelector('.hero-headline');
          // Class selector, not an id: the hero sub is <p class="hero-sub"> with no id.
          // $('mainSub') matched nothing and silently killed all verdict sub-copy.
          const sub = document.querySelector('.hero-sub');
          if (hero) {
            // Classes, not style.color: the hero is dark now and the verdict palette
            // lives in CSS (--green-bright etc.) so it can stay in one place.
            hero.classList.remove('verdict-good', 'verdict-mixed', 'verdict-bad');
            if (insufficient) {
              hero.innerHTML = 'It\u2019s <em>too close</em><br>to call.';
              hero.classList.add('verdict-mixed');
            } else if (userPct >= 60) {
              hero.innerHTML = 'You <em>do</em> have<br>a case.';
              hero.classList.add('verdict-good');
            } else if (userPct >= 40) {
              hero.innerHTML = 'You might have<br><em>a case.</em>';
              hero.classList.add('verdict-mixed');
            } else {
              hero.innerHTML = 'You don\u2019t have<br><em>a case.</em>';
              hero.classList.add('verdict-bad');
            }
          }
          if (sub) {
            sub.textContent = insufficient
              ? 'The facts are evenly balanced. More evidence would tip it either way.'
              : userPct >= 60 ? 'Benchmark found a viable case. Review the analysis and connect with an attorney.'
              : userPct >= 40 ? 'The analysis is mixed. More evidence could strengthen your position.'
              : 'The analysis does not favour your position.';
          }

          const scoreF = $('ncLeadScore');
          if (scoreF) scoreF.value = userPct + '%';
        }).catch(e => {
          console.error(e);
          set('ncProsBadge', '\u2014');   // don't leave the badges stuck on "\u2026"
          set('ncDefBadge', '\u2014');
          panelError('ncJudgeBody', 'verdict');
        }).finally(step),

        callTask({ ...common, task: 'red_team_plaintiff' }).then(r => {
          setHtml('ncProsBody', mdToHtml(r.result || ''));
        }).catch(e => { console.error(e); panelError('ncProsBody', pair.initiator + ' case'); }).finally(step),

        callTask({ ...common, task: 'red_team_defendant' }).then(r => {
          setHtml('ncDefBody', mdToHtml(r.result || ''));
        }).catch(e => { console.error(e); panelError('ncDefBody', pair.responder + ' case'); }).finally(step),

        callTask({ ...common, task: 'generate_questions' }).then(r => {
          const questions = parseQuestions(r.result || '');
          const qaList = $('ncQAList');
          if (qaList && questions.length) {
            qaList.innerHTML = '';
            questions.forEach((q, i) => {
              const wrap = document.createElement('div');
              wrap.style.cssText = 'margin-bottom:12px;';
              wrap.innerHTML =
                `<label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px;">Q${i + 1}: ${escapeHtml(q)}</label>` +
                `<input type="text" class="nc-q-answer" data-q="${i}" style="width:100%;padding:8px 10px;border:1px solid var(--rule, #ddd);border-radius:6px;font-size:13px;font-family:inherit;" placeholder="Your answer\u2026">`;
              qaList.appendChild(wrap);
            });
            const qaCard = $('ncQACard');
            if (qaCard) qaCard.style.display = '';
          }
        }).catch(e => { console.error(e); failed++; }).finally(step),
      ];

      const summaryF = $('ncLeadCaseSummary');
      if (summaryF) summaryF.value = state.facts;
      const typeF = $('ncLeadCaseType');
      if (typeF) typeF.value = entry.label;

      await Promise.allSettled(jobs);
      clearInterval(timerId);
      if (timerEl) timerEl.style.display = 'none';
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = 'Looks good — analyze';
      analysisRunning = false;

      // Nothing came back at all. Put the Confirm card back so the user can retry
      // (or correct the case type) with their facts still in the box.
      if (failed === TOTAL) {
        if (courtroom) courtroom.style.display = 'none';
        showError('Analysis failed — nothing came back. Your case description is still here; press “Looks good — analyze” to try again.');
        $('ncConfirmCard').style.display = 'block';
        $('ncConfirmCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    $('ncConfirmContinueBtn').addEventListener('click', () => {
      // Apply any override, then run.
      state.caseTypeId = $('ncConfirmCaseType').value || state.caseTypeId;
      state.userRole = $('ncConfirmUserRole').value || state.userRole;
      runAnalysis();
    });

    console.log('[nocase] v2.3 patch applied (' + PATCH_VERSION + ')');
  });
})();
