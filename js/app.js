'use strict';

function initSlElUpload() {
  const fi   = document.getElementById('slElFileInput');
  const zone = document.getElementById('slElUpzone');
  if (!fi || !zone) return;

  fi.addEventListener('change', function() {
    const f = this.files && this.files[0];
    if (f) slElHandleFile(f);
    try { this.value = ''; } catch(_) {}
  });
  zone.addEventListener('dragover', function(e) {
    e.preventDefault(); e.stopPropagation(); this.classList.add('drag');
  });
  zone.addEventListener('dragleave', function(e) {
    e.stopPropagation(); this.classList.remove('drag');
  });
  zone.addEventListener('drop', function(e) {
    e.preventDefault(); e.stopPropagation(); this.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!f.name.toLowerCase().match(/\.xlsx?$/)) {
      slElSetStatus('Wrong file type — attach the .xlsx roster.', false); return;
    }
    slElHandleFile(f);
  });
}

function slElSetStatus(msg, ok) {
  const el = document.getElementById('slElUpStatus');
  if (el) {
    el.textContent = msg;
    el.style.color = ok === true ? '#22c55e' : ok === false ? '#ff7070' : 'var(--tx3)';
  }
}

// ── Parse the attached roster Excel file ───────────────────────
function slElHandleFile(file) {
  if (typeof XLSX === 'undefined' || !XLSX.read) {
    slElSetStatus('Excel library not loaded — reload the page.', false); return;
  }
  document.getElementById('slElUpIcon').textContent = '⏳';
  document.getElementById('slElUpText').textContent = 'Reading ' + file.name + '…';
  slElSetStatus('', null);

  const reader = new FileReader();
  reader.onerror = () => slElSetStatus('Could not read the file. Try again.', false);
  reader.onload = function(ev) {
    try {
      const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // The roster has rows: R1=title, R2=legend, R3=month-band, R4=col headers, R5+=data
      // Find the header row: scan first 6 rows for "Name"
      let hRow = -1;
      for (let i = 0; i < Math.min(rows.length, 8); i++) {
        if (rows[i].some(c => String(c).trim().toLowerCase() === 'name')) { hRow = i; break; }
      }
      if (hRow < 0) {
        slElSetStatus('Could not find header row (Name column) in attached file.', false);
        document.getElementById('slElUpIcon').textContent = '️';
        document.getElementById('slElUpText').textContent = 'Header not found';
        return;
      }

      const headers = rows[hRow].map(c => String(c).trim().toLowerCase());
      const ci = {
        name:     headers.indexOf('name'),
        email:    headers.indexOf('email'),
        skill:    headers.indexOf('skill'),
        location: headers.indexOf('location'),
        shift:    headers.indexOf('shift'),
      };
      if (ci.name < 0) {
        slElSetStatus('Name column not found in attached file.', false); return;
      }

      // Day columns: detect by finding date-like headers after the Shift column
      // Header row has cells like "1\nMon", "2\nTue" etc., or just numbers
      const dayCols = []; // [{colIdx, dateStr}]
      // We need to know the date of each day column.
      // The month-band row (hRow-1 if it exists) tells us which month each span belongs to.
      // Simpler: look at the header row cell values — they contain day numbers.
      // The column label row also contains the DOW abbreviation.
      // We derive full dates from the month-band row + day number.

      // Find the month-band row (row above header)
      const monthBandRow = hRow > 0 ? rows[hRow - 1] : null;
      let monthMap = {}; // {colIdx: 'YYYY-MM'} — which year-month a day column belongs to
      if (monthBandRow) {
        let curYM = null;
        for (let ci2 = 0; ci2 < monthBandRow.length; ci2++) {
          const v = String(monthBandRow[ci2]).trim();
          // Month band cells look like "June 2026", "July 2026"
          const mMatch = v.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i);
          if (mMatch) {
            const mIdx = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(mMatch[1].toLowerCase());
            curYM = mMatch[2] + '-' + String(mIdx+1).padStart(2,'0');
          }
          if (curYM) monthMap[ci2] = curYM;
        }
      }

      // Now map day columns
      for (let ci2 = ci.shift + 1; ci2 < headers.length; ci2++) {
        const hVal = String(rows[hRow][ci2]).trim();
        // Header cell is "1\nMon" or "1" or "1 Mon"
        const dayMatch = hVal.match(/^(\d{1,2})/);
        if (!dayMatch) continue;
        const dayNum = parseInt(dayMatch[1], 10);
        const ym = monthMap[ci2] || '';
        if (ym) {
          const [y, m] = ym.split('-');
          const dt = new Date(+y, +m - 1, dayNum);
          const dStr = String(dt.getDate()).padStart(2,'0') + '-' +
                       String(dt.getMonth()+1).padStart(2,'0') + '-' + dt.getFullYear();
          dayCols.push({ colIdx: ci2, dateStr: dStr });
        }
      }

      // Build schedule map: {nameLower: {dateStr: shiftValue}}
      _slElRosterData = {};
      _slElEmpMeta    = [];
      let empCount = 0;

      for (let i = hRow + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.length) continue;
        const nm = String(r[ci.name] != null ? r[ci.name] : '').trim();
        if (!nm) continue;
        // Skip group-header rows (they span all columns and have no email/skill pattern)
        const emailVal = ci.email >= 0 ? String(r[ci.email]||'').trim() : '';
        const skillVal = ci.skill >= 0 ? String(r[ci.skill]||'').trim() : '';
        if (!skillVal && !emailVal) continue; // likely a group header row

        const nameKey = nm.toLowerCase();
        _slElEmpMeta.push({
          name: nm, skill: skillVal,
          email: emailVal,
          location: ci.location >= 0 ? String(r[ci.location]||'').trim() : ''
        });

        if (!_slElRosterData[nameKey]) _slElRosterData[nameKey] = {};
        // Fixed shift column
        const fixedShift = ci.shift >= 0 ? String(r[ci.shift]||'').trim() : '';
        if (fixedShift) _slElRosterData[nameKey].__fixedShift = fixedShift;
        // Day columns
        dayCols.forEach(({colIdx, dateStr}) => {
          const val = String(r[colIdx] != null ? r[colIdx] : '').trim();
          if (val) _slElRosterData[nameKey][dateStr] = val;
        });
        empCount++;
      }

      if (empCount === 0) {
        slElSetStatus('No employee rows found in attached file.', false);
        document.getElementById('slElUpIcon').textContent = '️';
        return;
      }

      document.getElementById('slElUpIcon').textContent = '✓';
      document.getElementById('slElUpIcon').style.color = '#22c55e';
      document.getElementById('slElUpText').textContent = file.name + '  ·  ' + empCount + ' employees';
      slElSetStatus('✓ Roster loaded — ' + empCount + ' employees, ' + dayCols.length + ' day columns.', true);

    } catch(err) {
      slElSetStatus('Error reading file: ' + err.message, false);
      document.getElementById('slElUpIcon').textContent = '️';
    }
  };
  reader.readAsArrayBuffer(file);
}

// ── Live preview while typing SL/EL entries ─────────────────────
function parseSlElDisplay() {
  const raw  = (document.getElementById('slElInput')?.value || '').trim();
  const prev = document.getElementById('slElPreview');
  if (!prev) return;
  if (!raw) { prev.textContent = ''; return; }
  const entries = parseSlElEntries(raw);
  const byEmp = {};
  entries.forEach(e => { if (!byEmp[e.name]) byEmp[e.name] = []; byEmp[e.name].push(e); });
  const parts = Object.entries(byEmp).map(([n, es]) =>
    `<span style="color:var(--ac)">${esc(n)}</span>: ` +
    es.map(e => `<span style="color:${e.type==='SL'?'#ffa0a0':'#ffcc88'}">${esc(e.type)}</span> `
      + `${e.dates.length} day${e.dates.length!==1?'s':''}`).join(', ')
  );
  prev.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

// ── Parse raw SL/EL text → [{name, type, dates:[dStr,...]}] ─────
function parseSlElEntries(raw) {
  const DMY_RE = /\d{2}-\d{2}-\d{4}/;
  const entries = [];
  raw.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).forEach(line => {
    const m = line.match(/^(.+?)\s*[\u2013\-]\s*(SL|EL):\s*(.+)$/i);
    if (!m) return;
    const name = m[1].trim(), type = m[2].toUpperCase();
    const dates = [];
    m[3].split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
      const rM = tok.match(/^(\d{2}-\d{2}-\d{4})\s+to\s+(\d{2}-\d{2}-\d{4})$/i);
      if (rM) {
        const p = s => { const [dd,mm,yyyy] = s.split('-'); return new Date(+yyyy,+mm-1,+dd); };
        let cur = p(rM[1]); const end = p(rM[2]);
        while (cur <= end) {
          dates.push(String(cur.getDate()).padStart(2,'0')+'-'+String(cur.getMonth()+1).padStart(2,'0')+'-'+cur.getFullYear());
          cur.setDate(cur.getDate()+1);
        }
      } else if (DMY_RE.test(tok)) {
        dates.push(tok.match(DMY_RE)[0]);
      }
    });
    if (dates.length) entries.push({ name, type, dates });
  });
  return entries;
}

// ── Main coverage analysis ───────────────────────────────────────
function runCoverageAnalysis() {
  const raw      = (document.getElementById('slElInput')?.value || '').trim();
  const statusEl = document.getElementById('slElStatus');
  const panelEl  = document.getElementById('coveragePanel');

  if (!_slElRosterData) {
    statusEl.textContent = ' Please attach the current roster file first (Step 1).';
    statusEl.style.color = '#ff7070'; return;
  }
  if (!raw) {
    statusEl.textContent = ' Enter at least one SL/EL entry (Step 2).';
    statusEl.style.color = '#ff7070'; return;
  }
  const entries = parseSlElEntries(raw);
  if (!entries.length) {
    statusEl.textContent = ' No valid SL/EL entries found.';
    statusEl.style.color = '#ff7070'; return;
  }
  statusEl.textContent = ''; _slElPendingSwaps = {}; _noActionDates.clear(); _slElSwapData = {};

  // Group by employee: {nameKey: {type, dates:[dStr,...]}}
  const absMap = {};
  entries.forEach(e => {
    const key = e.name.toLowerCase();
    if (!absMap[key]) absMap[key] = { name: e.name, type: e.type, dates: [] };
    e.dates.forEach(d => { if (!absMap[key].dates.includes(d)) absMap[key].dates.push(d); });
    absMap[key].type = e.type; // last wins (SL/EL)
  });

  // One block per employee with all their dates as tabs
  let html = '';
  Object.entries(absMap).forEach(([absentKey, info]) => {
    const sortedDates = info.dates.slice().sort((a,b)=>a.localeCompare(b));
    html += slElBuildBlock(absentKey, info.name, info.type, sortedDates);
  });

  panelEl.innerHTML = html;
  panelEl.style.display = 'block';
  panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Find cover candidates (includes W=week-off from same skill) ──
function slElBuildCoverRows(absentKey, absentSkill, dStr, absentShift) {
  const rows = [];
  (_slElEmpMeta || []).forEach(emp => {
    if (emp.name.toLowerCase() === absentKey) return;
    const shift = (_slElRosterData[emp.name.toLowerCase()]?.[dStr]) || '—';
    if (['AH','LH','PL','CO','SL','EL'].includes(shift) || shift === '—') return;
    const sameSkill  = emp.skill === absentSkill;
    const sameShift  = shift === absentShift;
    const isWO       = shift === 'W';

    let status = null;
    if (sameSkill && !isWO)   status = 'Already Covered';
    else if (sameSkill && isWO) status = 'On Week Off (same skill)';
    else if (!sameSkill && sameShift) status = 'Working on Same Shift';
    if (!status) return;
    rows.push({ skill: emp.skill, name: emp.name, shift, status });
  });
  // Sort: Already Covered → On Week Off → Working on Same Shift
  const order = { 'Already Covered': 0, 'On Week Off (same skill)': 1, 'Working on Same Shift': 2 };
  rows.sort((a,b) => (order[a.status]??9) - (order[b.status]??9) || a.name.localeCompare(b.name));
  return rows;
}

// ── Render one employee absence block with date tabs ─────────────
// Each date is a clickable pill tab; clicking reveals that date's coverage detail
function slElBuildBlock(absentKey, absentName, leaveType, sortedDates) {
  const absentMeta  = (_slElEmpMeta||[]).find(e => e.name.toLowerCase() === absentKey);
  const absentSkill = absentMeta?.skill || '(unknown)';
  const blockId     = 'slcb_' + absentKey.replace(/[^a-z0-9]/gi,'_');
  const typeColor   = leaveType === 'SL' ? '#ff8888' : '#ffbb55';
  const numDays     = sortedDates.length;

  // ── RANGE COVERAGE MODE: > 3 consecutive dates ───────────────────
  if (numDays > 3) {
    const startD     = sortedDates[0];
    const endD       = sortedDates[numDays - 1];
    const blockId2   = blockId + '_r';

    // ── Collect absent employee's schedule for each date ─────────────
    const shiftsByDate = {};
    sortedDates.forEach(d => {
      shiftsByDate[d] = (_slElRosterData[absentKey]?.[d]) || '—';
    });

    // ── Build "Shifts to be Covered" breakdown ─────────────────────
    // Group consecutive dates with the same shift into spans
    // Format each span: "M - 10-Jun(Mon) to 14-Jun(Fri)" or "W - 15-Jun(Sat) to 16-Jun(Sun)"
    function fmtShortDate(dStr) {
      const [dd,mm,yyyy] = dStr.split('-');
      const dt  = new Date(+yyyy,+mm-1,+dd);
      const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return parseInt(dd)+'-'+MON[dt.getMonth()]+'('+DOW[dt.getDay()]+')';
    }

    const shiftSpans = [];  // [{shift, dates:[dStr,...]}]
    sortedDates.forEach(d => {
      const sh = shiftsByDate[d] || '—';
      const last = shiftSpans[shiftSpans.length-1];
      if (last && last.shift === sh) last.dates.push(d);
      else shiftSpans.push({ shift: sh, dates: [d] });
    });

    const shiftsToCoverHtml = shiftSpans.map(span => {
      const shiftLabel = span.shift;
      const isWO       = shiftLabel === 'W';
      const bg         = slElShiftBg(shiftLabel);
      const fc         = ['AH','LH','PL','CO','SL','EL'].includes(shiftLabel)?'#fff':'#111';
      let rangeText;
      if (span.dates.length === 1) {
        rangeText = fmtShortDate(span.dates[0]);
      } else {
        rangeText = fmtShortDate(span.dates[0]) + ' to ' + fmtShortDate(span.dates[span.dates.length-1]);
      }
      return '<span style="font-size:10px;margin-right:10px">'
        + '<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:'+bg+';color:'+fc+'">'+esc(shiftLabel)+'</span>'
        + ' <span style="color:'+(isWO?'var(--tx3)':'var(--tx2)')+'">'+esc(rangeText)+'</span>'
        + (isWO ? ' <span style="color:var(--tx3);font-size:9px">(W/WO gaps can be ignored)</span>' : '')
        + '</span>';
    }).join('');

    // Check if non-WO shifts are present (actual coverage needed)
    const workingSpans   = shiftSpans.filter(s => s.shift !== 'W' && s.shift !== '—');
    const needsCoverage  = workingSpans.length > 0;

    // ── Build candidate map: name → {skill, dates[], shiftsOwn[], statuses} ──
    // "shiftsOwn" = what the candidate is actually working on each of their dates
    const candidateMap = {};
    sortedDates.forEach(d => {
      const absentShift = shiftsByDate[d];
      if (absentShift === '—' || absentShift === 'W') return;
      const rows = slElBuildCoverRows(absentKey, absentSkill, d, absentShift);
      rows.forEach(r => {
        if (!candidateMap[r.name]) {
          candidateMap[r.name] = {
            name:       r.name,
            skill:      r.skill,
            sameSkill:  r.skill === absentSkill,
            dates:      [],
            ownShifts:  [],   // candidate's own scheduled shift on each of their dates
            statuses:   new Set(),
          };
        }
        candidateMap[r.name].dates.push(d);
        candidateMap[r.name].ownShifts.push(r.shift);
        candidateMap[r.name].statuses.add(r.status);
      });
    });

    // Sort: same skill first, then other skills; within each group by name
    const statusOrder = { 'Already Covered':0, 'On Week Off (same skill)':1, 'Working on Same Shift':2 };
    const candidates = Object.values(candidateMap).sort((a,b) => {
      if (a.sameSkill !== b.sameSkill) return a.sameSkill ? -1 : 1;
      const ra = Math.min(...[...a.statuses].map(s=>statusOrder[s]??9));
      const rb = Math.min(...[...b.statuses].map(s=>statusOrder[s]??9));
      return ra - rb || a.name.localeCompare(b.name);
    });

    // Coverage alert: check if working shifts have at least one "Already Covered" candidate
    const absentWorkingShifts = [...new Set(workingSpans.map(s=>s.shift))];
    const coveredShifts = new Set();
    candidates.forEach(cand => {
      if ([...cand.statuses].includes('Already Covered')) {
        cand.ownShifts.forEach(s => coveredShifts.add(s));
      }
    });
    const uncoveredShifts = absentWorkingShifts.filter(s => !coveredShifts.has(s));
    const showAlert = needsCoverage && uncoveredShifts.length > 0;

    // ── Build "Shift Coverage" column value for a candidate ──────────
    function buildShiftCoverageStr(cand) {
      // Build spans: consecutive dates with same own shift
      const spans2 = [];
      cand.dates.forEach((d, i) => {
        const sh = cand.ownShifts[i];
        const last = spans2[spans2.length-1];
        if (last && last.shift === sh) last.dates.push(d);
        else spans2.push({ shift: sh, dates: [d] });
      });
      return spans2.map(sp => {
        const bg2 = slElShiftBg(sp.shift);
        const fc2 = ['AH','LH','PL','CO','SL','EL'].includes(sp.shift)?'#fff':'#111';
        let rng;
        if (sp.dates.length === 1) rng = fmtShortDate(sp.dates[0]);
        else rng = fmtShortDate(sp.dates[0]) + ' to ' + fmtShortDate(sp.dates[sp.dates.length-1]);
        return '<span style="display:inline-block;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;background:'+bg2+';color:'+fc2+'">'+esc(sp.shift)+'</span>'
             + '<span style="font-size:9px;color:var(--tx2);margin-left:3px">'+esc(rng)+'</span>';
      }).join('<span style="color:var(--tx3);margin:0 4px;font-size:9px">,</span>');
    }

    // ── Full Swap / Range Swap buttons ────────────────────────────────
    // RANGE button opens an inline date-range picker so managers can
    // assign sub-ranges to different people (e.g. A covers 17-19 Jun,
    // B covers 20-25 Jun) without overlap or leave conflicts.
    function buildSwapBtns(cand) {
      const slug     = (cand.name + '_' + absentKey).replace(/[^a-z0-9]/gi,'_');
      const fullKey  = 'fswp_' + slug;
      const rangeKey = 'rswp_' + slug;
      const pickerId = 'rpick_' + slug;

      const absShifts = cand.dates.map(d => shiftsByDate[d] || '—');
      // Working dates only (exclude W/—)
      const workingDates = cand.dates.filter((d,i) => absShifts[i]!=='W' && absShifts[i]!=='—');

      _slElSwapData[fullKey]  = {
        type:'full', coverName:cand.name, absentKey,
        dates:cand.dates, absShifts, ownShifts:cand.ownShifts, startD, endD
      };
      _slElSwapData[rangeKey] = {
        type:'range', coverName:cand.name, absentKey,
        dates:cand.dates, absShifts, ownShifts:cand.ownShifts, startD, endD,
        workingDates,
        // Selected sub-range indices into workingDates — updated by picker
        selStart: 0, selEnd: workingDates.length - 1
      };

      // Build the range picker HTML (hidden by default)
      // Shows working dates only with ▼ (start) and ▲ (end) step arrows
      const pickerHtml = workingDates.length === 0 ? '' :
        '<div id="'+pickerId+'" style="display:none;margin-top:6px;padding:8px 10px;'
        + 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);'
        + 'border-radius:6px;font-size:9px">'
        + '<div style="color:var(--tx3);font-size:9px;margin-bottom:6px;font-weight:600">'
        + 'SELECT SUB-RANGE &mdash; use arrows to adjust start / end dates:</div>'
        + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
        // Start date control
        + '<div style="display:flex;align-items:center;gap:3px">'
        + '<span style="color:var(--tx3);font-size:9px">From:</span>'
        + '<button onclick="slElRangeStep(\''+rangeKey+'\',\''+pickerId+'\',\'start\',-1)" '
        + 'style="padding:1px 6px;font-size:10px;cursor:pointer;border-radius:3px;'
        + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:var(--tx2)">◀</button>'
        + '<span id="'+pickerId+'_s" style="padding:2px 8px;border-radius:3px;'
        + 'background:rgba(40,90,200,.25);color:#88aaff;font-weight:700;min-width:100px;text-align:center">'
        + esc(workingDates[0]) + '</span>'
        + '<button onclick="slElRangeStep(\''+rangeKey+'\',\''+pickerId+'\',\'start\',1)" '
        + 'style="padding:1px 6px;font-size:10px;cursor:pointer;border-radius:3px;'
        + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:var(--tx2)">▶</button>'
        + '</div>'
        + '<span style="color:var(--tx3)">→</span>'
        // End date control
        + '<div style="display:flex;align-items:center;gap:3px">'
        + '<button onclick="slElRangeStep(\''+rangeKey+'\',\''+pickerId+'\',\'end\',-1)" '
        + 'style="padding:1px 6px;font-size:10px;cursor:pointer;border-radius:3px;'
        + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:var(--tx2)">◀</button>'
        + '<span id="'+pickerId+'_e" style="padding:2px 8px;border-radius:3px;'
        + 'background:rgba(40,90,200,.25);color:#88aaff;font-weight:700;min-width:100px;text-align:center">'
        + esc(workingDates[workingDates.length-1]) + '</span>'
        + '<button onclick="slElRangeStep(\''+rangeKey+'\',\''+pickerId+'\',\'end\',1)" '
        + 'style="padding:1px 6px;font-size:10px;cursor:pointer;border-radius:3px;'
        + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:var(--tx2)">▶</button>'
        + '<span style="color:var(--tx3);font-size:9px">To</span>'
        + '</div>'
        // Apply button
        + '<button onclick="slElSwapFromData(\''+rangeKey+'\')" '
        + 'id="'+rangeKey+'_apply" '
        + 'style="padding:2px 10px;font-size:9px;font-weight:600;cursor:pointer;border-radius:4px;'
        + 'background:rgba(30,180,100,.2);border:1px solid #1abc9c;color:#1abc9c;transition:all .15s">'
        + 'Apply Range</button>'
        // Days-count indicator
        + '<span id="'+pickerId+'_cnt" style="color:var(--tx3);font-size:9px">'
        + workingDates.length + ' day(s)</span>'
        + '</div>'
        + '</div>';

      return '<div style="display:flex;flex-direction:column;gap:4px">'
        // Row 1: Swap Fully + RANGE toggle
        + '<div style="display:flex;gap:4px;flex-wrap:wrap">'
        + '<button id="'+fullKey+'" onclick="slElSwapFromData(\''+fullKey+'\')" '
        + 'style="padding:3px 12px;font-size:9px;font-weight:600;cursor:pointer;border-radius:4px;'
        + 'background:rgba(40,90,200,.2);border:1px solid rgba(40,90,200,.4);color:#88aaff;'
        + 'transition:all .15s">Swap Fully</button>'
        + '<button id="'+rangeKey+'" onclick="slElToggleRangePicker(\''+rangeKey+'\',\''+pickerId+'\')" '
        + 'style="padding:3px 12px;font-size:9px;font-weight:600;cursor:pointer;border-radius:4px;'
        + 'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:var(--tx2);'
        + 'transition:all .15s">RANGE \u25BE</button>'
        + '</div>'
        // Row 2: picker (hidden until RANGE clicked)
        + pickerHtml
        + '</div>';
    }

    const thS = 'padding:5px 8px;font-size:9px;color:var(--tx3);font-weight:600;border-bottom:1px solid var(--bd)';

    const tableRows = candidates.map(cand => {
      const mainStatus  = [...cand.statuses].sort((a,b)=>(statusOrder[a]??9)-(statusOrder[b]??9))[0];
      const statusColor = mainStatus==='Already Covered'?'#ff7070':mainStatus==='On Week Off (same skill)'?'#ffbb55':'#88ccff';
      const statusLabel = mainStatus==='Already Covered'?'Covering':mainStatus==='On Week Off (same skill)'?'On WO':mainStatus;
      return '<tr style="border-bottom:1px solid rgba(255,255,255,.04)">'
        + '<td style="padding:5px 8px;font-size:10px;color:var(--tx2)">'+esc(cand.skill)+'</td>'
        + '<td style="padding:5px 8px;font-size:10px;font-weight:600">'+esc(cand.name)+'</td>'
        + '<td style="padding:5px 8px;font-size:10px">'+buildShiftCoverageStr(cand)+'</td>'
        + '<td style="padding:5px 8px;text-align:center;font-size:10px;font-weight:600;color:'+statusColor+'">'+esc(statusLabel)+'</td>'
        + '<td style="padding:5px 8px;white-space:nowrap">'+buildSwapBtns(cand)+'</td>'
        + '</tr>';
    }).join('');

    const tableHtml = candidates.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:11px">'
        + '<thead><tr style="background:rgba(255,255,255,.06)">'
        + '<th style="'+thS+';text-align:left">SKILL</th>'
        + '<th style="'+thS+';text-align:left">NAME</th>'
        + '<th style="'+thS+';text-align:left">SHIFT COVERAGE</th>'
        + '<th style="'+thS+';text-align:center">STATUS</th>'
        + '<th style="'+thS+';text-align:left">SWAP</th>'
        + '</tr></thead><tbody>'
        + tableRows
        + '</tbody></table>'
      : '<p style="font-size:10px;color:#ffaa55;margin:6px 0"> No available cover found for this date range.</p>';

    // Alert if coverage is incomplete
    const alertHtml = showAlert
      ? '<div style="margin-top:8px;padding:8px 12px;background:rgba(255,150,50,.1);border-radius:6px;'
        + 'border:1px solid rgba(255,150,50,.3)">'
        + '<span style="font-size:10px;color:#ffaa77;font-weight:600">'
        + '\u26a0 Coverage Alert: No "Already Covered" candidate found for shift(s): '
        + uncoveredShifts.join(', ')
        + '. Manual allocation may be required.'
        + '</span></div>'
      : '';

    // No Action Needed (whole range) — store dates out-of-band
    const rangeNabId  = blockId + '_range_nab';
    _slElSwapData[rangeNabId] = { type: 'noaction', absentKey, dates: sortedDates };
    const noActionBtn = '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<button id="'+rangeNabId+'" '
      + 'onclick="slElNoActionRangeFromData(\''+rangeNabId+'\')" '
      + 'style="padding:5px 16px;font-size:11px;font-weight:600;cursor:pointer;border-radius:6px;'
      + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.2);color:var(--tx2);'
      + 'transition:background .15s">'
      + '\u2713 No Action Needed</button>'
      + '<span id="'+rangeNabId+'_msg" style="font-size:10px;color:var(--tx3)"></span>'
      + '</div>';

    return '<div id="'+blockId+'" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.1);'
      + 'border-radius:8px;padding:14px 16px;margin-bottom:14px">'
      // ── Header
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">'
      + '<span style="font-size:13px;font-weight:700">'+esc(absentName)+'</span>'
      + '<span style="padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;'
        + 'background:'+typeColor+'22;color:'+typeColor+';border:1px solid '+typeColor+'55">'+esc(leaveType)+'</span>'
      + '<span style="font-size:10px;color:var(--tx3)">'+esc(absentSkill)+'</span>'
      + '<span style="font-size:10px;color:var(--tx3)">'+numDays+' days</span>'
      + '</div>'
      // ── Range summary box
      + '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);'
        + 'border-radius:6px;padding:10px 14px;margin-bottom:12px">'
      + '<div style="font-size:11px;font-weight:700;color:var(--tx2);margin-bottom:6px">'
        + '\uD83D\uDCC5 '+esc(absentName)+' &ndash; '+esc(leaveType)+': '+numDays+' days'
        + '&nbsp;&nbsp;<span style="font-weight:400;color:var(--tx3)">Range: '
        + esc(fmtShortDate(startD))+' to '+esc(fmtShortDate(endD))+'</span>'
      + '</div>'
      + '<div style="font-size:10px;color:var(--tx3);margin-bottom:4px">Shifts to be covered:</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:4px">'+shiftsToCoverHtml+'</div>'
      + '</div>'
      // ── Coverage table
      + tableHtml
      + alertHtml
      + noActionBtn
      + '</div>';
  }

  // ── TAB MODE: ≤ 3 dates — individual pill tabs ───────────────────
  const tabs = sortedDates.map((d, i) =>
    '<button id="'+blockId+'_tab_'+i+'" '
    + 'onclick="slElSelectDate(\''+blockId+'\',\''+esc(absentKey)+'\','+i+')" '
    + 'style="padding:4px 10px;font-size:10px;font-weight:600;cursor:pointer;border-radius:20px;'
    + 'transition:all .15s;border:1px solid rgba(255,255,255,.15);'
    + (i===0
        ? 'background:'+typeColor+';color:#111;border-color:'+typeColor
        : 'background:rgba(255,255,255,.06);color:var(--tx2)')
    + '">'
    + esc(d)
    + '</button>'
  ).join('');

  const datePanels = sortedDates.map((d, i) => {
    const absentShift = (_slElRosterData[absentKey]?.[d]) || '—';
    const rows        = slElBuildCoverRows(absentKey, absentSkill, d, absentShift);
    return '<div id="'+blockId+'_dp_'+i+'" style="display:'+(i===0?'block':'none')+'">'
      + slElDateDetail(blockId, absentKey, absentSkill, d, absentShift, rows)
      + '</div>';
  }).join('');

  return '<div id="'+blockId+'" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.1);'
    + 'border-radius:8px;padding:14px 16px;margin-bottom:14px">'
    + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">'
    + '<span style="font-size:13px;font-weight:700">'+esc(absentName)+'</span>'
    + '<span style="padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;'
      + 'background:'+typeColor+'22;color:'+typeColor+';border:1px solid '+typeColor+'55">'+leaveType+'</span>'
    + '<span style="font-size:10px;color:var(--tx3)">'+esc(absentSkill)+'</span>'
    + '<span style="font-size:10px;color:var(--tx3)">'+numDays
      + ' day'+(numDays!==1?'s':'')+'</span>'
    + '</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">'
    + tabs
    + '</div>'
    + datePanels
    + '</div>';
}

// ── Render detail for one specific date ──────────────────────────
function slElDateDetail(blockId, absentKey, absentSkill, dStr, absentShift, rows) {
  const shiftBadge = v => '<span style="display:inline-block;padding:1px 6px;border-radius:3px;'
    + 'font-size:10px;font-weight:700;background:'+slElShiftBg(v)+';color:'
    + (['AH','LH'].includes(v)?'#fff':'#111')+'">'+esc(v)+'</span>';

  const thS = 'padding:5px 8px;font-size:9px;color:var(--tx3);font-weight:600;border-bottom:1px solid var(--bd)';

  // Separate rows into working / on-WO
  const workingRows = rows.filter(r => r.shift !== 'W');
  const woRows      = rows.filter(r => r.shift === 'W');

  const renderRows = (rList) => rList.map(r => {
    const isWO   = r.shift === 'W';
    const isWOS  = r.status === 'On Week Off (same skill)';
    const btnId  = 'swpbtn_' + (r.name+'_'+dStr+'_'+absentKey).replace(/[^a-z0-9]/gi,'_');
    const statusColor = r.status==='Already Covered'?'#ff7070':isWOS?'#ffbb55':'#88ccff';
    return '<tr style="border-bottom:1px solid rgba(255,255,255,.04)' + (isWO?';background:rgba(255,200,80,.04)':'') + '">'
      + '<td style="padding:5px 8px;font-size:10px;color:var(--tx2)">'+esc(r.skill)+'</td>'
      + '<td style="padding:5px 8px;font-size:10px;font-weight:500">'+esc(r.name)+'</td>'
      + '<td style="padding:5px 8px;text-align:center">'+shiftBadge(r.shift)+'</td>'
      + '<td style="padding:5px 8px;text-align:center;font-size:10px;color:'+statusColor+'">'+esc(r.status)+'</td>'
      + '<td style="padding:5px 8px;text-align:center">'
      + '<button id="'+btnId+'" '
      + 'onclick="slElToggleSwap(\''+btnId+'\',\''+esc(r.name)+'\',\''+esc(dStr)+'\',\''+esc(absentKey)+'\',\''+esc(absentShift)+'\',\''+esc(r.shift)+'\')" '
      + 'style="padding:3px 10px;font-size:10px;font-weight:600;cursor:pointer;border-radius:4px;'
      + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:var(--tx2)">Want to Swap</button>'
      + '</td></tr>';
  }).join('');

  const tableHtml = rows.length
    ? '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px">'
        + '<thead><tr style="background:rgba(255,255,255,.06)">'
        + '<th style="'+thS+';text-align:left">SKILL</th>'
        + '<th style="'+thS+';text-align:left">NAME</th>'
        + '<th style="'+thS+';text-align:center">CURRENT SHIFT</th>'
        + '<th style="'+thS+';text-align:center">STATUS</th>'
        + '<th style="'+thS+';text-align:center">ACTION</th>'
        + '</tr></thead>'
        + '<tbody>'
        + (workingRows.length ? renderRows(workingRows) : '')
        + (woRows.length
            ? '<tr><td colspan="5" style="padding:4px 8px;font-size:9px;color:var(--tx3);'
              + 'text-transform:uppercase;letter-spacing:.05em;background:rgba(255,200,80,.06)">'
              + 'On Week Off — same skill (manager can contact if required)</td></tr>'
              + renderRows(woRows)
            : '')
        + '</tbody></table>'
    : '<p style="font-size:10px;color:#ffaa55;margin:6px 0"> No available cover found for this date.</p>';

  // Shift summary line + question
  return '<div style="font-size:10px;color:var(--tx3);margin-bottom:4px">'
    + '<strong style="color:var(--tx2)">'+esc(dStr)+'</strong>'
    + ' — scheduled shift: '+shiftBadge(absentShift)
    + ' — <span style="color:var(--tx3)">'+esc(absentSkill)+'</span>'
    + '</div>'
    + '<p style="font-size:10px;color:var(--tx3);margin-bottom:2px">List All People Availability:</p>'
    + tableHtml
    + '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
    + '<button id="'+blockId+'_nab_'+dStr.replace(/-/g,'')+'" '
    + 'onclick="slElNoAction(\''+blockId+'_nab_'+dStr.replace(/-/g,'')+'\'\,\''+esc(dStr)+'\'\,\''+esc(absentKey)+'\'\)" '
    + 'style="padding:5px 16px;font-size:11px;font-weight:600;cursor:pointer;border-radius:6px;'
    + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.2);color:var(--tx2);'
    + 'transition:background .15s">'
    + '\u2713 No Action Needed</button>'
    + '<span id="'+blockId+'_nab_'+dStr.replace(/-/g,'')+'_msg" style="font-size:10px;color:var(--tx3)"></span>'
    + '</div>';
}

// ── Switch active date tab ────────────────────────────────────────
function slElSelectDate(blockId, absentKey, tabIdx) {
  const block = document.getElementById(blockId);
  if (!block) return;
  // Update tab pill styles
  block.querySelectorAll('[id^="'+blockId+'_tab_"]').forEach((btn, i) => {
    const absMeta = (_slElEmpMeta||[]).find(e => e.name.toLowerCase() === absentKey);
    // Find the leaveType for colour
    const slElRaw = document.getElementById('slElInput')?.value || '';
    const ents    = parseSlElEntries(slElRaw);
    const ent     = ents.find(e => e.name.toLowerCase() === absentKey);
    const tc      = (!ent || ent.type==='SL') ? '#ff8888' : '#ffbb55';
    if (i === tabIdx) {
      btn.style.background   = tc;
      btn.style.color        = '#111';
      btn.style.borderColor  = tc;
    } else {
      btn.style.background   = 'rgba(255,255,255,.06)';
      btn.style.color        = 'var(--tx2)';
      btn.style.borderColor  = 'rgba(255,255,255,.15)';
    }
  });
  // Show/hide date panels
  block.querySelectorAll('[id^="'+blockId+'_dp_"]').forEach((panel, i) => {
    panel.style.display = i === tabIdx ? 'block' : 'none';
  });
}

// ── No Action Needed — toggles acknowledged state, no roster change ─
// _noActionDates: tracks dates the manager acknowledged as "no change needed".
// Key format: absentKey + '::' + dStr
// slElReModify skips any pending swap whose key matches a no-action entry.
const _noActionDates = new Set();

function slElNoAction(btnId, dStr, absentKey) {
  const btn = document.getElementById(btnId);
  const msg = document.getElementById(btnId + '_msg');
  if (!btn) return;

  const trackKey = (absentKey || '') + '::' + dStr;

  if (btn.dataset.acked === '1') {
    // Second click — revert: changes for this date are considered again
    btn.dataset.acked     = '0';
    btn.style.background  = 'rgba(255,255,255,.07)';
    btn.style.borderColor = 'rgba(255,255,255,.2)';
    btn.style.color       = 'var(--tx2)';
    btn.textContent       = '✓ No Action Needed';
    btn.title             = 'Click to mark this date as no changes needed';
    _noActionDates.delete(trackKey);
    if (msg) { msg.textContent = ''; }
  } else {
    // First click — no changes needed for this date
    btn.dataset.acked     = '1';
    btn.style.background  = 'rgba(30,180,100,.15)';
    btn.style.borderColor = '#1abc9c';
    btn.style.color       = '#ff7070';
    btn.textContent       = '✓ Acknowledged — click to revert';
    btn.title             = 'Click again to allow changes for this date';
    _noActionDates.add(trackKey);
    if (msg) {
      msg.textContent = 'No roster changes will be made for ' + dStr + '. Click again to revert.';
      msg.style.color = '#ff7070';
    }
  }
}


// ── Dispatch swap actions from the out-of-band data store ────────
// Called by Swap Fully / Range Swap buttons instead of passing
// arrays directly in onclick attributes (which breaks on double-quotes).
function slElSwapFromData(btnId) {
  const d = _slElSwapData[btnId];
  if (!d) return;
  if (d.type === 'full') {
    slElSwapFull(btnId, d.coverName, d.absentKey, d.dates, d.absShifts, d.ownShifts);
  } else if (d.type === 'range') {
    slElSwapRange(btnId, d.coverName, d.absentKey, d.dates, d.absShifts, d.ownShifts, d.startD, d.endD);
  }
}

function slElNoActionRangeFromData(btnId) {
  const d = _slElSwapData[btnId];
  if (!d) return;
  slElNoActionRange(btnId, d.absentKey, d.dates);
}

// ── Swap Fully — register swaps for ALL working dates in the range ─
// Selecting Swap Fully deselects the paired RANGE button for this candidate.
function slElSwapFull(btnId, coverName, absentKey, dates, absShifts, ownShifts) {
  const btn  = document.getElementById(btnId);
  if (!btn) return;
  // Pair: fswp_{slug} ↔ rswp_{slug} — same slug, different prefix
  const rangeKey = btnId.replace(/^fswp_/, 'rswp_');
  const rangeBtn = document.getElementById(rangeKey);
  const isOn     = btn.dataset.swapped === '1';
  const d        = _slElSwapData[btnId] || {};

  if (isOn) {
    // Deselect
    dates.forEach(d2 => { delete _slElPendingSwaps[coverName + '::' + d2 + '::' + absentKey]; });
    _slElSetSwapBtnOff(btn, 'full');
  } else {
    // If RANGE was selected, deselect it first
    if (rangeBtn && rangeBtn.dataset.swapped === '1') {
      dates.forEach(d2 => { delete _slElPendingSwaps[coverName + '::' + d2 + '::' + absentKey]; });
      _slElSetSwapBtnOff(rangeBtn, 'range', d.startD, d.endD);
    }
    // Register swaps for every working date
    dates.forEach((d2, i) => {
      const abShift = absShifts[i] || '—';
      if (abShift === '—' || abShift === 'W') return;
      _slElPendingSwaps[coverName + '::' + d2 + '::' + absentKey] = {
        coverName, dStr: d2, absentKey, absentShift: abShift, coverShift: ownShifts[i] || abShift
      };
    });
    _slElSetSwapBtnOn(btn, 'full');
  }
  _slElUpdatePendingAlert(absentKey);
}

// ── Toggle the inline range picker ───────────────────────────────
function slElToggleRangePicker(rangeKey, pickerId) {
  const picker = document.getElementById(pickerId);
  const btn    = document.getElementById(rangeKey);
  if (!picker) return;
  const isOpen = picker.style.display !== 'none';
  picker.style.display = isOpen ? 'none' : 'block';
  if (btn) btn.textContent = isOpen ? 'RANGE \u25BE' : 'RANGE \u25B4';
}

// ── Step start or end date in the range picker ────────────────────
// dir: -1 = move earlier, +1 = move later
// which: 'start' | 'end'
function slElRangeStep(rangeKey, pickerId, which, dir) {
  const d = _slElSwapData[rangeKey];
  if (!d || !d.workingDates || !d.workingDates.length) return;
  const wd  = d.workingDates;
  const max = wd.length - 1;

  if (which === 'start') {
    d.selStart = Math.max(0, Math.min(d.selStart + dir, d.selEnd));
  } else {
    d.selEnd = Math.min(max, Math.max(d.selEnd + dir, d.selStart));
  }

  // Update the displayed dates
  const sEl = document.getElementById(pickerId + '_s');
  const eEl = document.getElementById(pickerId + '_e');
  const cEl = document.getElementById(pickerId + '_cnt');
  if (sEl) sEl.textContent = wd[d.selStart];
  if (eEl) eEl.textContent = wd[d.selEnd];
  if (cEl) cEl.textContent = (d.selEnd - d.selStart + 1) + ' day(s)';
}

// ── Range Swap — register swaps for the selected sub-range only ────
function slElSwapRange(btnId, coverName, absentKey, dates, absShifts, ownShifts, startD, endD) {
  const btn     = document.getElementById(btnId);
  if (!btn) return;
  const fullKey = btnId.replace(/^rswp_/, 'fswp_');
  const fullBtn = document.getElementById(fullKey);
  const isOn    = btn.dataset.swapped === '1';
  // Get the sub-range from the data store (updated by slElRangeStep)
  const d       = _slElSwapData[btnId] || {};
  const wd      = d.workingDates || dates.filter((_,i)=>absShifts[i]!=='W'&&absShifts[i]!=='—');
  const si      = d.selStart !== undefined ? d.selStart : 0;
  const ei      = d.selEnd   !== undefined ? d.selEnd   : wd.length - 1;
  const subDates = wd.slice(si, ei + 1);

  if (isOn) {
    // Deselect — remove only the sub-range swaps for this candidate
    subDates.forEach(d2 => { delete _slElPendingSwaps[coverName + '::' + d2 + '::' + absentKey]; });
    btn.dataset.swapped = '0';
    _slElSetSwapBtnOff(btn, 'range', startD, endD);
    // Update apply button label
    const applyBtn = document.getElementById(btnId + '_apply');
    if (applyBtn) {
      applyBtn.style.background = 'rgba(30,180,100,.2)';
      applyBtn.style.color      = '#1abc9c';
      applyBtn.style.borderColor= '#1abc9c';
      applyBtn.textContent      = 'Apply Range';
    }
  } else {
    // If Swap Fully was selected, deselect it first
    if (fullBtn && fullBtn.dataset.swapped === '1') {
      dates.forEach(d2 => { delete _slElPendingSwaps[coverName + '::' + d2 + '::' + absentKey]; });
      _slElSetSwapBtnOff(fullBtn, 'full');
    }
    // Register swaps for the selected sub-range working dates
    subDates.forEach(subD => {
      const dateIdx = dates.indexOf(subD);
      const abShift = dateIdx >= 0 ? (absShifts[dateIdx] || '—') : '—';
      const owShift = dateIdx >= 0 ? (ownShifts[dateIdx] || abShift) : abShift;
      if (abShift === '—' || abShift === 'W') return;
      _slElPendingSwaps[coverName + '::' + subD + '::' + absentKey] = {
        coverName, dStr: subD, absentKey, absentShift: abShift, coverShift: owShift
      };
    });
    btn.dataset.swapped = '1';
    // Show selected range on RANGE button
    btn.style.background  = 'rgba(30,180,100,.2)';
    btn.style.borderColor = '#1abc9c';
    btn.style.color       = '#1abc9c';
    btn.style.fontWeight  = '700';
    btn.textContent       = '\u2713 RANGE \u25B2 (' + esc(subDates[0]||'') + ' to ' + esc(subDates[subDates.length-1]||'') + ')';
    // Update apply button to show selected state
    const applyBtn = document.getElementById(btnId + '_apply');
    if (applyBtn) {
      applyBtn.style.background = 'rgba(30,180,100,.3)';
      applyBtn.style.color      = '#fff';
      applyBtn.style.borderColor= '#1abc9c';
      applyBtn.textContent      = '\u2713 Applied';
    }
  }
  _slElUpdatePendingAlert(absentKey);
}

// ── Visual state helpers ──────────────────────────────────────────
function _slElSetSwapBtnOn(btn, type, startD, endD) {
  btn.dataset.swapped   = '1';
  btn.style.background  = 'rgba(30,180,100,.25)';
  btn.style.borderColor = '#1abc9c';
  btn.style.color       = '#1abc9c';
  btn.style.fontWeight  = '700';
  btn.textContent = type === 'full'
    ? '\u2713 Swap Fully \u25B2'
    : '\u2713 RANGE \u25B2';
}
function _slElSetSwapBtnOff(btn, type, startD, endD) {
  btn.dataset.swapped   = '0';
  if (type === 'full') {
    btn.style.background  = 'rgba(40,90,200,.2)';
    btn.style.borderColor = 'rgba(40,90,200,.4)';
    btn.style.color       = '#88aaff';
    btn.style.fontWeight  = '600';
    btn.textContent       = 'Swap Fully';
  } else {
    btn.style.background  = 'rgba(255,255,255,.06)';
    btn.style.borderColor = 'rgba(255,255,255,.15)';
    btn.style.color       = 'var(--tx2)';
    btn.style.fontWeight  = '600';
    btn.textContent       = 'RANGE: ' + (startD||'') + ' to ' + (endD||'');
  }
}

// ── Live pending-coverage alert ────────────────────────────────────
// After every swap toggle, recompute which working dates still have
// no swap selected. Updates the alert panel inside the block.
// W/WO days are never flagged — only actual working shifts.
function _slElUpdatePendingAlert(absentKey) {
  // Find the block element for this absent employee
  const blockId  = 'slcb_' + absentKey.replace(/[^a-z0-9]/gi,'_');
  const block    = document.getElementById(blockId);
  const alertId  = blockId + '_pending_alert';
  if (!block) return;

  // Collect all working dates for this employee from _slElSwapData
  const allWorkingDates = new Set();
  Object.values(_slElSwapData).forEach(d => {
    if ((d.type === 'full' || d.type === 'range') && d.absentKey === absentKey) {
      d.dates.forEach((dt, i) => {
        if (d.absShifts[i] !== '—' && d.absShifts[i] !== 'W') allWorkingDates.add(dt);
      });
    }
  });

  // Collect dates already covered by a pending swap
  const coveredDates = new Set(
    Object.values(_slElPendingSwaps)
      .filter(s => s.absentKey === absentKey)
      .map(s => s.dStr)
  );

  // Pending = working days with no swap yet
  const pendingDates = [...allWorkingDates].filter(d => !coveredDates.has(d)).sort();

  // Find or create the alert div (just after the table, before noActionBtn)
  let alertEl = document.getElementById(alertId);
  if (!alertEl) {
    alertEl = document.createElement('div');
    alertEl.id = alertId;
    // Insert after the table (before the noActionBtn div at the end of the block)
    const noActionDiv = block.querySelector('[id$="_range_nab"]')?.parentElement;
    if (noActionDiv) block.insertBefore(alertEl, noActionDiv);
    else block.appendChild(alertEl);
  }

  if (pendingDates.length === 0) {
    // All working dates covered — show success
    alertEl.innerHTML =
      '<div style="margin:8px 0;padding:8px 12px;background:rgba(30,180,100,.12);'
      + 'border-radius:6px;border:1px solid rgba(30,180,100,.3)">'
      + '<span style="font-size:10px;color:#ff7070;font-weight:600">'
      + '\u2713 All working days are covered by the selected swap(s).'
      + '</span></div>';
  } else if (coveredDates.size > 0) {
    // Partial — some days covered, some pending
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const fmt = s => { const [dd,mm,yy]=s.split('-'); const dt=new Date(+yy,+mm-1,+dd);
      return parseInt(dd)+'-'+MON[dt.getMonth()]+'('+DOW[dt.getDay()]+')'; };
    alertEl.innerHTML =
      '<div style="margin:8px 0;padding:8px 12px;background:rgba(255,150,50,.1);'
      + 'border-radius:6px;border:1px solid rgba(255,150,50,.3)">'
      + '<span style="font-size:10px;color:#ffaa55;font-weight:600">'
      + '\u26a0 Pending coverage: '
      + pendingDates.map(fmt).join(', ')
      + ' &mdash; select additional swap(s) to cover these days.'
      + '</span></div>';
  } else {
    // Nothing selected yet — clear any previous alert
    alertEl.innerHTML = '';
  }
}
// Marks ALL dates in the range as acknowledged in one click.
function slElNoActionRange(btnId, absentKey, dates) {
  const btn = document.getElementById(btnId);
  const msg = document.getElementById(btnId + '_msg');
  if (!btn) return;

  if (btn.dataset.acked === '1') {
    // Revert — remove all dates from _noActionDates
    btn.dataset.acked     = '0';
    btn.style.background  = 'rgba(255,255,255,.07)';
    btn.style.borderColor = 'rgba(255,255,255,.2)';
    btn.style.color       = 'var(--tx2)';
    btn.textContent       = '\u2713 No Action Needed';
    btn.title             = 'Click to mark this range as no changes needed';
    dates.forEach(d => _noActionDates.delete(absentKey + '::' + d));
    if (msg) { msg.textContent = ''; }
  } else {
    // Acknowledge — add all dates to _noActionDates
    btn.dataset.acked     = '1';
    btn.style.background  = 'rgba(30,180,100,.15)';
    btn.style.borderColor = '#1abc9c';
    btn.style.color       = '#ff7070';
    btn.textContent       = '\u2713 Range Acknowledged \u2014 click to revert';
    btn.title             = 'Click again to allow changes for this range';
    dates.forEach(d => _noActionDates.add(absentKey + '::' + d));
    if (msg) {
      msg.textContent = 'No roster changes will be made for this '+dates.length+'-day range. Click again to revert.';
      msg.style.color = '#ff7070';
    }
  }
}
function slElToggleSwap(btnId, coverName, dStr, absentKey, absentShift, coverShift) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const key = coverName + '::' + dStr + '::' + absentKey;
  if (_slElPendingSwaps[key]) {
    delete _slElPendingSwaps[key];
    btn.style.cssText = 'padding:3px 12px;font-size:10px;font-weight:600;cursor:pointer;border-radius:4px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:var(--tx2)';
    btn.textContent = 'Want to Swap';
  } else {
    _slElPendingSwaps[key] = { coverName, dStr, absentKey, absentShift, coverShift };
    btn.style.cssText = 'padding:3px 12px;font-size:10px;font-weight:600;cursor:pointer;border-radius:4px;background:rgba(30,180,100,.2);border:1px solid #1abc9c;color:#1abc9c';
    btn.textContent = '\u2713 Selected';
  }
}

// ── Clear All — resets the entire SL/EL module ───────────────────
function slElClearAll() {
  // Reset file upload zone
  const fi = document.getElementById('slElFileInput');
  if (fi) { try { fi.value = ''; } catch(_) {} }
  const icon = document.getElementById('slElUpIcon');
  const text = document.getElementById('slElUpText');
  const zone = document.getElementById('slElUpzone');
  if (icon) icon.textContent = '↑';
  if (text) text.textContent = 'Drop the roster .xlsx here, or click to browse';
  if (zone) { zone.classList.remove('ready'); zone.style.borderColor = ''; }
  const upSt = document.getElementById('slElUpStatus');
  if (upSt) upSt.textContent = '';

  // Reset SL/EL textarea
  const ta = document.getElementById('slElInput');
  if (ta) ta.value = '';
  const prev = document.getElementById('slElPreview');
  if (prev) prev.textContent = '';

  // Reset coverage panel
  const panel = document.getElementById('coveragePanel');
  if (panel) { panel.innerHTML = ''; panel.style.display = 'none'; }

  // Reset status
  const st = document.getElementById('slElStatus');
  if (st) { st.textContent = ''; st.style.color = 'var(--tx3)'; }

  // Reset module state
  _slElRosterData   = null;
  _slElEmpMeta      = null;
  _slElPendingSwaps = {};
  _slElSwapData     = {};
  _noActionDates.clear();
}

// ── Re-Modify: apply all selected swaps, export Excel + JSON + HTML ──
async function slElReModify() {
  const statusEl = document.getElementById('slElStatus');
  if (!_slElRosterData) {
    if(statusEl){ statusEl.textContent=' No roster loaded.'; statusEl.style.color='#ff7070'; }
    return;
  }

  // ── Require either pending swaps OR at least one SL/EL entry ──────
  const slElRaw  = document.getElementById('slElInput')?.value || '';
  const slElEnts = parseSlElEntries(slElRaw);
  const hasSwaps = Object.keys(_slElPendingSwaps).length > 0;
  const hasLeave = slElEnts.length > 0;

  if (!hasSwaps && !hasLeave) {
    if(statusEl){ statusEl.textContent=' No SL/EL entries or swaps to apply.'; statusEl.style.color='#ffaa55'; }
    return;
  }

  if(statusEl){ statusEl.textContent = '⏳ Applying leave marks and swaps…'; statusEl.style.color='var(--tx3)'; }

  // Deep-clone schedule data
  const rClone = {};
  Object.entries(_slElRosterData).forEach(([k,v]) => { rClone[k] = {...v}; });
  const metaClone = (_slElEmpMeta||[]).map(e => ({...e}));

  // ── STEP 1: Mark SL / EL across the ENTIRE declared range ─────────
  // Runs unconditionally — regardless of whether a swap was selected.
  // Dates marked "No Action Needed" (_noActionDates) are skipped entirely.
  let leaveMarked = 0;
  slElEnts.forEach(entry => {
    const absentKey = entry.name.toLowerCase();
    if (!rClone[absentKey]) rClone[absentKey] = {};
    entry.dates.forEach(dStr => {
      if (_noActionDates.has(absentKey + '::' + dStr)) return;
      rClone[absentKey][dStr] = entry.type;   // 'SL' or 'EL'
      leaveMarked++;
    });
  });

  // ── STEP 2: Apply pending swaps ────────────────────────────────────
  // Cover employee receives the absent employee's shift for each swap date.
  // Dates marked "No Action Needed" are skipped (SL/EL from step 1 still applied).
  let appliedCount = 0, skippedCount = 0;
  const swapLog = [];
  Object.values(_slElPendingSwaps).forEach(sw => {
    const { coverName, dStr, absentKey, absentShift } = sw;
    if (_noActionDates.has(absentKey + '::' + dStr)) { skippedCount++; return; }

    // Cover employee: assign the absent employee's shift
    const coverKey = coverName.toLowerCase();
    if (!rClone[coverKey]) rClone[coverKey] = {};
    rClone[coverKey][dStr] = absentShift;

    // Find the leave type for the swap log
    const matchEntry = slElEnts.find(e =>
      e.name.toLowerCase() === absentKey && e.dates.includes(dStr));
    const leaveType = matchEntry ? matchEntry.type : 'SL';

    swapLog.push({ date: dStr, absentEmployee: absentKey, leaveType,
                   coverEmployee: coverName, shiftCovered: absentShift });
    appliedCount++;
  });

  // Nothing written at all → nothing to download
  if (leaveMarked === 0 && appliedCount === 0) {
    if(statusEl){
      statusEl.textContent = skippedCount > 0
        ? '✓ All selected dates are marked No Action Needed — no changes made.'
        : '⚠ Nothing to apply.';
      statusEl.style.color = '#ffaa55';
    }
    return;
  }

  // ── Build and download all three outputs ──────────────────────────
  const { xlsxBlob, jsonBlob, htmlBlob, baseFilename } =
    await slElBuildOutputs(metaClone, rClone, swapLog);

  const dl = (blob, name, mime) => {
    const url = URL.createObjectURL(new Blob([blob], {type: mime}));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  dl(xlsxBlob, baseFilename + '.xlsx',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await new Promise(r => setTimeout(r, 300));
  dl(jsonBlob, baseFilename + '.json', 'application/json');
  await new Promise(r => setTimeout(r, 300));
  dl(htmlBlob, baseFilename + '-roster.html', 'text/html;charset=utf-8');

  // ── Cache for Publish the Roster ───────────────────────────────
  // Decode the Uint8Array back to a string so publishRoster() can POST it.
  _lastSlElHtml    = new TextDecoder().decode(htmlBlob);
  _lastSlElTitle   = baseFilename;
  _lastPublishSource = 'slel';     // Publish will use this Re-Modified HTML
  _updatePublishCard();
  _setPublishBtn(true);

  _slElPendingSwaps = {};

  const parts = [];
  if (leaveMarked > 0)  parts.push(leaveMarked  + ' date' + (leaveMarked!==1?'s':'')  + ' marked SL/EL');
  if (appliedCount > 0) parts.push(appliedCount + ' swap'  + (appliedCount!==1?'s':'') + ' applied');
  if (skippedCount > 0) parts.push(skippedCount + ' skipped (No Action)');

  if(statusEl){
    statusEl.textContent = '✓ ' + parts.join(', ') + ' — Excel, JSON and HTML downloaded.';
    statusEl.style.color = '#22c55e';
  }
  setTimeout(() => { if(statusEl){ statusEl.textContent=''; statusEl.style.color='var(--tx3)'; }}, 6000);
}

// ── Build all three output blobs from modified schedules ─────────
async function slElBuildOutputs(empMeta, rosterMap, swapLog) {
  const wb = XLSX.utils.book_new();
  const ws = {};

  const allDates = new Set();
  Object.values(rosterMap).forEach(sched => {
    Object.keys(sched).forEach(k => { if (/^\d{2}-\d{2}-\d{4}$/.test(k)) allDates.add(k); });
  });
  const sortedDates = [...allDates].sort((a,b) => {
    const p = s => { const [dd,mm,yyyy]=s.split('-'); return new Date(+yyyy,+mm-1,+dd); };
    return p(a)-p(b);
  });

  const SF ={M:'FF7ED084',A:'FFE9E7B8',N:'FFE1B79D',E:'FFB7C4D3',E1:'FFB7C4D3',
             G:'FFD5B2D5',W:'FFD9D9D9',AH:'FF8B0000',LH:'FF8B0000',
             PL:'FF8B0000',CO:'FF003366',SL:'FF8B0000',EL:'FF8B0000',ADHOC:'FFFFE0CC'};
  const SFG={AH:'FFFFFFFF',LH:'FFFFFFFF',PL:'FFFFFFFF',CO:'FFFFFFFF',
             SL:'FFFFFFFF',EL:'FFFFFFFF'};
  const SB ={AH:true,LH:true,PL:true,CO:true,SL:true,EL:true};
  const CN='FF1F3864',CB='FF2E75B6',CG='FFD6E4F7',CR0='FFFFFFFF',CR1='FFEBF3FB';
  const CHB='FFFFE6E6',CHF='FFCC0000',CWB='FFF2F2F2',CSF='FFBBBBBB';
  const CMB='FF1A56A0',CMF='FFFFFFFF';
  const DAYS_S=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const FM=['January','February','March','April','May','June',
            'July','August','September','October','November','December'];

  const mkCe=(v,fg,bg,bold,sz,wrap)=>({v:v??'',t:typeof v==='number'?'n':'s',
    s:{font:{name:'Calibri',color:{rgb:fg||'FF000000'},bold:!!bold,sz:sz||9},
       fill:{fgColor:{rgb:bg||'FFFFFFFF'},patternType:'solid'},
       alignment:{horizontal:'center',vertical:'center',wrapText:!!wrap}}});
  const mkLe=(v,fg,bg,bold,sz)=>({v:v??'',t:'s',
    s:{font:{name:'Calibri',color:{rgb:fg||'FF000000'},bold:!!bold,sz:sz||9},
       fill:{fgColor:{rgb:bg||'FFFFFFFF'},patternType:'solid'},
       alignment:{horizontal:'left',vertical:'center'}}});
  const cLe=c=>{let s='';c++;while(c>0){s=String.fromCharCode(65+(c-1)%26)+s;c=Math.floor((c-1)/26);}return s;};
  const sce=(r,c,cell)=>{ws[cLe(c)+(r+1)]=cell;};

  const numDC=sortedDates.length, totalCols=5+numDC, lastColE=cLe(totalCols-1);
  const accountName=(document.getElementById('accountNameInput')?.value||'').trim();
  const managerName=(document.getElementById('managerNameInput')?.value||'').trim();
  const uniqM=[...new Set(sortedDates.map(d=>{const[,mm,yy]=d.split('-');return FM[+mm-1]+' '+yy;}))];
  const titleStr=(accountName?accountName+' \u2013 ':'')
    + 'Shift Roster \u2014 '+uniqM.join(' \u2013 ')+' [Re-Modified]';
  const legendStr='M=Morning  A=Afternoon  N=Night  E=Evening  E1=Evening-1  G=General'
    +'  W=Week Off  SL=Sick Leave  EL=Emergency Leave  AH/LH/PL/CO=Unavailable';

  ws['!merges']=[];
  ws['!merges'].push({s:{r:0,c:0},e:{r:0,c:totalCols-1}});
  ws['!merges'].push({s:{r:1,c:0},e:{r:1,c:totalCols-1}});
  sce(0,0,mkLe(titleStr,'FFFFFFFF',CN,true,14));
  sce(1,0,mkLe(legendStr,'FFFFFFFF',CB,false,9));

  // Month band
  ws['!merges'].push({s:{r:2,c:0},e:{r:2,c:4}});
  sce(2,0,mkCe('',CMF,CMB,false,10));
  const mSpE=[];
  sortedDates.forEach((d,di)=>{
    const[,mm,yy]=d.split('-'),m=+mm-1,y=+yy,dc=5+di;
    const last=mSpE[mSpE.length-1];
    if(last&&last.m===m&&last.y===y){last.end=dc;}else{mSpE.push({m,y,start:dc,end:dc});}
  });
  mSpE.forEach(s=>{
    if(s.start<s.end)ws['!merges'].push({s:{r:2,c:s.start},e:{r:2,c:s.end}});
    sce(2,s.start,mkCe(FM[s.m]+' '+s.y,CMF,CMB,true,10));
  });

  // Column headers
  ['Name','Email','Skill','Location','Shift'].forEach((h,ci)=>sce(3,ci,mkCe(h,'FFFFFFFF',CN,true,10)));
  sortedDates.forEach((d,di)=>{
    const[dd,mm,yy]=d.split('-'),dt=new Date(+yy,+mm-1,+dd),dow=dt.getDay();
    const isSat=dow===6,isSun=dow===0;
    const bg=isSat?CHB:isSun?CWB:CN, fg=isSat?CHF:isSun?CSF:'FFFFFFFF';
    sce(3,5+di,mkCe(parseInt(dd)+'\n'+DAYS_S[dow],fg,bg,true,8,true));
  });

  // Build fast lookup: "nameKey::date" → swapLog entry (for cover employee cells)
  // The cover employee's cell gets purple fill + a note explaining the swap.
  // PL cells are never overridden.
  const SWAP_PURPLE_BG = 'FFADD8E6';   // light blue fill for swapped shift
  const SWAP_PURPLE_FG = 'FF1A1A5E';   // dark navy text on light blue
  const swapCellMap = {};
  (swapLog || []).forEach(sw => {
    const key = sw.coverEmployee.toLowerCase() + '::' + sw.date;
    swapCellMap[key] = sw;
  });

  // Data rows
  const skillOrder=[...new Set(empMeta.map(e=>e.skill))];
  let rowIdx=4;
  skillOrder.forEach(skill=>{
    const grp=empMeta.filter(e=>e.skill===skill);
    if(!grp.length)return;
    ws['!merges'].push({s:{r:rowIdx,c:0},e:{r:rowIdx,c:totalCols-1}});
    sce(rowIdx,0,mkLe('  '+skill,'FF1F3864',CG,true,10));
    rowIdx++;
    grp.forEach(({name,email,skill:sk,location},ep)=>{
      const rb=ep%2===0?CR0:CR1,sched=rosterMap[name.toLowerCase()]||{};
      sce(rowIdx,0,mkLe(name,'FF000000',rb,false,9));
      sce(rowIdx,1,mkLe(email,'FF000000',rb,false,9));
      sce(rowIdx,2,mkLe(sk,'FF000000',rb,false,9));
      sce(rowIdx,3,mkLe(location,'FF000000',rb,false,9));
      sce(rowIdx,4,mkLe(sched.__fixedShift||'','FF000000',rb,false,9));
      sortedDates.forEach((d,di)=>{
        const val=sched[d]||'';
        const swapKey = name.toLowerCase() + '::' + d;
        const swapEntry = swapCellMap[swapKey];

        // Determine fill/font — swap cells get purple unless value is PL
        let bg, fg, bold;
        if (swapEntry && val !== 'PL') {
          // Cover employee's swapped shift: purple override
          bg   = SWAP_PURPLE_BG;
          fg   = SWAP_PURPLE_FG;
          bold = true;
        } else {
          bg   = (val in SF) ? SF[val] : rb;
          fg   = SFG[val] || 'FF000000';
          bold = !!SB[val];
        }

        const cell = mkCe(val, fg, bg, bold, 9);

        // Cell notes removed — swap details are in the Summary sheet instead

        sce(rowIdx, 5+di, cell);
      });
      rowIdx++;
    });
  });

  if(accountName||managerName){
    const fp=[accountName&&'Account: '+accountName,managerName&&'Manager: '+managerName].filter(Boolean).join('   \u2502   ');
    ws['!merges'].push({s:{r:rowIdx,c:0},e:{r:rowIdx,c:totalCols-1}});
    sce(rowIdx,0,mkLe(fp,'FFAAAAAA','FF1A1F2E',false,9));
    rowIdx++;
  }
  ws['!ref']='A1:'+lastColE+rowIdx;
  ws['!cols']=[{wch:26},{wch:24},{wch:22},{wch:12},{wch:8},...sortedDates.map(()=>({wch:4.2}))];
  const rhE=[{hpt:28},{hpt:18},{hpt:16},{hpt:30}];
  for(let i=4;i<rowIdx;i++)rhE.push({hpt:18});
  ws['!rows']=rhE;
  XLSX.utils.book_append_sheet(wb, ws, 'Shift Roster (Modified)');

  // ── Sheet 2: Summary — matches generateRoster structure exactly ──
  // The existing summary section (shift counts per employee) is written first,
  // then SL/EL swap details are appended below without touching existing content.
  {
    const sumWs2 = {};
    const sumHdrs = ['Name','Skill','Shift','M(Morning)','A(Afternoon)','N(Night)','E(Evening)','E1(Eve-1)','G(General)','W(WeekOff)','AH(Acct Hol)','LH(Loc Hol)','PL','CO','ADHOC','Working Days'];
    const C_NAVY2 = '1F3864', C_BLUE2 = '2E75B6';
    const C_ROW02 = 'FFFFFFFF', C_ROW12 = 'FFEBF3FB';
    const mkLC2 = (v,fg,bg,bold,sz) => ({v:v??'',t:typeof v==='number'?'n':'s',s:{font:{name:'Calibri',color:{rgb:fg||'FF000000'},bold:!!bold,sz:sz||9},fill:{fgColor:{rgb:bg||'FFFFFFFF'},patternType:'solid'},alignment:{horizontal:'left',vertical:'center'}}});
    const mkCC2 = (v,fg,bg,bold,sz) => ({v:v??'',t:typeof v==='number'?'n':'s',s:{font:{name:'Calibri',color:{rgb:fg||'FF000000'},bold:!!bold,sz:sz||9},fill:{fgColor:{rgb:bg||'FFFFFFFF'},patternType:'solid'},alignment:{horizontal:'center',vertical:'center'}}});
    const colLtr = ci => ci < 26 ? String.fromCharCode(65+ci) : 'A'+String.fromCharCode(65+(ci-26));
    const setCell = (r,ci,cell) => { sumWs2[colLtr(ci)+(r+1)] = cell; };

    // ── Existing Summary section (title + header + employee rows) ──
    sumWs2['!merges'] = [{s:{r:0,c:0},e:{r:0,c:sumHdrs.length-1}}];
    sumWs2['A1'] = mkLC2(
      (accountName ? accountName + '\u2013 ' : '') + 'Shift Distribution Summary \u2014 ' + uniqM.join(' \u2013 '),
      'FFFFFFFF', CN, true, 13
    );
    // Header row
    sumHdrs.forEach((h, ci) => { setCell(1, ci, mkCC2(h, 'FFFFFFFF', CB, true, 10)); });

    // Employee data rows
    const empRows = empMeta.map((emp, i) => {
      const sched = rosterMap[emp.name.toLowerCase()] || {};
      const counts = {};
      sortedDates.forEach(d => { const v = sched[d]||''; counts[v] = (counts[v]||0)+1; });
      const working = sortedDates.filter(d => {
        const v = sched[d]||''; return v && !['W','AH','LH','PL','CO','SL','EL',''].includes(v);
      }).length;
      return { emp, counts, working };
    });

    empRows.forEach(({ emp, counts, working }, i) => {
      const rb = i%2===0 ? C_ROW02 : C_ROW12;
      const row = i + 2; // 0-indexed: row 2 = Excel row 3
      const vals = [emp.name, emp.skill, rosterMap[emp.name.toLowerCase()]?.__fixedShift||'',
        counts['M']||0, counts['A']||0, counts['N']||0, counts['E']||0, counts['E1']||0,
        counts['G']||0, counts['W']||0, counts['AH']||0, counts['LH']||0,
        counts['PL']||0, counts['CO']||0, counts['ADHOC']||0, working];
      vals.forEach((v, ci) => {
        const bg = (() => {
          if (ci >= 3 && v > 0) {
            if (ci === 9)  return 'FFD9D9D9';
            if (ci === 10) return 'FFFF4444';
            if (ci === 11) return 'FFFF7777';
            if (ci === 12) return 'FFFFCCCC';
            if (ci === 13) return 'FFFFAAAA';
            if (ci === 14) return 'FFFFE0CC';
          }
          return rb;
        })();
        const fg = (ci === 10 && v > 0) ? 'FFFFFFFF' : 'FF000000';
        setCell(row, ci, ci < 3 ? mkLC2(v,'FF000000',rb,false,9) : mkCC2(v||'',fg,bg,false,9));
      });
    });

    const lastEmpRow = empRows.length + 2; // 0-indexed

    // Footer (account/manager) — mirrors generateRoster
    let footerRow = lastEmpRow;
    const footerParts = [];
    if (accountName) footerParts.push('Account: ' + accountName);
    if (managerName) footerParts.push('Manager: ' + managerName);
    if (footerParts.length) {
      sumWs2['!merges'].push({s:{r:footerRow,c:0},e:{r:footerRow,c:sumHdrs.length-1}});
      sumWs2[colLtr(0) + (footerRow+1)] = mkLC2(footerParts.join('   \u2502   '),'FFAAAAAA','FF1A1F2E',false,9);
      footerRow++;
    }

    // ── SL/EL Swap Details — appended below existing content ──────
    // Two blank separator rows, then the swap section.
    let appendRow = footerRow + 2;

    if ((swapLog || []).length > 0) {
      // Section header
      sumWs2['!merges'].push({s:{r:appendRow,c:0},e:{r:appendRow,c:sumHdrs.length-1}});
      sumWs2[colLtr(0)+(appendRow+1)] = mkLC2('SL / EL \u2014 Absence & Coverage Swap Details','FFFFFFFF',CN,true,11);
      appendRow++;

      // Sub-header: format note
      sumWs2['!merges'].push({s:{r:appendRow,c:0},e:{r:appendRow,c:sumHdrs.length-1}});
      sumWs2[colLtr(0)+(appendRow+1)] = mkLC2(
        'Format: On absence of \u201cEmployee Name\u201d on SL/EL, swap done from <original shift> to <covered shift> (Period).',
        'FF555555', 'FFF0F0F0', false, 8
      );
      appendRow++;

      // Column headers for swap table
      const swapHdrs = ['Date','Absent Employee','Leave Type','Cover Person','Shift Covered','Note'];
      swapHdrs.forEach((h, ci) => { sumWs2[colLtr(ci)+(appendRow+1)] = mkCC2(h,'FFFFFFFF',CB,true,9); });
      appendRow++;

      // Swap rows
      swapLog.forEach((sw, si) => {
        const rb = si%2===0 ? 'FFFFFFFF' : 'FFF5F5F5';
        const absentDisplay = sw.absentEmployee.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
        const coverDisplay  = sw.coverEmployee.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
        const [dd,mm,yy] = sw.date.split('-');
        const dtObj   = new Date(+yy,+mm-1,+dd);
        const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dtObj.getDay()];
        const period  = dd+'-'+FM[+mm-1]+'-'+yy+' ('+dayName+')';
        const origCoverSched = (_slElRosterData && _slElRosterData[sw.coverEmployee.toLowerCase()]) || {};
        const coverOrigShift = origCoverSched[sw.date] || '—';
        const noteText = 'On absence of "'+absentDisplay+'" on '+sw.leaveType+', swap done from '+coverOrigShift+' to '+sw.shiftCovered+' ('+period+').';

        const leaveBg = sw.leaveType==='SL' ? SF.SL : SF.EL;
        const vals2 = [
          { v:sw.date,       bg:rb,              fg:'FF000000', bold:false },
          { v:absentDisplay, bg:rb,              fg:'FF000000', bold:false },
          { v:sw.leaveType,  bg:leaveBg,         fg:'FFFFFFFF', bold:true  },
          { v:coverDisplay,  bg:SWAP_PURPLE_BG,  fg:SWAP_PURPLE_FG, bold:true },
          { v:sw.shiftCovered, bg:SWAP_PURPLE_BG, fg:SWAP_PURPLE_FG, bold:true },
          { v:noteText,      bg:rb,              fg:'FF333333', bold:false },
        ];
        vals2.forEach(({v,bg,fg,bold},ci)=>{
          const cell = ci<2||ci===5 ? mkLC2(v,fg,bg,bold,9) : mkCC2(v,fg,bg,bold,9);
          sumWs2[colLtr(ci)+(appendRow+1)] = cell;
        });
        appendRow++;
      });
    } else {
      sumWs2['!merges'].push({s:{r:appendRow,c:0},e:{r:appendRow,c:sumHdrs.length-1}});
      sumWs2[colLtr(0)+(appendRow+1)] = mkLC2('No SL/EL swaps applied.','FF888888','FFFFFFFF',false,9);
      appendRow++;
    }

    sumWs2['!ref'] = 'A1:' + colLtr(Math.max(sumHdrs.length-1, 5)) + (appendRow+1);
    sumWs2['!cols'] = [{wch:26},{wch:22},{wch:7},{wch:10},{wch:11},{wch:9},{wch:10},{wch:9},{wch:10},{wch:9},{wch:9},{wch:9},{wch:7},{wch:5},{wch:8},{wch:12}];
    const sh2 = [{hpt:26},{hpt:22}];
    for (let i=0; i<empRows.length; i++) sh2.push({hpt:16});
    if (footerParts.length) sh2.push({hpt:16});
    sh2.push({hpt:4},{hpt:4}); // blank separators
    sh2.push({hpt:22});        // section header
    sh2.push({hpt:16});        // sub-header
    sh2.push({hpt:20});        // swap column headers
    (swapLog||[]).forEach(()=>sh2.push({hpt:18})); // swap data rows
    sumWs2['!rows'] = sh2;

    XLSX.utils.book_append_sheet(wb, sumWs2, 'Summary');
  }

  // ── Sheet 3: Legend — exact mirror of generateRoster's Legend sheet ──
  {
    const legWs2 = {};
    const C_NAVY2 = CN, C_BLUE2 = CB;
    legWs2['!merges'] = [{s:{r:0,c:0},e:{r:0,c:2}}];
    const mkLC3 = (v,fg,bg,bold,sz)=>({v:v??'',t:'s',s:{font:{name:'Calibri',color:{rgb:fg||'FF000000'},bold:!!bold,sz:sz||9},fill:{fgColor:{rgb:bg||'FFFFFFFF'},patternType:'solid'},alignment:{horizontal:'left',vertical:'center'}}});
    const mkCC3 = (v,fg,bg,bold,sz)=>({v:v??'',t:'s',s:{font:{name:'Calibri',color:{rgb:fg||'FF000000'},bold:!!bold,sz:sz||9},fill:{fgColor:{rgb:bg||'FFFFFFFF'},patternType:'solid'},alignment:{horizontal:'center',vertical:'center'}}});
    legWs2['A1'] = mkLC3('Shift Codes \u0026 Colour Legend','FFFFFFFF',CN,true,12);
    ['Code','Description','Colour'].forEach((h,ci)=>{
      legWs2[String.fromCharCode(65+ci)+'2'] = mkCC3(h,'FFFFFFFF',CB,true,10);
    });
    const legRows2 = [
      ['M',     'Morning (05:30\u201314:30)',        'FFFFF2CC','FF000000'],
      ['A',     'Afternoon (13:30\u201322:30)',       'FFDDEBF7','FF000000'],
      ['N',     'Night (21:30\u201306:30)',           'FFE2EFDA','FF000000'],
      ['E',     'Evening (17:30\u201302:30)',         'FFFCE4D6','FF000000'],
      ['E1',    'Evening-1 (19:30\u201304:30)',       'FFF8D7F0','FF000000'],
      ['G',     'General (9:30 AM\u20136:30 PM)',     'FFFFF2CC','FF000000'],
      ['PL',    'Planned Leave \u2014 RED (unavailable)','FFFFCCCC','FF800000'],
      ['CO',    'Comp-Off \u2014 RED (unavailable)',  'FFFFAAAA','FF7B0000'],
      ['AH',    'Account Holiday \u2014 RED (unavailable)','FFFF4444','FFFFFFFF'],
      ['LH',    'Local Holiday \u2014 RED (unavailable)',  'FFFF7777','FFFFFFFF'],
      ['ADHOC', 'Adhoc / On-call Shift',             'FFFFE0CC','FF000000'],
      ['W',     'Week Off',                          'FFD9D9D9','FF000000'],
      ['SWAP',  'SL/EL Swapped Shift (Cover Person)', SWAP_PURPLE_BG, SWAP_PURPLE_FG],
    ];
    legRows2.forEach(([code,desc,bg,fg],i)=>{
      const r = i+3;
      legWs2['A'+r] = mkCC3(code,fg,bg,true,10);
      legWs2['B'+r] = mkLC3(desc,'FF000000','FFFFFFFF',false,9);
      legWs2['C'+r] = mkCC3('',fg,bg,false,9);
    });
    legWs2['!ref']  = 'A1:C'+(legRows2.length+2);
    legWs2['!cols'] = [{wch:8},{wch:40},{wch:16}];
    const lh2 = [{hpt:24},{hpt:20}];
    for (let i=0;i<legRows2.length;i++) lh2.push({hpt:20});
    legWs2['!rows'] = lh2;
    XLSX.utils.book_append_sheet(wb, legWs2, 'Legend');
  }

  const safeA=accountName?accountName.replace(/[\/\\:*?"<>|]/g,'').trim()+' - ':'';
  const dp=new Date().toISOString().slice(0,10).replace(/-/g,'');
  const baseFilename = safeA + 'Shift Roster Modified - ' + dp;

  // Excel blob
  const xlsxBuf = XLSX.write(wb, { bookType:'xlsx', type:'array', cellStyles:true });
  const xlsxBlob = new Uint8Array(xlsxBuf);

  // JSON blob
  const jsonPayload = {
    generated:    new Date().toISOString(),
    title:        titleStr,
    accountName:  accountName || '',
    managerName:  managerName || '',
    swapsApplied: swapLog,
    employees:    empMeta.map(emp => {
      const sched  = rosterMap[emp.name.toLowerCase()] || {};
      const counts = {};
      sortedDates.forEach(d => { const v=sched[d]||''; counts[v]=(counts[v]||0)+1; });
      return { name:emp.name, email:emp.email, skill:emp.skill, location:emp.location,
               fixedShift:sched.__fixedShift||'', dailySchedule:
               Object.fromEntries(sortedDates.map(d=>[d,sched[d]||''])),
               shiftCounts:counts };
    })
  };
  const jsonBlob = new TextEncoder().encode(JSON.stringify(jsonPayload, null, 2));

  // HTML blob — self-contained viewer
  const _sc = '<\/script>';
  const shiftCSSMap = {M:'#7ED084',A:'#E9E7B8',N:'#E1B79D',E:'#B7C4D3',E1:'#B7C4D3',
                       G:'#D5B2D5',W:'#D9D9D9',AH:'#8B0000',LH:'#8B0000',
                       PL:'#8B0000',CO:'#003366',SL:'#8B0000',EL:'#8B0000',ADHOC:'#FFE0CC'};
  const shiftFGMap  = {AH:'#fff',LH:'#fff',PL:'#fff',CO:'#fff',SL:'#fff',EL:'#fff'};

  // Build HTML table rows
  const empsBySkill = {};
  empMeta.forEach(e => { if(!empsBySkill[e.skill])empsBySkill[e.skill]=[]; empsBySkill[e.skill].push(e); });
  const totalColsH = 5 + sortedDates.length;

  let tRows = '';
  Object.entries(empsBySkill).forEach(([skill, emps]) => {
    tRows += '<tr><td colspan="'+totalColsH+'" style="background:#d6e4f7;font-weight:700;padding:4px 8px;font-size:11px">'+esc(skill)+'</td></tr>';
    emps.forEach((emp, ei) => {
      const rb = ei%2===0?'#fff':'#ebf3fb';
      const sched = rosterMap[emp.name.toLowerCase()]||{};
      tRows += '<tr style="background:'+rb+'">'
        + '<td style="padding:4px 8px;font-weight:500">'+esc(emp.name)+'</td>'
        + '<td style="padding:4px 8px;color:#555;font-size:10px">'+esc(emp.email)+'</td>'
        + '<td style="padding:4px 8px;font-size:10px">'+esc(emp.skill)+'</td>'
        + '<td style="padding:4px 8px;font-size:10px">'+esc(emp.location)+'</td>'
        + '<td style="padding:4px 8px;text-align:center;font-size:10px">'+esc(sched.__fixedShift||'')+'</td>'
        + sortedDates.map(d=>{
            const v=sched[d]||'';
            const bg=shiftCSSMap[v]||rb;
            const fg=shiftFGMap[v]||'#111';
            return '<td style="padding:2px 4px;text-align:center;font-size:9px;font-weight:600;background:'+bg+';color:'+fg+'">'+esc(v)+'</td>';
          }).join('')
        + '</tr>';
    });
  });

  // Month header row
  let mHdrCells = '<th colspan="5"></th>';
  mSpE.forEach(s => {
    const span = s.end - s.start + 1;
    mHdrCells += '<th colspan="'+span+'" style="background:#1a56a0;color:#fff;font-weight:700;font-size:10px;padding:4px 8px">'+FM[s.m]+' '+s.y+'</th>';
  });

  // Swap log section
  const swapRows = swapLog.map(s =>
    '<tr><td>'+esc(s.date)+'</td><td>'+esc(s.absentEmployee)+'</td>'
    + '<td><span style="background:#8B0000;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px">'+esc(s.leaveType)+'</span></td>'
    + '<td>'+esc(s.coverEmployee)+'</td>'
    + '<td><span style="background:'+shiftCSSMap[s.shiftCovered]+'||#eee;padding:1px 6px;border-radius:3px;font-size:10px">'+esc(s.shiftCovered)+'</span></td>'
    + '</tr>'
  ).join('');

  const htmlContent = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>'+esc(titleStr)+'</title>\n'
    + '<style>*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:Calibri,Arial,sans-serif;font-size:11px;background:#f0f2f5;color:#111;padding:16px}'
    + '.tabs{display:flex;gap:4px;margin-bottom:0;border-bottom:2px solid #1f3864}'
    + '.tab-btn{padding:7px 18px;border:none;border-radius:4px 4px 0 0;cursor:pointer;font-size:11px;font-weight:600;background:#dde4ef;color:#444}'
    + '.tab-btn.active{background:#1f3864;color:#fff}'
    + '.tab-pane{display:none;padding:16px 0 0 0}.tab-pane.active{display:block}'
    + '.tbl-wrap{overflow-x:auto;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.15)}'
    + 'table{border-collapse:collapse;white-space:nowrap}'
    + 'th,td{border:1px solid #c8d0dc;padding:3px 6px}'
    + '.title-row{background:#1f3864;color:#fff;font-weight:700;font-size:14px;text-align:left;padding:6px 10px}'
    + '.legend-row{background:#2e75b6;color:#fff;font-size:9px;text-align:left;padding:4px 10px}'
    + '.hdr-row th{background:#1f3864;color:#fff;font-weight:600;font-size:10px;position:sticky;top:0;z-index:2}'
    + '.swp-table th{background:#2e75b6;color:#fff;font-weight:600;font-size:10px;padding:5px 8px}'
    + '.swp-table td{padding:5px 8px;font-size:10px;border-bottom:1px solid #ddd}'
    + '</style>\n</head>\n<body>\n'
    + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">'
    + '<div style="font-size:18px;font-weight:700;color:#1f3864">'+esc(titleStr)+'</div>'
    + '</div>\n'
    + '<div class="tabs">'
    + '<button class="tab-btn active" onclick="showTab(\'roster\')"> Shift Roster</button>'
    + '<button class="tab-btn" onclick="showTab(\'swaps\')"> Swaps Applied ('+swapLog.length+')</button>'
    + '</div>\n'
    + '<div id="tab-roster" class="tab-pane active"><div class="tbl-wrap"><table>'
    + '<thead>'
    + '<tr><th class="title-row" colspan="'+totalColsH+'">'+esc(titleStr)+'</th></tr>'
    + '<tr><th class="legend-row" colspan="'+totalColsH+'">'+esc(legendStr)+'</th></tr>'
    + '<tr>'+mHdrCells+'</tr>'
    + '<tr class="hdr-row"><th>Name</th><th>Email</th><th>Skill</th><th>Location</th><th>Shift</th>'
    + sortedDates.map(d=>{
        const[dd,mm,yy]=d.split('-'),dt=new Date(+yy,+mm-1,+dd),dow=dt.getDay();
        const isSat=dow===6,isSun=dow===0;
        const col=isSat?'#cc0000':isSun?'#aaa':'#fff';
        return '<th style="width:28px;font-size:8px;color:'+col+'">'+parseInt(dd)+'<br><span style="font-weight:400">'+DAYS_S[dow]+'</span></th>';
      }).join('')+'</tr>'
    + '</thead><tbody>'+tRows+'</tbody></table></div></div>\n'
    + '<div id="tab-swaps" class="tab-pane">'
    + '<table class="swp-table" style="margin-top:8px;min-width:500px">'
    + '<thead><tr><th>Date</th><th>Absent Employee</th><th>Leave Type</th><th>Cover Person</th><th>Shift Covered</th></tr></thead>'
    + '<tbody>'+swapRows+'</tbody>'
    + '</table></div>\n'
    + '<script>\nfunction showTab(id){\n'
    + '  document.querySelectorAll(\'.tab-pane\').forEach(function(p){p.classList.remove(\'active\');});\n'
    + '  document.querySelectorAll(\'.tab-btn\').forEach(function(b){b.classList.remove(\'active\');});\n'
    + '  document.getElementById(\'tab-\'+id).classList.add(\'active\');\n'
    + '  event.target.classList.add(\'active\');\n}\n'
    + _sc + '\n</body>\n</html>';

  const htmlBlob = new TextEncoder().encode(htmlContent);
  return { xlsxBlob, jsonBlob, htmlBlob, baseFilename };
}

// ── Shift cell background colour ─────────────────────────────────
function slElShiftBg(shift) {
  const map={M:'#7ED084',A:'#E9E7B8',N:'#E1B79D',E:'#B7C4D3',E1:'#B7C4D3',
             G:'#D5B2D5',W:'#D9D9D9',AH:'#8B0000',LH:'#8B0000',
             PL:'#8B0000',CO:'#003366',SL:'#8B0000',EL:'#8B0000'};
  return map[shift]||'#333';
}
let promptRules  = [];   // [{skill, count, alloc, rotation, weekoff, conditions}]
let _promptMode  = false; // true = "Go With Prompt" is active
let _automationMode = false; // true = "Go With Automation" is active

/* Toggle automation mode — mutually exclusive with prompt mode */
function toggleAutomationMode() {
  _automationMode = !_automationMode;
  if (_automationMode && _promptMode) {
    _promptMode = false;
    _applyPromptModeUI();
  }
  _applyAutomationModeUI();
}

/* Activate automation mode.
   Turns on the mode, dims the Prompt card, and ensures the table is visible
   so the manager can review/edit allocations before clicking Generate. */
function activateAutomation() {
  if (_automationMode) {
    // Already active — toggle off
    _automationMode = false;
    _applyAutomationModeUI();
    return;
  }
  if (_promptMode) { _promptMode = false; _applyPromptModeUI(); }
  _automationMode = true;
  _applyAutomationModeUI();
  // Scroll the table into view so manager can review before generating
  const tbl = document.getElementById('rulesTable');
  if (tbl) tbl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Activate prompt mode.
   Turns on the mode, dims the Automation card, and focuses the textarea
   so the manager can enter/review rules before clicking Generate. */
function activatePrompt() {
  if (_promptMode) {
    _promptMode = false;
    _applyPromptModeUI();
    return;
  }
  if (_automationMode) { _automationMode = false; _applyAutomationModeUI(); }
  _promptMode = true;
  _applyPromptModeUI();
  // Focus the prompt textarea for immediate editing
  const ta = document.getElementById('promptInput');
  if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); ta.focus(); }
}

function _applyAutomationModeUI() {
  const btn        = document.getElementById('goWithAutomationBtn');
  const promptCard = document.getElementById('promptCard');

  if (_automationMode) {
    if (btn) {
      btn.style.background  = 'linear-gradient(135deg,#16a34a,#22c55e)';
      btn.style.borderColor = '#22c55e';
      btn.style.color       = '#fff';
      btn.textContent       = '✓ Go With Automation';
      btn.setAttribute('aria-pressed', 'true');
    }
    if (promptCard) {
      promptCard.style.opacity       = '0.35';
      promptCard.style.pointerEvents = 'none';
      promptCard.title               = 'Shift Assignments via Prompt is skipped — using Automation rules';
    }
  } else {
    if (btn) {
      btn.style.background  = 'rgba(34,197,94,.12)';
      btn.style.borderColor = 'rgba(34,197,94,.4)';
      btn.style.color       = '#fff';
      btn.textContent       = 'Go With Automation';
      btn.setAttribute('aria-pressed', 'false');
    }
    if (promptCard) {
      promptCard.style.opacity       = '';
      promptCard.style.pointerEvents = '';
      promptCard.title               = '';
    }
  }
  // Refresh preview so source label updates
  if (typeof renderPreview === 'function') renderPreview();
}

/* Toggle prompt mode on/off when the button is clicked */
function togglePromptMode() {
  _promptMode = !_promptMode;
  if (_promptMode && _automationMode) {
    // Turn off automation mode when prompt is activated
    _automationMode = false;
    _applyAutomationModeUI();
  }
  _applyPromptModeUI();
}

function _applyPromptModeUI() {
  const btn            = document.getElementById('goWithPromptBtn');
  const automationCard = document.getElementById('automationCard');

  if (_promptMode) {
    // Button: active/on state — solid green
    if (btn) {
      btn.style.background   = 'linear-gradient(135deg,#16a34a,#22c55e)';
      btn.style.borderColor  = '#22c55e';
      btn.style.color        = '#fff';
      btn.textContent        = '✓ Go With Prompt';
      btn.setAttribute('aria-pressed', 'true');
    }
    // Dim the Automation card
    if (automationCard) {
      automationCard.style.opacity       = '0.35';
      automationCard.style.pointerEvents = 'none';
      automationCard.title               = 'Shift Assignments via Automation is skipped — using Prompt rules';
    }
    // Show status
    const st = document.getElementById('promptStatus');
    if (st) {
      st.textContent  = 'Active — Shift Assignments via Automation is skipped during generation.';
      st.style.color  = '#22c55e';
    }
  } else {
    // Button: off state — muted green outline
    if (btn) {
      btn.style.background   = 'rgba(34,197,94,.12)';
      btn.style.borderColor  = 'rgba(34,197,94,.4)';
      btn.style.color        = '#fff';
      btn.textContent        = 'Go With Prompt';
      btn.setAttribute('aria-pressed', 'false');
    }
    // Restore the Automation card
    if (automationCard) {
      automationCard.style.opacity       = '';
      automationCard.style.pointerEvents = '';
      automationCard.title               = '';
    }
    // Clear status
    const st = document.getElementById('promptStatus');
    if (st) { st.textContent = ''; st.style.color = 'var(--tx3)'; }
  }
  // Refresh preview so source label updates
  if (typeof renderPreview === 'function') renderPreview();
}

/* Normalise a single rotation value string → one of the internal keywords */
/* ─────────────────────────────────────────────────────────────────
 * _normRotation
 * Converts any user-facing rotation label to a canonical internal key.
 *
 * Accepted inputs (case-insensitive, hyphens/spaces flexible):
 *   Weekly / Every Week / Every 1 Week
 *   Biweekly / Bi-Weekly / Every 2 Weeks / Every 2-Weeks
 *   Monthly  / Every Month
 *   Static   / Always   / NA   / None
 * ──────────────────────────────────────────────────────────────── */

let _lastGeneratedHtml  = null;
let _lastGeneratedTitle = null;

// ── Publish source tracking ──────────────────────────────────────────
// Tracks which action ran last so publishRoster() publishes the correct dataset.
// 'generate' = Generate & Download   |  'slel' = Re-Modify the Roster
let _lastPublishSource  = null;
let _lastSlElHtml       = null;   // HTML from most recent Re-Modify
let _lastSlElTitle      = null;   // title string for that HTML

function _setPublishBtn(show) {
  // publishBtn is in its own card and always visible — no show/hide needed
  const btn = document.getElementById('publishBtn');
  if (btn) btn.style.opacity = show ? '1' : '0.55';
}

/* _updatePublishCard — updates the Publish the Roster card subtitle
 * to show which dataset will be published (Generate or Re-Modified). */
function _updatePublishCard() {
  const sub = document.getElementById('publishCardSub');
  if (!sub) return;
  if (_lastPublishSource === 'slel') {
    sub.innerHTML = 'Will publish: <strong style="color:#22c55e">Re-Modified Roster</strong> (SL/EL coverage applied)';
  } else if (_lastPublishSource === 'generate') {
    sub.innerHTML = 'Will publish: <strong style="color:#22c55e">Generated Roster</strong>';
  } else {
    sub.innerHTML = 'Run <em>Generate &amp; Download</em> or <em>Re-Modify the Roster</em> first.';
  }
}

function _tokenInput() {
  return document.getElementById('ghTokenInput');
}
function _getToken() {
  const el = _tokenInput();
  return (el && el.value.trim()) || '';
}
function _tokenStatus(msg, ok) {
  const el = document.getElementById('tokenStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok === true ? '#22c55e' : (ok === false ? '#ff7070' : 'var(--tx3)');
}

async function testGhToken() {
  const token = _getToken();
  if (!token) { _tokenStatus('Enter a token first.', false); return; }
  _tokenStatus('Testing…', null);
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }
    });
    if (r.ok) {
      const u = await r.json();
      _tokenStatus('✓ Token valid — logged in as @' + u.login, true);
    } else {
      _tokenStatus('✗ Invalid token (HTTP ' + r.status + ')', false);
    }
  } catch(e) {
    _tokenStatus('✗ Network error: ' + e.message, false);
  }
}

function clearGhToken() {
  const el = _tokenInput();
  if (el) el.value = '';
  localStorage.removeItem('ss_gh_token');
  _tokenStatus('Token cleared.', null);
  // Hide publish panel and button
  _setPublishBtn(false);
  const panel = document.getElementById('publishPanel');
  if (panel) panel.style.display = 'none';
}

function copyPublishUrl() {
  const el = document.getElementById('publishUrl');
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => {
    const btn = el.nextElementSibling;
    if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => { btn.textContent = orig; }, 1800); }
  }).catch(() => {
    el.select(); document.execCommand('copy');
  });
}

async function publishRoster() {
  // ── Resolve which HTML to publish based on last action ───────────
  // 'generate' → publish the main roster  (_lastGeneratedHtml / _lastGeneratedTitle)
  // 'slel'     → publish the re-modified roster (_lastSlElHtml / _lastSlElTitle)
  const pubHtml  = _lastPublishSource === 'slel' ? _lastSlElHtml  : _lastGeneratedHtml;
  const pubTitle = _lastPublishSource === 'slel' ? _lastSlElTitle : _lastGeneratedTitle;

  if (!pubHtml) {
    const hint = 'Please ' + (_lastPublishSource === 'slel'
      ? 'run Re-Modify the Roster first'
      : 'run Generate & Download or Re-Modify the Roster first')
      + ', then click Publish.';
    alert(hint);
    return;
  }

  const token = _getToken();

  // ── Mobile fallback: Web Share API ─────────────────────────
  if (!token && navigator.share && navigator.canShare) {
    const htmlBlob = new Blob([pubHtml], { type: 'text/html' });
    const file = new File([htmlBlob], (pubTitle || 'roster') + '.html', { type: 'text/html' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: pubTitle || 'Shift Roster', files: [file] });
        return;
      } catch(e) {
        if (e.name !== 'AbortError') console.warn('Share failed:', e);
      }
    }
  }

  if (!token) {
    // Open the publish settings card and prompt
    const pubCard = document.getElementById('card-publish');
    if (pubCard && !pubCard.classList.contains('card-open')) pubCard.classList.add('card-open');
    _tokenStatus('Enter a GitHub Personal Access Token to publish.', false);
    const el = _tokenInput();
    if (el) el.focus();
    return;
  }

  const btn = document.getElementById('publishBtn');
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Publishing…';

  // ── Helper: single Gist POST attempt ─────────────────────────
  async function _attemptGistPost(fileName, payload, token) {
    const resp = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify(payload)
    });
    return resp;
  }

  // ── Helper: human-readable error from GitHub response ────────
  async function _parseGhError(resp) {
    let body = {};
    try { body = await resp.json(); } catch(_) {}
    const status  = resp.status;
    const ghMsg   = (body.message || '').toLowerCase();
    const retryAt = resp.headers.get('x-ratelimit-reset') || resp.headers.get('retry-after');

    if (status === 401 || ghMsg.includes('bad credential') || ghMsg.includes('requires authentication')) {
      return {
        type: 'auth',
        msg: 'Token is invalid or expired. Please generate a new token with the "gist" scope and paste it in.'
      };
    }
    if (status === 403 && (ghMsg.includes('rate limit') || ghMsg.includes('secondary rate'))) {
      const resetMsg = retryAt
        ? ' GitHub resets at ' + new Date(Number(retryAt) * 1000).toLocaleTimeString() + '.'
        : ' Please wait a minute before retrying.';
      return { type: 'ratelimit', msg: 'GitHub rate limit exceeded.' + resetMsg };
    }
    if (status === 403) {
      return {
        type: 'forbidden',
        msg: 'Access denied (HTTP 403). Your token may be missing the "gist" scope, or SSO is not authorised. '
           + (body.message ? 'GitHub says: "' + body.message + '"' : '')
      };
    }
    if (status === 422) {
      return { type: 'validation', msg: 'GitHub rejected the request (HTTP 422). ' + (body.message || '') };
    }
    return {
      type: 'unknown',
      msg: (body.message || 'GitHub API error') + ' (HTTP ' + status + ')'
    };
  }

  try {
    // ── POST to GitHub Gist API (with one auto-retry for rate limit) ──
    const fileName = (pubTitle || 'Shift-Roster').replace(/[\s—–]+/g, '-') + '.html';
    const payload = {
      description: (pubTitle || 'Shift Roster — generated by ShiftScheduler')
        + (_lastPublishSource === 'slel' ? ' [Re-Modified]' : ''),
      public: true,
      files: { [fileName]: { content: pubHtml } }
    };

    let resp = await _attemptGistPost(fileName, payload, token);

    // Auto-retry once after a short delay if secondary rate-limited
    if (!resp.ok) {
      const errInfo = await _parseGhError(resp.clone());
      if (errInfo.type === 'ratelimit') {
        btn.textContent = '⏳ Rate limited — retrying in 12s…';
        await new Promise(res => setTimeout(res, 12000));
        btn.textContent = '⏳ Retrying…';
        resp = await _attemptGistPost(fileName, payload, token);
      }
    }

    if (!resp.ok) {
      const errInfo = await _parseGhError(resp);
      throw new Error(errInfo.msg);
    }

    const gist = await resp.json();

    // ── Build the published URL ──────────────────────────────
    // gist.githack.com serves raw Gist files with correct Content-Type: text/html
    // so self-contained HTML (inline CSS + JS) renders properly in the browser.
    // URL format: https://gist.githack.com/<user>/<gist_id>/raw/<sha>/<filename>
    // Constructed by replacing the githubusercontent.com domain with githack.com
    const rawUrl  = gist.files[fileName]?.raw_url || '';
    const viewUrl = rawUrl
      ? rawUrl.replace('https://gist.githubusercontent.com/', 'https://gist.githack.com/')
      : gist.html_url;

    // Show result panel
    const urlInput = document.getElementById('publishUrl');
    if (urlInput) urlInput.value = viewUrl;
    const panel = document.getElementById('publishPanel');
    if (panel) panel.style.display = 'block';

    btn.textContent = '✓ Published';
    setTimeout(() => { btn.textContent = 'Publish'; }, 3000);

  } catch(e) {
    btn.textContent = origLabel;
    alert('Publish failed:\n\n' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ─── Init ──────────────────────────────────────────────────── */
(function init() {

  // Open step 1 on load (Roster File + Date Range)
  goStep(1);

  // Restore saved GitHub token
  try {
    const saved = localStorage.getItem('ss_gh_token');
    const el = document.getElementById('ghTokenInput');
    if (saved && el) el.value = saved;
  } catch(_) {}

  // Initialise the standalone SL/EL upload zone (separate from roster upload)
  if (typeof initSlElUpload === 'function') initSlElUpload();

  // ── File input: single clean change listener ─────────────────
  // All inline onchange / ondrop / ondragover / ondragleave attributes have been
  // removed from the HTML. We wire everything once here, so each event fires
  // exactly once per user action.
  const fi   = document.getElementById('fileInput');
  const zone = document.getElementById('upzone');

  if (fi) {
    // change: fires when the user picks a file via the browser dialog
    fi.addEventListener('change', function() {
      const f = this.files && this.files[0];
      if (f) handleFile(f);
      // Reset so picking the same file again fires change
      try { this.value = ''; } catch(_) {}
    });
  }

  if (zone) {
    // Drag-over: show highlight
    zone.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      this.classList.add('drag');
    });

    // Drag-leave: remove highlight
    zone.addEventListener('dragleave', function(e) {
      e.stopPropagation();
      this.classList.remove('drag');
    });

    // Drop: handle file drop
    zone.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      this.classList.remove('drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!f.name.toLowerCase().endsWith('.xlsx') && !f.name.toLowerCase().endsWith('.xls')) {
        showUploadErr('Please upload an Excel file (.xlsx or .xls). Got: ' + f.name);
        return;
      }
      handleFile(f);
    });
  }
})();

