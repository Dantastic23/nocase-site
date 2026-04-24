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

  function parseVerdict(text) {
    const m = {
      verdict: (text.match(/VERDICT:\s*(\w+)/) || [,'INSUFFICIENT'])[1].toUpperCase(),
      confidence: parseInt((text.match(/CONFIDENCE:\s*(\d+)/) || [,'60'])[1], 10),
      reasoning: (text.match(/REASONING:\s*([\s\S]*)/) || [,''])[1].trim(),
    };
    if (isNaN(m.confidence)) m.confidence = 60;
    return m;
  }

  function parseQuestions(text) {
    const qs = [];
    const re = /Q\d:\s*([^\n]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) qs.push(m[1].trim());
    return qs.slice(0, 4);
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

    // 4. Replace the Run button handler entirely
    const newRunBtn = runBtn.cloneNode(true);
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
        console.error(e);
        showError('Classification failed: ' + e.message);
        setRunButtonText('Run analysis', false);
      }
    });

    // STAGE 2: Confirm Continue → full analysis
    $('ncConfirmContinueBtn').addEventListener('click', async () => {
      clearError();
      // Apply any override
      state.caseTypeId = $('ncConfirmCaseType').value || state.caseTypeId;
      state.userRole = $('ncConfirmUserRole').value || state.userRole;
      const pair = getRolePair(state.caseTypeId);
      const entry = getCatalogEntry(state.caseTypeId);
      const otherRole = state.userRole === pair.initiator ? pair.responder : pair.initiator;

      // Mirror into hidden selects
      if (caseSel) caseSel.value = state.caseTypeId;

      const btn = $('ncConfirmContinueBtn');
      const prevTxt = btn.textContent;
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.textContent = 'Analyzing\u2026';

      try {
        const common = {
          caseData: state.facts,
          caseType: entry.label,
          caseTypeId: state.caseTypeId,
          userRole: state.userRole,
          otherRole,
        };
        const [verdictR, prosR, defR, qR] = await Promise.all([
          callTask({ ...common, task: 'judge_verdict' }),
          callTask({ ...common, task: 'red_team_plaintiff' }),
          callTask({ ...common, task: 'red_team_defendant' }),
          callTask({ ...common, task: 'generate_questions' }),
        ]);

        const verdict = parseVerdict(verdictR.result || '');
        // Map internal tokens to role-pair labels.
        // VERDICT: PLAINTIFF  -> initiator wins
        // VERDICT: DEFENDANT  -> responder wins
        const initiatorWins = verdict.verdict === 'PLAINTIFF';
        const userIsInitiator = state.userRole === pair.initiator;
        // Confidence is strength of the WINNER. Convert to initiator-pct.
        const initiatorPct = initiatorWins ? verdict.confidence : (100 - verdict.confidence);
        const userPct = userIsInitiator ? initiatorPct : (100 - initiatorPct);

        // Populate the verdict card
        // Court room rendering: left/prosLabel is initiator side, right/defLabel is responder side
        const set = (id, val) => { const n = $(id); if (n) n.textContent = val; };
        const setHtml = (id, val) => { const n = $(id); if (n) n.innerHTML = val; };

        set('ncProsLabel', pair.initiator.toUpperCase());
        set('ncDefLabel', pair.responder.toUpperCase());
        set('ncProsBadge', initiatorPct + '%');
        set('ncDefBadge', (100 - initiatorPct) + '%');
        setHtml('ncProsBody', (prosR.result || '').replace(/\n/g, '<br>'));
        setHtml('ncDefBody', (defR.result || '').replace(/\n/g, '<br>'));
        setHtml('ncJudgeBody',
          `<strong>${initiatorWins ? pair.initiator : pair.responder} prevails \u2014 ${verdict.confidence}% confidence.</strong><br><br>` +
          (verdict.reasoning || '').replace(/\n/g, '<br>'));

        // Score bar (ncFill is presumably a width-driven element)
        const fill = $('ncFill');
        if (fill) {
          fill.style.width = userPct + '%';
          fill.setAttribute('data-pct', userPct);
        }

        // Reveal courtroom + QA card
        const courtroom = $('ncCourtroom');
        if (courtroom) courtroom.style.display = '';

        // Populate Q&A
        const questions = parseQuestions(qR.result || '');
        const qaList = $('ncQAList');
        if (qaList && questions.length) {
          qaList.innerHTML = '';
          questions.forEach((q, i) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'margin-bottom:12px;';
            wrap.innerHTML =
              `<label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px;">Q${i+1}: ${q}</label>` +
              `<input type="text" class="nc-q-answer" data-q="${i}" style="width:100%;padding:8px 10px;border:1px solid var(--rule, #ddd);border-radius:6px;font-size:13px;font-family:inherit;" placeholder="Your answer\u2026">`;
            qaList.appendChild(wrap);
          });
          const qaCard = $('ncQACard');
          if (qaCard) qaCard.style.display = '';
        }

        // Mirror hints into lead-capture fields if present
        const summaryF = $('ncLeadCaseSummary');
        if (summaryF) summaryF.value = state.facts;
        const typeF = $('ncLeadCaseType');
        if (typeF) typeF.value = entry.label;
        const scoreF = $('ncLeadScore');
        if (scoreF) scoreF.value = userPct + '%';

        // Tuck the confirm card away
        $('ncConfirmCard').style.display = 'none';
        (courtroom || $('ncProsBody')).scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        console.error(e);
        showError('Analysis failed: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.textContent = prevTxt;
      }
    });

    console.log('[nocase] v2.3 patch applied (' + PATCH_VERSION + ')');
  });
})();
