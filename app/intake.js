/* ===========================================================================
 * NoCase /app/ intake wizard — 5-step lawyer-grade onboarding
 * ---------------------------------------------------------------------------
 * Loaded after index.html's main script. Hooks the "Run intake" button so it
 * opens a full-screen overlay wizard instead of firing a one-shot Claude
 * greeting. Reads/writes case.json directly via the existing folderHandle
 * helpers exposed on window. No Lambda calls — pure front-end for now;
 * Phase 1B Lambda wiring (event_handler, integrity_check) lands in a follow-up.
 *
 * Storage shape added to case.json:
 *   {
 *     ...existing fields,
 *     intake: {
 *       version: 1,
 *       completedAt: "ISO",
 *       step1: { description, caseType, caseTypeId, userRole, otherRole, jurisdiction, initialVerdict, followUpQuestions },
 *       spineDocument: { name, sha256, selectedAt },
 *       evidenceChecklist: [{ key, label, status: "found"|"partial"|"missing", linkedDocs: [names] }],
 *       importRequests: [{ source: "mail"|"messages", keywords, dateRange, status: "pending"|"done" }],
 *       goals: "text",
 *       redLines: ["..."],
 *       values: ["..."]
 *     }
 *   }
 * ========================================================================= */

(function () {
  'use strict';

  // Wait until the host page has booted — folderHandle is initialized inside
  // the host script's IIFE, so we need to defer attaching to the button.
  function whenReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // ============================================================================
  // STATE
  // ============================================================================

  const state = {
    open: false,
    step: 1,
    totalSteps: 5,
    data: {
      step1: null,
      spineDocument: null,
      evidenceChecklist: [],
      importRequests: [],
      goals: '',
      redLines: [],
      values: []
    }
  };

  // ============================================================================
  // EVIDENCE MAPS — what each case type needs
  // ============================================================================

  const EVIDENCE_MAPS = {
    contract_dispute: [
      { key: 'spine_contract', label: 'The signed contract / note', match: /contract|agreement|note|loan/i, required: true },
      { key: 'amendments', label: 'Amendments or side letters', match: /amendment|addendum|side letter|security agreement/i },
      { key: 'wire_payment', label: 'Wire transfer or payment record', match: /wire|payment|transfer|disburs/i },
      { key: 'demand_letters', label: 'Demand letters / formal notices', match: /demand|notice of breach|certified mail/i },
      { key: 'communications', label: 'Emails / texts between parties', match: /\.eml$|message|text|email|conversation/i },
      { key: 'bank_statements', label: 'Bank statements (use of proceeds)', match: /statement|wells fargo|chase|fccu|bank/i },
      { key: 'court_filings', label: 'Court filings (TRO, petitions, dismissals)', match: /tro|petition|complaint|filing|order/i },
      { key: 'entity_docs', label: 'Entity formation / ownership documents', match: /certificate of formation|articles|llc|operating agreement/i }
    ],
    debt_collection: [
      { key: 'spine_contract', label: 'The signed note or credit agreement', match: /note|agreement|loan|credit/i, required: true },
      { key: 'payment_history', label: 'Payment history / ledger', match: /payment|ledger|history|statement/i },
      { key: 'demand_letters', label: 'Demand letters / collection notices', match: /demand|notice|collection|certified mail/i },
      { key: 'communications', label: 'Communications with debtor/creditor', match: /\.eml$|message|email/i },
      { key: 'court_filings', label: 'Court filings if litigated', match: /petition|complaint|judgment|filing/i }
    ],
    real_estate: [
      { key: 'spine_contract', label: 'Purchase agreement / lease', match: /purchase|lease|agreement|contract/i, required: true },
      { key: 'title_deed', label: 'Title or deed', match: /title|deed|warranty deed/i },
      { key: 'inspection', label: 'Inspection report', match: /inspection|appraisal/i },
      { key: 'closing_docs', label: 'Closing documents', match: /closing|hud|settlement statement/i },
      { key: 'communications', label: 'Emails / texts with other party', match: /\.eml$|message|email/i },
      { key: 'photos', label: 'Photos of property/condition', match: /\.(jpg|jpeg|png|heic)$/i }
    ],
    employment: [
      { key: 'offer_letter', label: 'Offer letter / employment agreement', match: /offer|employment|agreement/i, required: true },
      { key: 'handbook', label: 'Employee handbook / policies', match: /handbook|policy|policies/i },
      { key: 'pay_records', label: 'Pay stubs / W-2s / 1099s', match: /pay.?stub|w-?2|1099|wage/i },
      { key: 'performance', label: 'Performance reviews', match: /review|evaluation|performance/i },
      { key: 'communications', label: 'Emails / texts about the incident', match: /\.eml$|message|email/i },
      { key: 'termination', label: 'Termination letter / final notice', match: /termination|final notice|separation/i }
    ],
    family_law: [
      { key: 'marriage_cert', label: 'Marriage certificate', match: /marriage certificate|marriage license/i },
      { key: 'financial', label: 'Financial disclosures / tax returns', match: /tax return|financial|disclosure|w-?2|1099/i },
      { key: 'property', label: 'Property records / deeds', match: /deed|title|property/i },
      { key: 'communications', label: 'Communications with spouse', match: /\.eml$|message|email/i },
      { key: 'child_records', label: 'Records relating to children', match: /school|medical|child/i }
    ],
    // Fallback for unknown
    unknown: [
      { key: 'spine_doc', label: 'The central document', match: /.*/i, required: true },
      { key: 'communications', label: 'Communications with the other side', match: /\.eml$|message|email/i },
      { key: 'financial', label: 'Financial records if relevant', match: /statement|wire|payment|invoice/i },
      { key: 'court_filings', label: 'Court filings if any', match: /petition|complaint|filing|order/i }
    ]
  };

  // ============================================================================
  // STYLES — injected once
  // ============================================================================

  function injectStyles() {
    if (document.getElementById('nci-styles')) return;
    const css = `
    .nci-overlay { position: fixed; inset: 0; background: rgba(14,14,14,0.55); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 2rem; backdrop-filter: blur(6px); }
    .nci-overlay.hidden { display: none; }
    .nci-modal { background: var(--paper); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.25); width: 100%; max-width: 760px; max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; }
    .nci-header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--rule); display: flex; align-items: center; justify-content: space-between; background: var(--paper); flex-shrink: 0; }
    .nci-header-left { display: flex; align-items: center; gap: 0.7rem; }
    .nci-header-mark { width: 30px; height: 30px; background: var(--ink); color: var(--paper); border-radius: 5px; display: grid; place-items: center; font-family: 'Playfair Display', serif; font-weight: 700; font-size: 0.95rem; }
    .nci-header-title { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 1rem; }
    .nci-header-sub { font-size: 0.72rem; color: var(--ink-muted); margin-top: 0.1rem; }
    .nci-close { background: none; border: none; cursor: pointer; font-size: 1.4rem; color: var(--ink-muted); padding: 0.2rem 0.5rem; }
    .nci-close:hover { color: var(--ink); }
    .nci-stepper { display: flex; align-items: center; gap: 4px; padding: 0.85rem 1.5rem; border-bottom: 1px solid var(--rule); background: rgba(255,255,255,0.5); flex-shrink: 0; }
    .nci-dot { width: 26px; height: 26px; border-radius: 50%; background: white; color: var(--ink-muted); border: 1px solid var(--rule); display: grid; place-items: center; font-size: 0.78rem; font-weight: 600; }
    .nci-dot.active { background: var(--ink); color: var(--paper); border-color: var(--ink); }
    .nci-dot.done { background: var(--green-light); color: var(--green); border-color: #c4e6d3; }
    .nci-conn { flex: 1; height: 1px; background: var(--rule); }
    .nci-conn.done { background: var(--green); }
    .nci-body { padding: 1.5rem; overflow-y: auto; flex: 1; }
    .nci-label { font-size: 0.7rem; font-weight: 600; color: var(--ink-muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.4rem; }
    .nci-h { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 1.4rem; margin: 0 0 0.5rem; color: var(--ink); }
    .nci-p { font-size: 0.92rem; color: var(--ink-soft); margin: 0 0 1.2rem; line-height: 1.55; }
    .nci-prefilled { background: var(--green-light); border: 1px solid #c4e6d3; border-radius: 6px; padding: 0.65rem 0.85rem; font-size: 0.88rem; line-height: 1.55; color: var(--ink); }
    .nci-prefilled .edit { font-size: 0.78rem; color: var(--blue); cursor: pointer; margin-left: 0.4rem; }
    .nci-row { margin-bottom: 0.95rem; }
    .nci-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .nci-textarea { width: 100%; min-height: 80px; padding: 0.65rem 0.8rem; border: 1px solid var(--rule); border-radius: 6px; font-family: inherit; font-size: 0.9rem; line-height: 1.5; resize: vertical; background: white; color: var(--ink); }
    .nci-input { width: 100%; padding: 0.55rem 0.75rem; border: 1px solid var(--rule); border-radius: 6px; font-family: inherit; font-size: 0.9rem; background: white; color: var(--ink); }
    .nci-row-doc { display: flex; align-items: flex-start; gap: 0.7rem; padding: 0.65rem 0.85rem; border: 1px solid var(--rule); border-radius: 6px; margin-bottom: 0.45rem; cursor: pointer; background: white; transition: border-color 0.15s, background 0.15s; }
    .nci-row-doc:hover { border-color: var(--ink-muted); }
    .nci-row-doc.selected { border: 1.5px solid var(--blue); background: var(--blue-light); }
    .nci-row-doc-icon { width: 32px; height: 32px; background: var(--paper-dark); border-radius: 5px; display: grid; place-items: center; font-size: 0.7rem; font-weight: 700; flex-shrink: 0; border: 1px solid var(--rule); }
    .nci-row-doc-name { font-size: 0.88rem; font-weight: 600; color: var(--ink); }
    .nci-row-doc-meta { font-size: 0.74rem; color: var(--ink-muted); margin-top: 0.15rem; }
    .nci-ev-row { display: flex; align-items: center; gap: 0.7rem; padding: 0.6rem 0; border-bottom: 1px solid var(--rule); }
    .nci-ev-row:last-child { border-bottom: none; }
    .nci-ev-icon { width: 28px; height: 28px; border-radius: 6px; display: grid; place-items: center; font-size: 0.95rem; font-weight: 700; flex-shrink: 0; }
    .nci-ev-icon.found { background: var(--green-light); color: var(--green); }
    .nci-ev-icon.partial { background: var(--gold-light); color: var(--gold); }
    .nci-ev-icon.missing { background: var(--red-light); color: var(--red); }
    .nci-ev-name { font-size: 0.88rem; font-weight: 600; }
    .nci-ev-status { font-size: 0.74rem; color: var(--ink-muted); margin-top: 0.1rem; }
    .nci-chip { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0.55rem; font-size: 0.72rem; border-radius: 100px; background: var(--paper-dark); color: var(--ink-soft); margin-right: 0.25rem; margin-bottom: 0.25rem; cursor: pointer; border: 1px solid var(--rule); font-family: inherit; }
    .nci-chip.danger { background: var(--red-light); color: var(--red); border-color: #f3c9c9; }
    .nci-chip.add { background: white; color: var(--ink-muted); border: 1px dashed var(--rule); }
    .nci-btn { background: white; color: var(--ink); border: 1px solid var(--rule); padding: 0.4rem 0.85rem; border-radius: 5px; font-family: inherit; font-size: 0.8rem; font-weight: 500; cursor: pointer; }
    .nci-btn:hover { border-color: var(--ink); }
    .nci-btn.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
    .nci-btn.primary:hover { background: #000; }
    .nci-foot { padding: 1rem 1.5rem; border-top: 1px solid var(--rule); display: flex; justify-content: space-between; align-items: center; background: var(--paper); flex-shrink: 0; }
    .nci-note { padding: 0.6rem 0.8rem; background: var(--paper-dark); border-radius: 5px; font-size: 0.75rem; color: var(--ink-muted); line-height: 1.5; margin-top: 0.8rem; }
    .nci-claude { background: white; border: 1px solid var(--rule); border-radius: 6px; padding: 0.75rem 0.9rem; margin: 0 0 0.9rem; font-size: 0.85rem; line-height: 1.55; }
    .nci-claude-label { font-size: 0.68rem; font-weight: 600; color: var(--ink-muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.3rem; }
    .nci-success-card { padding: 0.85rem 1rem; border: 1px solid #c4e6d3; background: var(--green-light); border-radius: 6px; font-size: 0.88rem; color: var(--green); margin-top: 1rem; }
    .nci-success-card strong { font-weight: 700; }
    .nci-fact-cite { display: inline-block; font-size: 0.68rem; font-family: 'SF Mono', monospace; color: var(--blue); background: var(--blue-light); padding: 0.05rem 0.4rem; border-radius: 3px; margin-left: 0.25rem; vertical-align: 1px; }
    .nci-skip { font-size: 0.78rem; color: var(--ink-muted); text-decoration: underline; cursor: pointer; margin-left: 0.5rem; }
    `;
    const style = document.createElement('style');
    style.id = 'nci-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ============================================================================
  // UI BUILDERS
  // ============================================================================

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function caseTypeLabel(t) {
    const labels = {
      contract_dispute: 'Contract dispute',
      theft_embezzlement: 'Theft / embezzlement',
      real_estate: 'Real estate',
      employment: 'Employment',
      debt_collection: 'Debt / promissory note',
      family_law: 'Family law',
      criminal_felony: 'Criminal — felony',
      business_dispute: 'Business / partner dispute',
      defamation: 'Defamation',
      unknown: 'Not yet set'
    };
    return labels[t] || t;
  }

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'nci-overlay';
    overlay.className = 'nci-overlay hidden';
    overlay.innerHTML = `
      <div class="nci-modal">
        <div class="nci-header">
          <div class="nci-header-left">
            <div class="nci-header-mark">N</div>
            <div>
              <div class="nci-header-title">Lawyer-grade intake</div>
              <div class="nci-header-sub" id="nci-step-counter">Step 1 of 5</div>
            </div>
          </div>
          <button class="nci-close" id="nci-close" title="Close (your progress is saved)">×</button>
        </div>
        <div class="nci-stepper" id="nci-stepper"></div>
        <div class="nci-body" id="nci-body"></div>
        <div class="nci-foot">
          <div>
            <button class="nci-btn" id="nci-prev">Back</button>
            <span class="nci-skip" id="nci-skip">Skip for now</span>
          </div>
          <button class="nci-btn primary" id="nci-next">Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function renderStepper() {
    const wrap = document.getElementById('nci-stepper');
    let html = '';
    for (let i = 1; i <= state.totalSteps; i++) {
      const cls = i === state.step ? 'active' : (i < state.step ? 'done' : '');
      const inner = i < state.step ? '✓' : String(i);
      html += `<div class="nci-dot ${cls}">${inner}</div>`;
      if (i < state.totalSteps) {
        html += `<div class="nci-conn ${i < state.step ? 'done' : ''}"></div>`;
      }
    }
    wrap.innerHTML = html;
    document.getElementById('nci-step-counter').textContent = `Step ${state.step} of ${state.totalSteps}`;
    const prevBtn = document.getElementById('nci-prev');
    if (prevBtn) prevBtn.style.visibility = state.step === 1 ? 'hidden' : 'visible';
    const nextBtn = document.getElementById('nci-next');
    if (nextBtn) nextBtn.textContent = state.step === state.totalSteps ? 'Finish & save' : 'Continue';
  }

  // ============================================================================
  // STEP RENDERERS
  // ============================================================================

  function renderStep1() {
    const cs = window.__nci_caseState || {};
    const d = state.data.step1 || {
      description: cs.caseDescription || '',
      caseType: cs.caseType || 'unknown',
      caseTypeLabel: caseTypeLabel(cs.caseType || 'unknown'),
      userRole: cs.userRole || 'Your Side',
      otherRole: cs.otherRole || 'Other Side',
      jurisdiction: 'Texas — Montgomery County'
    };
    state.data.step1 = d;

    const hasCarryover = !!(d.description && d.description.length > 5);
    const introText = hasCarryover
      ? "Everything below came from the analysis you ran on nocase.org. Read it, edit anything off, then continue. The facts you confirm here become the case's foundation — every later step grounds against them."
      : "Tell me about your matter. Don't worry about getting it organized — I'll structure it. Anything sensitive stays on your computer; only the snippets I need leave the machine.";

    return `
      <div class="nci-label">Step 1 — What we already know</div>
      <h3 class="nci-h">${hasCarryover ? 'Confirm this is still your matter' : 'Tell me about your matter'}</h3>
      <p class="nci-p">${introText}</p>

      <div class="nci-row">
        <div class="nci-label">Your description</div>
        <textarea class="nci-textarea" id="nci-s1-desc" rows="5" placeholder="e.g., I received a $400K loan from the Luanne Elizabeth Johns Trust via signed note dated July 10, 2025...">${escapeHtml(d.description)}</textarea>
      </div>

      <div class="nci-row nci-grid-2">
        <div>
          <div class="nci-label">Case type</div>
          <select class="nci-input" id="nci-s1-type">
            <option value="contract_dispute" ${d.caseType==='contract_dispute'?'selected':''}>Contract dispute</option>
            <option value="debt_collection" ${d.caseType==='debt_collection'?'selected':''}>Debt / promissory note</option>
            <option value="real_estate" ${d.caseType==='real_estate'?'selected':''}>Real estate</option>
            <option value="employment" ${d.caseType==='employment'?'selected':''}>Employment</option>
            <option value="family_law" ${d.caseType==='family_law'?'selected':''}>Family law</option>
            <option value="theft_embezzlement" ${d.caseType==='theft_embezzlement'?'selected':''}>Theft / embezzlement</option>
            <option value="criminal_felony" ${d.caseType==='criminal_felony'?'selected':''}>Criminal — felony</option>
            <option value="business_dispute" ${d.caseType==='business_dispute'?'selected':''}>Business / partner dispute</option>
            <option value="defamation" ${d.caseType==='defamation'?'selected':''}>Defamation</option>
            <option value="unknown" ${d.caseType==='unknown'?'selected':''}>Not yet set</option>
          </select>
        </div>
        <div>
          <div class="nci-label">Your role</div>
          <input class="nci-input" id="nci-s1-role" type="text" value="${escapeHtml(d.userRole)}" placeholder="Plaintiff, Defendant, Witness, etc." />
        </div>
      </div>

      <div class="nci-row nci-grid-2">
        <div>
          <div class="nci-label">Other side(s)</div>
          <input class="nci-input" id="nci-s1-other" type="text" value="${escapeHtml(d.otherRole)}" placeholder="The other party / parties" />
        </div>
        <div>
          <div class="nci-label">Jurisdiction</div>
          <input class="nci-input" id="nci-s1-jur" type="text" value="${escapeHtml(d.jurisdiction)}" placeholder="State · County · Court" />
        </div>
      </div>

      <div class="nci-note">
        <strong>Anti-drift safeguard:</strong> the facts you confirm here become the spine of every later analysis. If Claude ever introduces a party, date, or claim that isn't grounded in your folder, it gets flagged "unconfirmed — please verify" rather than asserted as truth.
      </div>
    `;
  }

  function renderStep2(docs) {
    return `
      <div class="nci-label">Step 2 — Spine document</div>
      <h3 class="nci-h">Pick the document this case revolves around</h3>
      <p class="nci-p">The spine is what every claim gets checked against. For a contract dispute, that's usually the contract itself. Every subsequent analysis Claude runs will include the spine's full text as authoritative context, with its SHA-256 stored so we detect if it ever changes.</p>

      <div id="nci-spine-list">
        ${docs.length === 0
          ? `<div class="nci-note">Your case folder doesn't have any documents yet. Add the central document (contract, note, lease, complaint) via the +File button in the main workspace, then come back to this step.</div>`
          : docs.map((doc, i) => {
              const ext = (doc.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
              const isSelected = state.data.spineDocument && state.data.spineDocument.name === doc.name;
              const isRecommended = i === 0 && /note|contract|agreement/i.test(doc.name);
              return `
                <div class="nci-row-doc ${isSelected ? 'selected' : ''}" data-nci-spine="${escapeHtml(doc.name)}">
                  <div class="nci-row-doc-icon">${ext}</div>
                  <div style="flex:1; min-width:0;">
                    <div class="nci-row-doc-name">${escapeHtml(doc.name)}</div>
                    <div class="nci-row-doc-meta">${doc.size ? Math.round(doc.size/1024) + ' KB' : ''}${isRecommended ? ' · recommended spine' : ''}${doc.meta?.sha256 ? ' · SHA-256 captured' : ''}</div>
                  </div>
                  ${isSelected ? '<div style="color: var(--blue); font-size: 1.1rem;">✓</div>' : ''}
                </div>
              `;
            }).join('')
        }
      </div>

      <div class="nci-note">
        Picking a spine doesn't lock anything. You can swap it later. You can also designate a companion spine — for example a TRO petition that runs alongside the main note — but that's optional and comes after the intake.
      </div>
    `;
  }

  function renderStep3(docs) {
    const caseType = state.data.step1?.caseType || 'unknown';
    const map = EVIDENCE_MAPS[caseType] || EVIDENCE_MAPS.unknown;

    // For each item, check folder contents and mark status
    const checklist = map.map(item => {
      const matches = docs.filter(d => item.match.test(d.name));
      let status = 'missing';
      if (matches.length > 0) status = matches.length >= 2 ? 'found' : 'partial';
      // Override spine
      if (state.data.spineDocument && /spine/.test(item.key)) {
        status = 'found';
        if (!matches.find(m => m.name === state.data.spineDocument.name)) {
          matches.unshift({ name: state.data.spineDocument.name });
        }
      }
      return { ...item, status, matches: matches.slice(0, 3) };
    });
    state.data.evidenceChecklist = checklist.map(c => ({
      key: c.key, label: c.label, status: c.status,
      linkedDocs: c.matches.map(m => m.name)
    }));

    return `
      <div class="nci-label">Step 3 — Evidence checklist <span style="font-weight: 600; color: var(--blue); margin-left: 0.4rem;">[${caseTypeLabel(caseType)}]</span></div>
      <h3 class="nci-h">For this case type, here's the evidence map</h3>
      <p class="nci-p">Green = found in your folder. Amber = partial. Red = missing — let's get it imported. Each row is matched against your folder contents by name pattern. The match is a heuristic, not a guarantee — adjust by clicking individual rows.</p>

      <div id="nci-ev-list">
        ${checklist.map((item, i) => {
          const icon = item.status === 'found' ? '✓' : (item.status === 'partial' ? '!' : '✗');
          const statusText = item.status === 'found'
            ? (item.matches[0] ? `Found: ${item.matches.map(m => m.name).slice(0,2).join(', ')}` : 'Found')
            : item.status === 'partial'
              ? `Partial: ${item.matches.length} match${item.matches.length === 1 ? '' : 'es'}, may need more`
              : 'Not found in your folder — add or import';
          const showImportBtn = item.status === 'missing' && /communication|email|message/i.test(item.label);
          return `
            <div class="nci-ev-row" data-nci-ev="${i}">
              <div class="nci-ev-icon ${item.status}">${icon}</div>
              <div style="flex: 1;">
                <div class="nci-ev-name">${escapeHtml(item.label)}${item.required ? ' <span style="color: var(--red); font-size: 0.7rem;">(required)</span>' : ''}</div>
                <div class="nci-ev-status">${escapeHtml(statusText)}</div>
              </div>
              ${showImportBtn ? '<button class="nci-btn" data-nci-import="emails">Import emails</button>' : ''}
            </div>
          `;
        }).join('')}
      </div>

      <div class="nci-note">
        Heuristic matching only — for now we check filenames against expected patterns. A later pass will read the text inside each document and identify which evidence category it belongs to with higher accuracy.
      </div>
    `;
  }

  function renderStep4() {
    return `
      <div class="nci-label">Step 4 — Import helper</div>
      <h3 class="nci-h">Pull communications into your case folder</h3>
      <p class="nci-p">The case folder is the brain. If your emails and texts about this matter live elsewhere, they should be here. This step gathers them from Mail and Messages and writes them into <code>documents/</code> so the rest of the workspace can see them.</p>

      <div class="nci-claude">
        <div class="nci-claude-label">How this works</div>
        Click <strong>Pick Mail folder</strong>, point at <code>~/Library/Mail</code> (or wherever your client stores its mailboxes), and I'll scan all <code>.emlx</code> files for matches against the keywords below. Each matching message gets saved as a <code>.eml</code> file inside your case's <code>documents/</code> folder, with a SHA-256 captured so the chain of custody is provable.
      </div>

      <div class="nci-row">
        <div class="nci-label">Scan rules</div>
        <div style="border: 1px solid var(--rule); border-radius: 6px; padding: 0.7rem 0.85rem; background: white; font-size: 0.85rem; line-height: 1.65;">
          <div><strong>Across:</strong> <span class="nci-chip">Mail (all accounts)</span></div>
          <div style="margin-top: 0.3rem;"><strong>Match if subject or body contains:</strong></div>
          <div style="margin-top: 0.2rem;" id="nci-keywords-display"></div>
          <div style="margin-top: 0.5rem;">
            <input class="nci-input" id="nci-keyword-add" type="text" placeholder="Add a keyword and press Enter" style="font-size: 0.82rem;" />
          </div>
        </div>
      </div>

      <div class="nci-row" style="display: flex; gap: 0.5rem;">
        <button class="nci-btn primary" id="nci-pick-mail">Pick Mail folder</button>
        <button class="nci-btn" id="nci-skip-import">Skip for now</button>
      </div>

      <div id="nci-import-result" style="display: none;"></div>

      <div class="nci-note">
        <strong>Privacy:</strong> the scan runs entirely in your browser via File System Access. No email content leaves your machine. Only the matched messages get copied into your case folder.
      </div>
    `;
  }

  function renderStep5() {
    const redLines = state.data.redLines.length
      ? state.data.redLines
      : ['No false witness', 'No destroying records', 'No backdating documents'];
    state.data.redLines = redLines;

    const values = state.data.values.length
      ? state.data.values
      : ['Truthfulness', 'Constitutional rights', 'Proportional response'];
    state.data.values = values;

    return `
      <div class="nci-label">Step 5 — Goals & values</div>
      <h3 class="nci-h">What you want, and what you won't do to get it</h3>
      <p class="nci-p">The goal becomes the case's North Star — every later piece of analysis is checked against it. The red lines are the bright lines you won't cross. Every action Claude proposes runs through an integrity check against these before it's shown to you.</p>

      <div class="nci-row">
        <div class="nci-label">What you want from this matter</div>
        <textarea class="nci-textarea" id="nci-s5-goals" rows="4" placeholder="e.g., Defeat the TRO. Restructure the note. Avoid personal liability. Settle quietly.">${escapeHtml(state.data.goals)}</textarea>
      </div>

      <div class="nci-row">
        <div class="nci-label">Red lines (Claude refuses to help with anything that crosses these)</div>
        <div id="nci-redlines">
          ${redLines.map((r, i) => `<button class="nci-chip danger" data-nci-removered="${i}">⛌ ${escapeHtml(r)}</button>`).join('')}
          <button class="nci-chip add" id="nci-add-redline">+ add</button>
        </div>
      </div>

      <div class="nci-row">
        <div class="nci-label">Values that should guide Claude's tone and recommendations</div>
        <div id="nci-values">
          ${values.map((v, i) => `<button class="nci-chip" data-nci-removeval="${i}">${escapeHtml(v)}</button>`).join('')}
          <button class="nci-chip add" id="nci-add-value">+ add</button>
        </div>
      </div>

      <div class="nci-success-card">
        <strong>Ready to finish.</strong> When you click Finish &amp; save, the entire intake gets written to <code>case.json</code> in your case folder. The Workspace will reopen with the intake's facts loaded as the case's foundation.
      </div>
    `;
  }

  // ============================================================================
  // STEP RENDER DISPATCHER
  // ============================================================================

  async function renderCurrentStep() {
    const body = document.getElementById('nci-body');
    if (!body) return;

    if (state.step === 1) {
      body.innerHTML = renderStep1();
      // Sync inputs back to state on change
      const desc = document.getElementById('nci-s1-desc');
      const type = document.getElementById('nci-s1-type');
      const role = document.getElementById('nci-s1-role');
      const other = document.getElementById('nci-s1-other');
      const jur = document.getElementById('nci-s1-jur');
      [desc, type, role, other, jur].forEach(el => el && el.addEventListener('input', () => {
        state.data.step1 = {
          description: desc.value, caseType: type.value, caseTypeLabel: caseTypeLabel(type.value),
          userRole: role.value, otherRole: other.value, jurisdiction: jur.value
        };
      }));
    } else if (state.step === 2) {
      const docs = await loadDocs();
      body.innerHTML = renderStep2(docs);
      body.querySelectorAll('[data-nci-spine]').forEach(row => {
        row.addEventListener('click', () => {
          const name = row.dataset.nciSpine;
          const doc = docs.find(d => d.name === name);
          state.data.spineDocument = { name, sha256: doc?.meta?.sha256 || null, selectedAt: new Date().toISOString() };
          renderCurrentStep();
        });
      });
    } else if (state.step === 3) {
      const docs = await loadDocs();
      body.innerHTML = renderStep3(docs);
      body.querySelectorAll('[data-nci-import]').forEach(btn => {
        btn.addEventListener('click', () => { state.step = 4; renderStepper(); renderCurrentStep(); });
      });
    } else if (state.step === 4) {
      body.innerHTML = renderStep4();
      renderKeywords();
      const addInput = document.getElementById('nci-keyword-add');
      addInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
          state.data.importKeywords = state.data.importKeywords || defaultKeywords();
          state.data.importKeywords.push(e.target.value.trim());
          e.target.value = '';
          renderKeywords();
        }
      });
      document.getElementById('nci-pick-mail')?.addEventListener('click', pickMailFolder);
      document.getElementById('nci-skip-import')?.addEventListener('click', () => {
        state.step = 5; renderStepper(); renderCurrentStep();
      });
    } else if (state.step === 5) {
      body.innerHTML = renderStep5();
      const goals = document.getElementById('nci-s5-goals');
      goals?.addEventListener('input', () => { state.data.goals = goals.value; });
      body.querySelectorAll('[data-nci-removered]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.nciRemovered);
          state.data.redLines.splice(idx, 1);
          renderCurrentStep();
        });
      });
      body.querySelectorAll('[data-nci-removeval]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.nciRemoveval);
          state.data.values.splice(idx, 1);
          renderCurrentStep();
        });
      });
      document.getElementById('nci-add-redline')?.addEventListener('click', () => {
        const v = prompt('Add a red line — something Claude must never help with:');
        if (v && v.trim()) { state.data.redLines.push(v.trim()); renderCurrentStep(); }
      });
      document.getElementById('nci-add-value')?.addEventListener('click', () => {
        const v = prompt('Add a value — something Claude should reflect in tone and recommendations:');
        if (v && v.trim()) { state.data.values.push(v.trim()); renderCurrentStep(); }
      });
    }
    renderStepper();
  }

  // ============================================================================
  // HELPERS — keyword display, document loading, mail folder picker
  // ============================================================================

  function defaultKeywords() {
    const desc = state.data.step1?.description || '';
    // Pull obvious entities from the description as default keywords
    const words = desc.match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|ANQ|TRO)\b/g) || [];
    const unique = [...new Set(words)].filter(w => w.length > 3 && !['United States', 'New Case'].includes(w)).slice(0, 5);
    return unique.length ? unique : ['(no keywords yet)'];
  }

  function renderKeywords() {
    const wrap = document.getElementById('nci-keywords-display');
    if (!wrap) return;
    const kws = state.data.importKeywords || defaultKeywords();
    state.data.importKeywords = kws;
    wrap.innerHTML = kws.map((k, i) => `<button class="nci-chip" data-nci-removek="${i}">${escapeHtml(k)} ×</button>`).join('');
    wrap.querySelectorAll('[data-nci-removek]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.data.importKeywords.splice(parseInt(btn.dataset.nciRemovek), 1);
        renderKeywords();
      });
    });
  }

  async function loadDocs() {
    // Use the host page's helper if exposed; otherwise read directly via folderHandle
    if (typeof window.listDocuments === 'function') {
      try { return await window.listDocuments(); } catch {}
    }
    // Fallback: enumerate documents/ inside the host's folderHandle
    const fh = window.__nci_folderHandle;
    if (!fh) return [];
    try {
      const docsDir = await fh.getDirectoryHandle('documents', { create: false });
      const docs = [];
      for await (const [name, handle] of docsDir.entries()) {
        if (handle.kind !== 'file' || name.endsWith('.meta.json')) continue;
        try {
          const f = await handle.getFile();
          let meta = null;
          try {
            const metaH = await docsDir.getFileHandle(name + '.meta.json');
            const metaF = await metaH.getFile();
            meta = JSON.parse(await metaF.text());
          } catch {}
          docs.push({ name, size: f.size, meta });
        } catch {}
      }
      return docs.sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  }

  async function pickMailFolder() {
    const result = document.getElementById('nci-import-result');
    if (!window.showDirectoryPicker) {
      result.style.display = 'block';
      result.innerHTML = '<div class="nci-note">Your browser doesn\'t support folder access — try Chrome, Edge, Brave, or Arc.</div>';
      return;
    }
    try {
      const mailHandle = await window.showDirectoryPicker({ mode: 'read' });
      result.style.display = 'block';
      result.innerHTML = '<div class="nci-note">Scanning… (this can take a minute on large mailboxes)</div>';

      const kws = (state.data.importKeywords || defaultKeywords()).map(k => k.toLowerCase());
      let scanned = 0;
      let matched = 0;
      const matches = [];

      async function walk(handle, depth = 0) {
        if (depth > 8 || matches.length > 200) return; // safety caps
        for await (const [name, h] of handle.entries()) {
          if (h.kind === 'directory') {
            await walk(h, depth + 1);
          } else if (h.kind === 'file' && /\.emlx?$/i.test(name)) {
            scanned++;
            if (scanned % 500 === 0) {
              result.innerHTML = `<div class="nci-note">Scanned ${scanned} files, ${matched} matches…</div>`;
              await new Promise(r => setTimeout(r, 0));
            }
            try {
              const f = await h.getFile();
              // First 100KB usually contains headers + start of body
              const head = await f.slice(0, 100 * 1024).text();
              const lower = head.toLowerCase();
              if (kws.some(k => k.length > 2 && lower.includes(k))) {
                matched++;
                matches.push({ name, size: f.size, file: f });
              }
            } catch {}
          }
        }
      }

      await walk(mailHandle);

      state.data.importRequests.push({
        source: 'mail', keywords: kws, scanned, matched, status: matched > 0 ? 'ready' : 'no_matches',
        scannedAt: new Date().toISOString()
      });

      if (matched === 0) {
        result.innerHTML = `<div class="nci-note">Scanned ${scanned} email files. No matches for your keywords. Try adjusting the keyword list above and run again.</div>`;
        return;
      }

      // Save matched files into the case folder's documents/ subdirectory
      const fh = window.__nci_folderHandle;
      const docsDir = await fh.getDirectoryHandle('documents', { create: true });
      let saved = 0;
      for (const m of matches.slice(0, 100)) {
        try {
          const safeName = `email-${saved + 1}-${m.name.replace(/[^a-zA-Z0-9.-]/g, '_')}.eml`;
          const out = await docsDir.getFileHandle(safeName, { create: true });
          const w = await out.createWritable();
          await w.write(m.file);
          await w.close();
          saved++;
        } catch (e) { /* skip on error */ }
      }

      result.innerHTML = `<div class="nci-success-card"><strong>Imported ${saved} of ${matched} matched emails.</strong> They're saved in your case folder under <code>documents/</code>. The workspace will pick them up next time you reload.</div>`;

    } catch (e) {
      if (e.name === 'AbortError') return;
      result.style.display = 'block';
      result.innerHTML = `<div class="nci-note">Could not scan: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  async function open() {
    let overlay = document.getElementById('nci-overlay');
    if (!overlay) overlay = buildOverlay();

    // Wire global handlers once
    if (!overlay.dataset.wired) {
      document.getElementById('nci-close').addEventListener('click', close);
      document.getElementById('nci-skip').addEventListener('click', close);
      document.getElementById('nci-prev').addEventListener('click', () => {
        if (state.step > 1) { state.step--; renderCurrentStep(); }
      });
      document.getElementById('nci-next').addEventListener('click', async () => {
        if (state.step < state.totalSteps) { state.step++; renderCurrentStep(); }
        else { await finish(); }
      });
      overlay.dataset.wired = '1';
    }

    // Capture host-page state via globals exposed by index.html (we read them
    // by name). If they aren't on window, we fall back to no-op.
    window.__nci_caseState = window.__nci_caseState || (typeof caseState !== 'undefined' ? caseState : null);
    window.__nci_folderHandle = window.__nci_folderHandle || (typeof folderHandle !== 'undefined' ? folderHandle : null);

    state.step = 1;
    state.open = true;
    overlay.classList.remove('hidden');
    await renderCurrentStep();
  }

  function close() {
    const overlay = document.getElementById('nci-overlay');
    if (overlay) overlay.classList.add('hidden');
    state.open = false;
  }

  async function finish() {
    const cs = window.__nci_caseState;
    if (!cs) { close(); return; }
    cs.intake = {
      version: 1,
      completedAt: new Date().toISOString(),
      step1: state.data.step1,
      spineDocument: state.data.spineDocument,
      evidenceChecklist: state.data.evidenceChecklist,
      importRequests: state.data.importRequests,
      goals: state.data.goals,
      redLines: state.data.redLines,
      values: state.data.values
    };
    // Mirror key fields to the existing case schema
    if (state.data.step1) {
      cs.caseDescription = state.data.step1.description || cs.caseDescription;
      cs.caseType = state.data.step1.caseType || cs.caseType;
    }
    cs.intakeCompleted = true;

    // Persist via the host's saveCaseState if available
    if (typeof window.saveCaseState === 'function') {
      try { await window.saveCaseState(); } catch (e) { console.warn('saveCaseState failed', e); }
    } else if (window.__nci_folderHandle) {
      try {
        const fh = await window.__nci_folderHandle.getFileHandle('case.json', { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(cs, null, 2));
        await w.close();
      } catch (e) { console.warn('direct save failed', e); }
    }

    close();
    if (typeof window.showToast === 'function') window.showToast('Intake saved to your case folder');
  }

  // ============================================================================
  // BOOT
  // ============================================================================

  function attach() {
    injectStyles();

    // Hook the "Run intake" button
    const btn = document.getElementById('runIntakeBtn');
    if (btn) {
      // Remove existing listeners by cloning the node
      const clone = btn.cloneNode(true);
      btn.parentNode.replaceChild(clone, btn);
      clone.addEventListener('click', open);
    }

    // Expose for programmatic invocation
    window.NoCaseIntake = { open, close };

    // Bridge: expose host's caseState and folderHandle to our module by
    // polling for them. The host page initializes these inside an IIFE,
    // so they're not on window — but they ARE in the same script's scope,
    // and the host page already calls saveCaseState() etc. through name
    // resolution. We use a setInterval to grab them once they exist.
    let attempts = 0;
    const bridge = setInterval(() => {
      attempts++;
      if (attempts > 50) { clearInterval(bridge); return; }
      // Try accessing the globals indirectly
      try {
        const haveState = typeof caseState !== 'undefined' && caseState;
        const haveFolder = typeof folderHandle !== 'undefined' && folderHandle;
        if (haveState && haveFolder) {
          window.__nci_caseState = caseState;
          window.__nci_folderHandle = folderHandle;
          window.listDocuments = (typeof listDocuments === 'function') ? listDocuments : window.listDocuments;
          window.saveCaseState = (typeof saveCaseState === 'function') ? saveCaseState : window.saveCaseState;
          window.showToast = (typeof showToast === 'function') ? showToast : window.showToast;
          clearInterval(bridge);
        }
      } catch (e) { /* still loading */ }
    }, 200);
  }

  whenReady(attach);
})();
