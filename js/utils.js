'use strict';

function goStep(n) {
  // Mark previous steps done, highlight current in sidebar
  document.querySelectorAll('.step').forEach(el => {
    const stepNum = parseInt(el.id.replace('nav',''));
    el.classList.remove('active');
    if (stepNum < n) el.classList.add('done');
  });
  const stepEl = document.getElementById('nav' + n);
  if (stepEl) { stepEl.classList.add('active'); stepEl.classList.remove('done'); }

  // Close only the collapsible card (slElCard) — always-open cards stay open
  const card = document.getElementById('slElCard');
  if (card) card.classList.remove('card-open');

  // Scroll to the first card for this step (all are always visible)
  const toOpen = STEP_CARD[n] || [];
  if (toOpen.length > 0) {
    const firstCard = document.getElementById(toOpen[0]);
    if (firstCard) {
      setTimeout(() => {
        firstCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }
  }

  // Store current step
  window._currentStep = n;
}

/* Toggle a single card open/closed on header click */
function toggleCard(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.toggle('card-open');
}
/* Open a specific card (used from step clicks in some flows) */
function openCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) card.classList.add('card-open');
}

function markDone(n) {
  const el = document.getElementById('nav' + n);
  if (el) el.classList.add('done');
}
// Allow keyboard activation of step nav buttons
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('step')) {
    e.target.click();
  }
});

/* ─── File handling ─────────────────────────────────────────── */
// Processing guard — prevents handleFile from running twice if a stale event fires
let _fileProcessing = false;


function fmtDisplay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

/* ─── Date utilities ────────────────────────────────────────── */
function datesInRange(start, end) {
  const out = [], cur = new Date(start), last = new Date(end);
  while (cur <= last) { out.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
  return out;
}
function parseDMY(s) {
  const [dd, mm, yyyy] = s.trim().split('-');
  return new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
}
function fmtDMY(d) {
  return String(d.getDate()).padStart(2,'0') + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + d.getFullYear();
}

/* ─── Holiday sets ──────────────────────────────────────────── */

function parseAlloc(alloc) {
  const slots = [];
  alloc.split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
    const m = part.match(/^(\d+)?([A-Z][A-Z0-9]*)$/i);
    if (m) {
      const cnt = m[1] ? parseInt(m[1], 10) : 1;
      const sh  = m[2].toUpperCase();
      for (let k = 0; k < cnt; k++) slots.push(sh);
    }
  });
  return slots.length ? slots : ['M'];
}

/* ─── Rotation offset ───────────────────────────────────────── */
// Returns the number of full rotation periods elapsed from the start of the roster
// (for monthly rotation, period = calendar month; otherwise, integer periods of N days)
/* rotOffset is defined above inside the combined block */

/* ─── Week-off position assignment ─────────────────────────── */
/*
 * Assigns a WO cycle-start position (0–6) to each employee such that:
 *
 *  1. SAME-SHIFT non-overlap: same-shift employees never share a WO day
 *     within a given rotation period.
 *
 *  2. SHIFT COVERAGE across ALL rotation periods: for every cycle day 0-6
 *     and every rotation period in the roster, every defined shift must
 *     have at least one working employee.
 *
 *     Key problem: with rotation (e.g. Every Month), each employee's shift
 *     changes at period boundaries. A WO position that is safe in June may
 *     leave a different shift uncovered in July. Coverage is checked across
 *     all period-day combinations.
 *
 *  3. Single-slot exclusivity: if an employee is the ONLY person on their
 *     shift in a given period, their WO days must be exclusive — no other
 *     employee may be on WO on the same cycle day within that period.
 *
 *  4. MAX-2 GLOBAL CAP: at most 2 employees on WO on the same cycle day
 *     (only when no single-slot exclusivity rule is violated).
 *
 *  shiftSlotForFn: (empIdx, di, dt) → shift — the rotation-aware slot function
 *  dates: full roster date array — used to enumerate all rotation periods
 */

function setProgress(pct, msg, type) {
  const pb = document.getElementById('pbar');
  const pf = document.getElementById('pbarFill');
  const ps = document.getElementById('pstat');
  pb.style.display = 'block';
  pb.setAttribute('aria-valuenow', pct);
  pf.style.width   = pct + '%';
  ps.textContent   = msg;
  ps.className     = 'pstat' + (type ? ' ' + type : '');
  if (pct === 0 || pct === 100) setTimeout(() => { if(pb) pb.style.display='none'; }, 2500);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─── Main generate function ────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────
 * _expandAutomationRules
 * Converts automation shiftRules that use multi-group bracket format
 * into the sub-rule objects that buildSchedules expects.
 * Rules with plain alloc strings (e.g. "M, A, N") pass through unchanged.
 * ──────────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─── Shift Assignments via Prompt ─────────────────────────── */

// The system prompt tells Claude exactly which format to produce
/* ═══════════════════════════════════════════════════════════════
   SL / EL – Absence & Coverage  (completely standalone module)
   Has its own roster file upload, own SL/EL parse, own coverage
   analysis and swap engine. Zero dependency on generateRoster().
   ═══════════════════════════════════════════════════════════════ */

// Module-private state
let _slElRosterData  = null;  // Parsed from the attached roster file
                              // Map: {empNameLower: {dateStr: shiftValue, ...}}
let _slElEmpMeta     = null;  // [{name, skill, email, location}]
let _slElPendingSwaps = {};   // {key: {coverName,dStr,absentKey,absentShift,coverShift}}
let _slElSwapData     = {};   // Out-of-band storage for swap button payloads (avoids JSON in onclick)

// ── Step 1: Wire the SL/EL file input on page load ─────────────
// (Called from init() at bottom of file)
