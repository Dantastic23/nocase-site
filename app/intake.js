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

  // ============================================================================
  // OS / CLIENT DETECTION
  // ============================================================================

  function detectOS() {
    const ua = navigator.userAgent;
    const plat = navigator.platform || '';
    if (/Mac/i.test(plat) || /Mac OS X/i.test(ua)) return 'mac';
    if (/Win/i.test(plat) || /Windows/i.test(ua)) return 'win';
    if (/Linux/i.test(plat) || /Linux/i.test(ua)) return 'linux';
    return 'other';
  }

  // Provider instruction templates — keyed by provider id
  function providerInstruction(id) {
    const tpl = {
      'apple-mail': {
        title: 'Apple Mail on macOS',
        body: 'I can scan your local Mail directly. Click the button, point at <code>~/Library/Mail</code> (you may need to show hidden folders with Cmd+Shift+.), and I\'ll save matching .eml files into your case folder.',
        action: 'Pick Mail folder and scan',
        auto: true
      },
      'gmail': {
        title: 'Gmail (web)',
        body: 'Gmail web doesn\'t have local files. Export via Google Takeout:<ol><li>Open <a href="https://takeout.google.com" target="_blank">takeout.google.com</a></li><li>Deselect All, then check only Mail</li><li>Choose .mbox format, export</li><li>Google emails you when the archive is ready (can take minutes to hours)</li><li>Download the .mbox file</li><li>Drag the .mbox into the drop zone below</li></ol>',
        action: null
      },
      'outlook': {
        title: 'Outlook',
        body: 'Export from Outlook:<ol><li>File → Open &amp; Export → Import/Export</li><li>Export to a file → Next</li><li>Outlook Data File (.pst) → Next</li><li>Pick the folder containing case emails</li><li>Save the .pst file</li><li>Drag the .pst into the drop zone below</li></ol>',
        action: null
      },
      'other-email': {
        title: 'Other email client',
        body: 'Drag any email export file (.eml, .mbox, .pst, .msg) into the drop zone at the bottom of this page.',
        action: null
      },
      'imessage': {
        title: 'iMessage on Mac / iPhone',
        body: 'macOS blocks browsers from reading the iMessage database directly. Two paths:<ol><li><strong>Per-thread (easy)</strong>: open Messages.app, find the conversation, File → Print → Save as PDF → drop the PDF into the drop zone below.</li><li><strong>Full database (technical)</strong>: install <code>imessage-exporter</code> (Mac terminal tool), export to JSON or HTML, drop the result.</li></ol>',
        action: null
      },
      'whatsapp': {
        title: 'WhatsApp',
        body: 'On your phone: open the relevant chat → ⋮ menu → More → Export Chat → Without Media → email it to yourself or save to Files → download to your computer → drop the .zip or .txt here.',
        action: null
      },
      'signal': {
        title: 'Signal',
        body: 'Signal doesn\'t export individual chats easily. Best paths:<ol><li>Screenshot the key messages, save as image files, drop them here.</li><li>Signal Desktop → File → Create signal backup → drop the .bak (only useful if you have a Signal-compatible reader).</li></ol>',
        action: null
      },
      'sms': {
        title: 'SMS (Android)',
        body: 'Install <strong>SMS Backup &amp; Restore</strong> from the Play Store → back up SMS to XML or JSON → transfer the file to your computer → drop here.',
        action: null
      },
      'other-text': {
        title: 'Other messaging app',
        body: 'If your app has an export feature, run it and drop the result in the drop zone below. Otherwise screenshot the relevant conversations and drop the images.',
        action: null
      }
    };
    return tpl[id];
  }

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
    .nci-row-doc { display: flex; align-items: center; gap: 0.7rem; padding: 0.65rem 0.85rem; border: 1px solid var(--rule); border-radius: 6px; margin-bottom: 0.45rem; cursor: pointer; background: white; transition: border-color 0.15s, background 0.15s, box-shadow 0.15s; }
    .nci-row-doc:hover { border-color: var(--blue); background: rgba(26,79,214,0.04); box-shadow: 0 1px 4px rgba(26,79,214,0.08); }
    .nci-row-doc.selected { border: 1.5px solid var(--blue); background: var(--blue-light); }
    .nci-radio-circle { width: 18px; height: 18px; border: 1.5px solid var(--ink-muted); border-radius: 50%; flex-shrink: 0; background: white; position: relative; transition: border-color 0.15s, background 0.15s; }
    .nci-row-doc:hover .nci-radio-circle { border-color: var(--blue); }
    .nci-radio-circle.checked { border-color: var(--blue); background: var(--blue); }
    .nci-radio-circle.checked::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 7px; height: 7px; background: white; border-radius: 50%; }
    .nci-section-card { background: white; border: 1px solid var(--rule); border-radius: 8px; padding: 1rem 1.1rem; margin-bottom: 0.9rem; }
    .nci-section-title { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 1rem; margin-bottom: 0.45rem; color: var(--ink); display: flex; align-items: center; gap: 0.4rem; }
    .nci-section-sub { font-size: 0.82rem; color: var(--ink-soft); margin: 0 0 0.7rem; line-height: 1.5; }
    .nci-folder-status { display: flex; align-items: center; justify-content: space-between; padding: 0.55rem 0.75rem; background: var(--green-light); border: 1px solid #c4e6d3; border-radius: 6px; font-size: 0.85rem; color: var(--ink); margin-bottom: 0.7rem; }
    .nci-protections { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 0.85rem; font-size: 0.78rem; color: var(--ink-soft); line-height: 1.5; padding: 0.65rem 0.8rem; background: var(--paper-dark); border-radius: 5px; margin-top: 0.55rem; }
    .nci-protections strong { color: var(--ink); }
    .nci-provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.5rem; margin-bottom: 0.7rem; }
    .nci-provider-card { background: white; border: 1px solid var(--rule); border-radius: 6px; padding: 0.6rem 0.7rem; cursor: pointer; text-align: left; font-family: inherit; transition: border-color 0.15s, background 0.15s; display: flex; flex-direction: column; gap: 0.15rem; }
    .nci-provider-card:hover { border-color: var(--blue); background: rgba(26,79,214,0.04); }
    .nci-provider-card.selected { border: 1.5px solid var(--blue); background: var(--blue-light); }
    .nci-provider-card strong { font-size: 0.85rem; font-weight: 600; color: var(--ink); }
    .nci-provider-card span { font-size: 0.72rem; color: var(--ink-muted); }
    .nci-instruction-card { background: var(--paper-dark); border: 1px solid var(--rule); border-radius: 6px; padding: 0.8rem 0.95rem; margin-top: 0.5rem; font-size: 0.82rem; line-height: 1.55; }
    .nci-instruction-card strong { color: var(--ink); }
    .nci-instruction-card ol { padding-left: 1.4rem; margin: 0.4rem 0; }
    .nci-instruction-card ol li { margin: 0.2rem 0; }
    .nci-instruction-card code { font-family: 'SF Mono', monospace; font-size: 0.78rem; background: white; padding: 0.05rem 0.3rem; border-radius: 3px; border: 1px solid var(--rule); }
    .nci-instruction-card a { color: var(--blue); }
    .nci-drop-zone { border: 2px dashed var(--rule); border-radius: 8px; padding: 1.3rem 1rem; text-align: center; cursor: pointer; transition: border-color 0.15s, background 0.15s; display: flex; flex-direction: column; gap: 0.25rem; align-items: center; background: white; }
    .nci-drop-zone:hover, .nci-drop-zone.drag-over { border-color: var(--blue); background: var(--blue-light); }
    .nci-drop-zone strong { font-size: 0.9rem; color: var(--ink); }
    .nci-drop-zone span { font-size: 0.78rem; color: var(--ink-muted); }
    .nci-import-result { font-size: 0.78rem; color: var(--ink-soft); margin-top: 0.55rem; padding: 0.5rem 0.7rem; background: var(--paper-dark); border-radius: 5px; }
    .nci-import-result.ok { background: var(--green-light); color: var(--green); }
    .nci-import-result.err { background: var(--red-light); color: var(--red); }
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

  // ============================================================================
  // STEP 2 — Folder + protections + OS-aware import
  // ============================================================================

  function renderStep2() {
    const os = detectOS();
    const fh = window.__nci_folderHandle;
    const folderName = fh?.name || null;

    return `
      <div class="nci-label">Step 2 — Your case folder</div>
      <h3 class="nci-h">Set up the folder, then gather everything into it</h3>
      <p class="nci-p">Everything about this matter lives here. Pick or create the folder, learn what's protected, then walk through getting your emails, texts, and documents in. You only do this once.</p>

      <div class="nci-section-card">
        <div class="nci-section-title">1. Pick or create your case folder</div>
        ${folderName
          ? `<div class="nci-folder-status">
              <span><i class="ti ti-folder" aria-hidden="true"></i> Linked: <strong>${escapeHtml(folderName)}</strong></span>
              <button class="nci-btn" id="nci-change-folder">Change folder</button>
            </div>`
          : `<button class="nci-btn primary" id="nci-pick-folder">Pick or create a folder</button>
             <p class="nci-section-sub" style="margin: 0.55rem 0 0;">The OS dialog has a "New Folder" button — use it if you don't have a case folder yet. We recommend creating <code>~/Documents/NoCase/&lt;case name&gt;</code>.</p>`
        }
        <div class="nci-protections">
          <div><strong>Files stay local.</strong> Nothing uploads unless you choose to attach something to a Claude turn.</div>
          <div><strong>Snippets only leave.</strong> The chat sends short excerpts, not whole files.</div>
          <div><strong>SHA-256 stamped.</strong> Every file gets a hash so the chain of custody is provable.</div>
          <div><strong>Delete = gone.</strong> Wipe the folder and the case is gone — we have nothing.</div>
        </div>
      </div>

      <div class="nci-section-card">
        <div class="nci-section-title">2. Import your emails about this matter</div>
        <p class="nci-section-sub">Pick how you read email. Each option shows what to do.${os === 'mac' ? ' Apple Mail can be scanned in-place; others need an export first.' : ''}</p>
        <div class="nci-provider-grid">
          ${os === 'mac' ? `
            <button class="nci-provider-card" data-nci-email="apple-mail">
              <strong>Apple Mail</strong>
              <span>Auto-scan ~/Library/Mail</span>
            </button>` : ''}
          <button class="nci-provider-card" data-nci-email="gmail">
            <strong>Gmail (web)</strong>
            <span>Google Takeout, then drop</span>
          </button>
          <button class="nci-provider-card" data-nci-email="outlook">
            <strong>Outlook</strong>
            <span>Export PST, then drop</span>
          </button>
          <button class="nci-provider-card" data-nci-email="other-email">
            <strong>Other / multiple</strong>
            <span>Drag and drop</span>
          </button>
        </div>
        <div id="nci-email-instructions"></div>
      </div>

      <div class="nci-section-card">
        <div class="nci-section-title">3. Import your texts about this matter</div>
        <p class="nci-section-sub">Same idea for messaging apps.</p>
        <div class="nci-provider-grid">
          ${os === 'mac' ? `
            <button class="nci-provider-card" data-nci-text="imessage">
              <strong>iMessage</strong>
              <span>Mac / iPhone — PDF export</span>
            </button>` : ''}
          <button class="nci-provider-card" data-nci-text="whatsapp">
            <strong>WhatsApp</strong>
            <span>Export Chat → drop</span>
          </button>
          <button class="nci-provider-card" data-nci-text="signal">
            <strong>Signal</strong>
            <span>Screenshots or backup</span>
          </button>
          <button class="nci-provider-card" data-nci-text="sms">
            <strong>SMS (Android)</strong>
            <span>SMS Backup &amp; Restore</span>
          </button>
          <button class="nci-provider-card" data-nci-text="other-text">
            <strong>Other / multiple</strong>
            <span>Drag and drop</span>
          </button>
        </div>
        <div id="nci-text-instructions"></div>
      </div>

      <div class="nci-section-card">
        <div class="nci-section-title">4. Drop everything else here</div>
        <p class="nci-section-sub">Contracts, photos, PDFs, scans, exports from any of the steps above — anything goes here. All files write straight to your case folder's <code>documents/</code> subdirectory.</p>
        <div class="nci-drop-zone" id="nci-loose-drop">
          <strong>Drop files here</strong>
          <span>or click to pick from Finder</span>
          <input type="file" id="nci-loose-input" multiple style="display: none;" />
        </div>
        <div id="nci-loose-result"></div>
      </div>

      <p class="nci-section-sub" style="margin-top: 0.5rem; text-align: center;">When the folder has what you need, hit Continue. The next step is picking the spine document — the single document this case revolves around.</p>
    `;
  }

  // ============================================================================
  // STEP 3 — Spine document (was Step 2)
  // ============================================================================

  function renderStep3Spine(docs) {
    // Find the best-recommended spine across the WHOLE folder, not just the first doc.
    // Priority: filenames mentioning "note" or "contract" or "agreement" win.
    const recommendedName = (() => {
      const score = d => (/note/i.test(d.name) ? 3 : 0) + (/contract/i.test(d.name) ? 3 : 0) + (/agreement/i.test(d.name) ? 2 : 0) + (/signed/i.test(d.name) ? 2 : 0);
      const ranked = [...docs].map(d => ({ d, s: score(d) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
      return ranked.length ? ranked[0].d.name : null;
    })();

    const selectedName = state.data.spineDocument?.name || null;
    const selectedBanner = selectedName
      ? `<div class="nci-success-card" style="margin: 0 0 1rem;"><strong>Selected as spine:</strong> ${escapeHtml(selectedName)}. Click any other document below to switch, or continue to step 3.</div>`
      : `<div class="nci-claude" style="margin: 0 0 1rem;"><div class="nci-claude-label">How this step works</div>Click any document below to mark it as your case's spine. If the document isn't here yet, use <strong>+ Upload spine document</strong> to add it now without leaving the intake.</div>`;

    return `
      <div class="nci-label">Step 2 — Spine document</div>
      <h3 class="nci-h">Pick the document this case revolves around</h3>
      <p class="nci-p">The spine is what every claim gets checked against. For a contract dispute, that's usually the contract itself. Every subsequent analysis Claude runs will include the spine's full text as authoritative context, with its SHA-256 stored so we detect if it ever changes.</p>

      ${selectedBanner}

      <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.85rem;">
        <button class="nci-btn primary" id="nci-spine-upload-btn"><span style="margin-right: 0.3rem;">+</span> Upload spine document</button>
        <input type="file" id="nci-spine-upload-input" style="display: none;" />
        <span style="font-size: 0.78rem; color: var(--ink-muted);">Or click an existing document below</span>
      </div>

      <div id="nci-spine-list">
        ${docs.length === 0
          ? `<div class="nci-note">Your case folder doesn't have any documents yet. Click <strong>+ Upload spine document</strong> above to add the central document (contract, note, lease, complaint).</div>`
          : docs.map((doc) => {
              const ext = (doc.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
              const isSelected = selectedName === doc.name;
              const isRecommended = recommendedName === doc.name;
              const sizeStr = doc.size ? (doc.size < 1024 * 1024 ? Math.round(doc.size / 1024) + ' KB' : (doc.size / 1024 / 1024).toFixed(1) + ' MB') : '';
              const metaParts = [];
              if (sizeStr) metaParts.push(sizeStr);
              if (isRecommended) metaParts.push('<strong style="color: var(--blue);">recommended spine</strong>');
              if (doc.meta?.sha256) metaParts.push('SHA-256 captured');
              return `
                <div class="nci-row-doc ${isSelected ? 'selected' : ''}" data-nci-spine="${escapeHtml(doc.name)}">
                  <div class="nci-radio-circle ${isSelected ? 'checked' : ''}"></div>
                  <div class="nci-row-doc-icon">${ext}</div>
                  <div style="flex:1; min-width:0;">
                    <div class="nci-row-doc-name">${escapeHtml(doc.name)}</div>
                    <div class="nci-row-doc-meta">${metaParts.join(' · ')}</div>
                  </div>
                  ${isSelected ? '<div style="color: var(--blue); font-size: 0.95rem; font-weight: 600; white-space: nowrap;">✓ Spine</div>' : ''}
                </div>
              `;
            }).join('')
        }
      </div>

      <div class="nci-note" style="margin-top: 1rem;">
        Picking a spine doesn't lock anything. You can swap it later. You can also designate a companion spine — for example a TRO petition that runs alongside the main note — but that's optional and comes after the intake.
      </div>
    `;
  }

  // ============================================================================
  // STEP 4 — Evidence checklist (was Step 3)
  // ============================================================================

  function renderStep4Evidence(docs) {
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

  // Old standalone Step 4 (mail import helper) is removed — its function now lives
  // inside the new Step 2 (folder + protections + OS-aware import).

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
      // Step 2 — Folder + protections + OS-aware import
      body.innerHTML = renderStep2();
      wireStep2();
    } else if (state.step === 3) {
      // Step 3 — Spine document picker (was Step 2 before redesign)
      const docs = await loadDocs();
      body.innerHTML = renderStep3Spine(docs);
      body.querySelectorAll('[data-nci-spine]').forEach(row => {
        row.addEventListener('click', () => {
          const name = row.dataset.nciSpine;
          const doc = docs.find(d => d.name === name);
          state.data.spineDocument = { name, sha256: doc?.meta?.sha256 || null, selectedAt: new Date().toISOString() };
          renderCurrentStep();
        });
      });
      const uploadBtn = document.getElementById('nci-spine-upload-btn');
      const uploadInput = document.getElementById('nci-spine-upload-input');
      if (uploadBtn && uploadInput) {
        uploadBtn.addEventListener('click', () => uploadInput.click());
        uploadInput.addEventListener('change', async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          await uploadSpineDoc(file);
          e.target.value = '';
          await renderCurrentStep();
        });
      }
    } else if (state.step === 4) {
      // Step 4 — Evidence checklist (was Step 3 before redesign)
      const docs = await loadDocs();
      body.innerHTML = renderStep4Evidence(docs);
      body.querySelectorAll('[data-nci-import]').forEach(btn => {
        btn.addEventListener('click', () => { state.step = 2; renderStepper(); renderCurrentStep(); });
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

  // ============================================================================
  // STEP 2 WIRING — folder pick + provider clicks + drop zone
  // ============================================================================

  function wireStep2() {
    // Folder pick / change — opens the OS directory picker
    const pickBtn = document.getElementById('nci-pick-folder');
    const changeBtn = document.getElementById('nci-change-folder');
    const onPick = async () => {
      if (typeof window.showDirectoryPicker !== 'function') {
        // Mobile fallback: OPFS — the case lives in browser-private storage
        // on this device (same handle API; "Export case" gets the data out).
        if (navigator.storage && typeof navigator.storage.getDirectory === 'function') {
          try {
            const root = await navigator.storage.getDirectory();
            const handle = await root.getDirectoryHandle('nocase-case', { create: true });
            try { await navigator.storage.persist(); } catch {}
            window.__nci_folderHandle = handle;
            localStorage.setItem('ncOpfsCase', '1');
            renderCurrentStep();
          } catch (e) {
            alert('Could not open device storage: ' + e.message);
          }
          return;
        }
        alert('Your browser doesn\'t support folder access. Use Chrome, Edge, Brave, or Arc.');
        return;
      }
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
        window.__nci_folderHandle = handle;
        // Persist to the host's IndexedDB if available
        if (typeof window.idbSet === 'function') {
          try { await window.idbSet('noCaseFolderHandle', handle); } catch {}
        }
        renderCurrentStep();
      } catch (e) {
        if (e.name !== 'AbortError') alert('Could not access folder: ' + e.message);
      }
    };
    if (pickBtn) pickBtn.addEventListener('click', onPick);
    if (changeBtn) changeBtn.addEventListener('click', onPick);

    // Email + text provider picker
    document.querySelectorAll('[data-nci-email]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-nci-email]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        renderProviderInstruction(btn.dataset.nciEmail, 'nci-email-instructions');
      });
    });
    document.querySelectorAll('[data-nci-text]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-nci-text]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        renderProviderInstruction(btn.dataset.nciText, 'nci-text-instructions');
      });
    });

    // Loose-doc drop zone
    const dropZone = document.getElementById('nci-loose-drop');
    const dropInput = document.getElementById('nci-loose-input');
    const dropResult = document.getElementById('nci-loose-result');
    if (dropZone && dropInput) {
      dropZone.addEventListener('click', () => dropInput.click());
      dropInput.addEventListener('change', async (e) => {
        await ingestLooseFiles(Array.from(e.target.files || []), dropResult);
        e.target.value = '';
      });
      ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); dropZone.classList.add('drag-over');
      }));
      ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
      }));
      dropZone.addEventListener('drop', async (e) => {
        await ingestLooseFiles(Array.from(e.dataTransfer.files || []), dropResult);
      });
    }
  }

  function renderProviderInstruction(providerId, containerId) {
    const tpl = providerInstruction(providerId);
    const container = document.getElementById(containerId);
    if (!tpl || !container) return;
    let actionHtml = '';
    if (tpl.auto && providerId === 'apple-mail') {
      actionHtml = `
        <div style="margin-top: 0.7rem; padding-top: 0.7rem; border-top: 1px dashed var(--rule);">
          <div class="nci-label" style="margin-bottom: 0.3rem;">Keywords I'll search for</div>
          <div id="nci-keywords-display" style="margin-bottom: 0.5rem;"></div>
          <input class="nci-input" id="nci-keyword-add" type="text" placeholder="Add a keyword and press Enter" style="font-size: 0.8rem; margin-bottom: 0.5rem;" />
          <button class="nci-btn primary" id="nci-pick-mail">${escapeHtml(tpl.action)}</button>
          <div id="nci-import-result" class="nci-import-result" style="display: none;"></div>
        </div>
      `;
    }
    container.innerHTML = `
      <div class="nci-instruction-card">
        <strong>${escapeHtml(tpl.title)}</strong>
        <div style="margin-top: 0.3rem;">${tpl.body}</div>
        ${actionHtml}
      </div>
    `;
    // If apple-mail, wire the auto-scan
    if (tpl.auto && providerId === 'apple-mail') {
      renderKeywords();
      document.getElementById('nci-keyword-add')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
          state.data.importKeywords = state.data.importKeywords || defaultKeywords();
          state.data.importKeywords.push(e.target.value.trim());
          e.target.value = '';
          renderKeywords();
        }
      });
      document.getElementById('nci-pick-mail')?.addEventListener('click', pickMailFolder);
    }
  }

  async function ingestLooseFiles(files, resultEl) {
    if (!files.length) return;
    const fh = window.__nci_folderHandle;
    if (!fh) {
      if (resultEl) {
        resultEl.style.display = 'block';
        resultEl.className = 'nci-import-result err';
        resultEl.textContent = 'Pick a case folder first (section 1 above).';
      }
      return;
    }
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.className = 'nci-import-result';
      resultEl.textContent = 'Writing ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…';
    }
    let saved = 0;
    try {
      const docsDir = await fh.getDirectoryHandle('documents', { create: true });
      for (const file of files) {
        try {
          const out = await docsDir.getFileHandle(file.name, { create: true });
          const w = await out.createWritable();
          await w.write(file);
          await w.close();
          // Minimal meta sidecar so the workspace picks them up
          try {
            const buf = await file.arrayBuffer();
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
            const meta = {
              schemaVersion: 1, filename: file.name, addedAt: new Date().toISOString(),
              sha256, size: file.size, contentType: file.type || 'application/octet-stream',
              source: 'intake-loose-drop'
            };
            const metaH = await docsDir.getFileHandle(file.name + '.meta.json', { create: true });
            const mw = await metaH.createWritable();
            await mw.write(JSON.stringify(meta, null, 2));
            await mw.close();
          } catch {}
          saved++;
        } catch (e) { console.warn('failed to save', file.name, e); }
      }
      if (resultEl) {
        resultEl.className = 'nci-import-result ok';
        resultEl.textContent = 'Saved ' + saved + ' file' + (saved === 1 ? '' : 's') + ' into your case folder';
      }
    } catch (e) {
      if (resultEl) {
        resultEl.className = 'nci-import-result err';
        resultEl.textContent = 'Save failed: ' + e.message;
      }
    }
  }

  async function uploadSpineDoc(file) {
    const fh = window.__nci_folderHandle;
    if (!fh) {
      alert('No case folder is linked. Pick a folder from the workspace first.');
      return;
    }
    try {
      const docsDir = await fh.getDirectoryHandle('documents', { create: true });
      // Write the file
      const outHandle = await docsDir.getFileHandle(file.name, { create: true });
      const w = await outHandle.createWritable();
      await w.write(file);
      await w.close();
      // Hash it so we can carry the SHA-256 in the spine record
      let sha256 = null;
      try {
        const buf = await file.arrayBuffer();
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        // Write a minimal meta sidecar so the main workspace recognizes it
        const meta = {
          schemaVersion: 1,
          filename: file.name,
          addedAt: new Date().toISOString(),
          sha256,
          size: file.size,
          contentType: file.type || 'application/octet-stream',
          source: 'intake-spine-upload'
        };
        const metaHandle = await docsDir.getFileHandle(file.name + '.meta.json', { create: true });
        const mw = await metaHandle.createWritable();
        await mw.write(JSON.stringify(meta, null, 2));
        await mw.close();
      } catch (e) { console.warn('sidecar write failed', e); }
      // Auto-select this newly uploaded file as the spine
      state.data.spineDocument = { name: file.name, sha256, selectedAt: new Date().toISOString() };
      if (typeof window.showToast === 'function') window.showToast('Uploaded and selected as spine: ' + file.name);
    } catch (e) {
      console.warn('spine upload failed', e);
      alert('Upload failed: ' + e.message);
    }
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
    if (typeof window.showToast === 'function') window.showToast('Intake saved. Generating case brief in the background...');

    // Kick off case-brief generation in the background — don't block the UI
    generateBriefInBackground(cs).catch(e => console.warn('brief generation failed', e));
  }

  // ============================================================================
  // CASE-BRIEF GENERATION — calls Lambda generate_brief, writes case-brief.md
  // ============================================================================

  async function generateBriefInBackground(cs) {
    const fh = window.__nci_folderHandle;
    if (!fh) return;

    // Gather inputs: prefer fresh wizard state, fall back to what's saved in case.json
    // so manual regeneration works without re-opening the wizard
    const savedIntake = cs?.intake || {};
    const step1 = (state.data.step1 && Object.keys(state.data.step1).length)
      ? state.data.step1
      : (savedIntake.step1 || { description: cs?.caseDescription || '', caseType: cs?.caseType || 'unknown' });
    const spineDoc = state.data.spineDocument || savedIntake.spineDocument || null;
    const fallbackGoals = state.data.goals || savedIntake.goals || '';
    const fallbackRedLines = state.data.redLines?.length ? state.data.redLines : (savedIntake.redLines || []);
    const fallbackValues = state.data.values?.length ? state.data.values : (savedIntake.values || []);
    let spineText = null;
    if (spineDoc && spineDoc.name) {
      try {
        const docsDir = await fh.getDirectoryHandle('documents');
        const spineHandle = await docsDir.getFileHandle(spineDoc.name);
        const spineFile = await spineHandle.getFile();
        // Use the host's text-extraction cache if available
        if (window.docTextCache && window.docTextCache.get(spineDoc.name)) {
          spineText = window.docTextCache.get(spineDoc.name);
        } else if (typeof window.extractText === 'function') {
          spineText = await window.extractText(spineFile);
        }
      } catch (e) { console.warn('spine text load failed', e); }
    }

    // Load every document's FULL extracted text — not just preview — so the
    // brief generator can pull dates, dollar amounts, payment receipts, and
    // admissions from the actual document bodies, not just filenames.
    let documents = [];
    try {
      if (typeof window.listDocuments === 'function') {
        const docs = await window.listDocuments();
        const docsDir = await fh.getDirectoryHandle('documents');
        documents = await Promise.all(docs.map(async (d) => {
          // 1) Try in-memory cache first (set when doc was originally added or last attached)
          let text = (window.docTextCache && window.docTextCache.get(d.name)) || null;
          // 2) Cache miss → re-extract from disk on the fly
          if (!text && typeof window.extractText === 'function') {
            try {
              const handle = await docsDir.getFileHandle(d.name);
              const file = await handle.getFile();
              text = await window.extractText(file);
              if (text && window.docTextCache) window.docTextCache.set(d.name, text);
            } catch (e) { console.warn('full-text extract failed for', d.name, e); }
          }
          return {
            name: d.name,
            text: text || null,
            hasText: !!text,
            length: text ? text.length : 0
          };
        }));
      }
    } catch (e) { console.warn('docs full-text load failed', e); }

    // Check for existing brief (refresh mode)
    let existingBrief = null;
    try {
      const briefH = await fh.getFileHandle('case-brief.md');
      const briefF = await briefH.getFile();
      existingBrief = await briefF.text();
    } catch { /* no existing brief — first generation */ }

    // Build payload for generate_brief
    const payload = {
      task: 'generate_brief',
      caseTitle: cs.title || 'Untitled matter',
      caseDescription: step1.description || cs.caseDescription || '',
      caseType: step1.caseType || cs.caseType || 'unknown',
      jurisdiction: step1.jurisdiction || 'Texas',
      userRole: step1.userRole || null,
      otherRole: step1.otherRole || null,
      spineDocument: spineDoc,
      spineText,
      documents,
      goals: fallbackGoals,
      redLines: fallbackRedLines,
      values: fallbackValues,
      existingBrief
    };

    // Brief generation uses the Lambda Function URL (2-min timeout) instead
    // of API Gateway (29-sec timeout). This lets us send full document text
    // and use larger output budgets without hitting Gateway Timeout (504).
    // Other tasks (chat, extract_text, etc.) keep going through API Gateway
    // since they fit inside 29s and benefit from API Gateway's caching/throttling.
    const FUNCTION_URL = 'https://gwz2q7it5d264sob3rqsy4puly0xvfmd.lambda-url.us-east-1.on.aws/';

    try {
      const r = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      const brief = data?.result?.brief || data?.result || '';
      if (!brief) throw new Error('empty brief returned');

      // Write case-brief.md to the case folder root
      const out = await fh.getFileHandle('case-brief.md', { create: true });
      const w = await out.createWritable();
      await w.write(brief);
      await w.close();

      if (typeof window.showToast === 'function') window.showToast('Case brief saved — Claude will use it on every turn');
    } catch (e) {
      console.warn('generate_brief failed', e);
      if (typeof window.showToast === 'function') window.showToast('Brief generation failed: ' + e.message);
    }
  }

  // Expose for manual regeneration from Brief tab (Phase B)
  if (typeof window !== 'undefined') {
    window.NoCaseIntake = window.NoCaseIntake || {};
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
    window.NoCaseIntake = { open, close, regenerateBrief: () => generateBriefInBackground(window.__nci_caseState) };

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
          window.extractText = (typeof extractText === 'function') ? extractText : window.extractText;
          window.docTextCache = (typeof docTextCache !== 'undefined') ? docTextCache : window.docTextCache;
          window.saveCaseState = (typeof saveCaseState === 'function') ? saveCaseState : window.saveCaseState;
          window.showToast = (typeof showToast === 'function') ? showToast : window.showToast;
          clearInterval(bridge);

          // Now that the bridge is established, wrap extractText with a server-side
          // fallback (so any file the browser can't read gets sent to Bedrock
          // multimodal) and kick off background re-extraction of any stale 0-char
          // documents that were added before the libraries worked properly.
          installLambdaExtractFallback();
          setTimeout(() => {
            reextractStaleDocuments(folderHandle).catch(e => console.warn('reextract sweep failed', e));
          }, 2500);
        }
      } catch (e) { /* still loading */ }
    }, 200);
  }

  // ==========================================================================
  // Lambda fallback for extractText — when the browser's local extractors fail
  // (image-only PDFs, unusual DOCX structures, HEIC photos), send the file as
  // base64 to the Lambda's extract_text task, which hands it to Bedrock's
  // multimodal Claude for forensic transcription.
  // ==========================================================================
  function installLambdaExtractFallback() {
    if (window.__extractTextHasFallback) return;
    const original = window.extractText;
    if (typeof original !== 'function') return;
    window.__extractTextHasFallback = true;

    window.extractText = async function extractTextWithFallback(file) {
      // 1) Try local extraction
      let localText = null;
      try { localText = await original(file); }
      catch (e) { localText = null; }
      const localChars = localText ? localText.replace(/\s+/g, '').length : 0;
      // If local extraction yielded meaningful text, use it
      if (localChars >= 50) return localText;
      // 2) Fall back to Lambda extract_text — supports PDF/DOCX natively
      // plus images. Skip for genuinely unsupported types (audio, video, archives).
      const supportedExt = /\.(pdf|doc|docx|csv|xls|xlsx|html|htm|txt|md|png|jpg|jpeg|gif|webp)$/i;
      if (!supportedExt.test(file.name)) return localText;
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // Chunked btoa to avoid call-stack issues on larger files
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        const base64 = btoa(bin);
        const API = (typeof CONFIG !== 'undefined' && CONFIG.apiBase)
          || (window.NC_CONFIG && window.NC_CONFIG.apiBase)
          || 'https://dxfdmuqx1a.execute-api.us-east-1.amazonaws.com/prod/analyze';
        console.log('[extract] falling back to Lambda for', file.name, '(local got', localChars, 'chars)');
        const r = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: 'extract_text', filename: file.name, base64, mimeType: file.type })
        });
        if (!r.ok) throw new Error('http ' + r.status);
        const data = await r.json();
        const serverText = data && data.result && data.result.text ? data.result.text : '';
        if (serverText && serverText.length > 0) {
          console.log('[extract] Lambda returned', serverText.length, 'chars for', file.name);
          return serverText;
        }
      } catch (e) {
        console.warn('[extract] Lambda fallback failed for', file.name, e);
      }
      return localText; // best-effort
    };
  }

  // ==========================================================================
  // reextractStaleDocuments — silent sweep on case open. Iterates documents/,
  // finds any sidecar with extractedTextLength < 100, re-extracts (now with
  // Lambda fallback in place), and updates the sidecar. Runs once per case
  // open, in the background, no UI blocking.
  // ==========================================================================
  async function reextractStaleDocuments(fh) {
    if (!fh || window.__nci_reextractInProgress) return { checked: 0, fixed: 0, skipped: 0 };
    window.__nci_reextractInProgress = true;
    let docsDir;
    try { docsDir = await fh.getDirectoryHandle('documents'); }
    catch (e) { window.__nci_reextractInProgress = false; return { checked: 0, fixed: 0, skipped: 0 }; }

    let checked = 0, fixed = 0, skipped = 0;
    const stale = [];

    // First pass: identify stale files
    for await (const [name, handle] of docsDir.entries()) {
      if (handle.kind !== 'file') continue;
      if (name.endsWith('.meta.json')) continue;
      if (name === '.DS_Store') continue;
      checked++;
      let sidecar = null;
      try {
        const sh = await docsDir.getFileHandle(name + '.meta.json');
        const sf = await sh.getFile();
        sidecar = JSON.parse(await sf.text());
      } catch (e) { skipped++; continue; }
      const currentLen = sidecar.extractedTextLength || 0;
      if (currentLen >= 100) continue;
      stale.push({ name, handle, sidecar });
    }

    if (stale.length === 0) {
      window.__nci_reextractInProgress = false;
      console.log('[reextract] all documents already extracted (' + checked + ' checked)');
      return { checked, fixed: 0, skipped };
    }

    console.log('[reextract] found', stale.length, 'stale document(s) to re-extract');
    if (typeof window.showToast === 'function') {
      window.showToast('Re-extracting ' + stale.length + ' document' + (stale.length === 1 ? '' : 's') + '… (server-side, may take a minute)');
    }

    // Second pass: re-extract each
    for (const { name, handle, sidecar } of stale) {
      try {
        const file = await handle.getFile();
        const newText = await window.extractText(file); // wrapped — falls back to Lambda
        const newLen = newText ? newText.length : 0;
        if (newLen > (sidecar.extractedTextLength || 0)) {
          sidecar.extractedTextLength = newLen;
          sidecar.extractedTextPreview = newText.slice(0, 300);
          sidecar.lastReextractedAt = new Date().toISOString();
          const sw = await docsDir.getFileHandle(name + '.meta.json', { create: true });
          const writable = await sw.createWritable();
          await writable.write(JSON.stringify(sidecar, null, 2));
          await writable.close();
          if (window.docTextCache) window.docTextCache.set(name, newText);
          fixed++;
          console.log('[reextract] fixed', name, '→', newLen, 'chars');
        } else {
          console.log('[reextract] no improvement for', name, '(got', newLen, 'chars)');
        }
      } catch (e) {
        console.warn('[reextract] error on', name, e);
      }
    }

    if (fixed > 0 && typeof window.showToast === 'function') {
      window.showToast('Re-extracted ' + fixed + ' document' + (fixed === 1 ? '' : 's') + '. Click ★ Brief → Refresh from evidence to update the brief.');
    }
    window.__nci_reextractInProgress = false;
    return { checked, fixed, skipped };
  }

  whenReady(attach);
})();
