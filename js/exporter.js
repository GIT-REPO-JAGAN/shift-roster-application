'use strict';

function countShifts(schedule, adhocDates) {
  const c = { M:0, A:0, N:0, E:0, E1:0, G:0, W:0, AH:0, LH:0, PL:0, CO:0, ADHOC:0, working:0 };
  adhocDates = adhocDates || new Set();
  Object.entries(schedule).forEach(([dStr, v]) => {
    if (adhocDates.has(dStr)) {
      // This day was an adhoc override — count it in ADHOC, not in the shift bucket
      c.ADHOC++;
    } else if (v in c) {
      c[v]++;
    }
  });
  // Working days = every day that is NOT W / AH / LH / PL / CO
  c.working = Object.entries(schedule).filter(([dStr, v]) =>
    !['W','AH','LH','PL','CO'].includes(v)
  ).length;
  return c;
}

/* ─── Progress helpers ──────────────────────────────────────── */

async function generateRoster() {
  const valid = runValidation();
  if (!valid) {
    if (!confirm('There are validation errors. Generate anyway (results may be incomplete)?')) return;
  }

  const genBtn = document.getElementById('genBtn');
  genBtn.disabled = true;

  setProgress(5, 'Reading inputs…');

  // Hard block: prevent generation when any alloc exceeds count (automation mode only)
  // Skip this check when prompt mode is active — prompt validation handles it separately
  if (!_promptMode) {
    for (const r of shiftRules) {
      const t = allocTotal(r.alloc);
      if (t > r.count) {
        showErr(r.skill + ': Over-allocation — allocation total (' + t + ') exceeds count (' + r.count + '). Fix the Shift Allocation field (highlighted red) before generating.');
        setProgress(0, '', '');
        document.getElementById('genBtn').disabled = false;
        return;
      }
    }
  }
  await sleep(30);

  const startD      = new Date(document.getElementById('startDate').value + 'T00:00:00');
  const endD        = new Date(document.getElementById('endDate').value   + 'T00:00:00');
  const accountName = (document.getElementById('accountNameInput')?.value || '').trim();
  const managerName = (document.getElementById('managerNameInput')?.value || '').trim();
  const dates  = datesInRange(startD, endD);
  const ahSet  = getAHSet();
  const lhMap  = getLHMap();

  // ── Rule source: mutual exclusion between Automation and Prompt ──
  // Go With Automation → use shiftRules, ignore promptRules
  // Go With Prompt     → use promptRules, ignore shiftRules
  // Neither active     → use shiftRules (default)
  // Planned Leave / COFF / Adhoc always applied on top regardless.
  parsePromptRules();

  if (_automationMode) {
    // Automation mode: shiftRules only — over-alloc already checked above
    if (!shiftRules.length) {
      showErr('Go With Automation is active but no rules are defined. Please fill in the Shift Assignments via Automation table.');
      genBtn.disabled = false;
      return;
    }
  }

  if (_promptMode && !promptRules.length) {
    showErr('Go With Prompt is active but no valid rules were found in the Prompt section. Please enter at least one skill allocation line, or turn off Go With Prompt.');
    genBtn.disabled = false;
    return;
  }

  const activeRules = _promptMode ? promptRules : _expandAutomationRules(shiftRules);

  if (!activeRules.length) {
    showErr('No shift rules defined. Please fill in the Shift Assignments via Automation table, or use Go With Prompt.');
    genBtn.disabled = false;
    return;
  }

  // Build initial raw schedules for "Week Off: X" shift-type filter
  // (we need the base schedules before overrides to resolve shift-type filters)
  const allRawScheds = {};
  for (const rule of activeRules) {
    // Employee-based rule (_empTarget): find by exact name, ignore skill grouping
    let allEmps;
    if (rule._empTarget) {
      allEmps = rosterData.filter(e => e.name.toLowerCase() === rule._empTarget.toLowerCase());
    } else {
      allEmps = skillGroups[rule.skill] || [];
    }
    if (!allEmps.length) continue;
    const emps = rule._empSlice
      ? allEmps.slice(rule._empSlice.start, rule._empSlice.end)
      : allEmps;
    if (!emps.length) continue;
    const { rawScheds } = buildSchedules(emps, rule, dates);
    emps.forEach((emp, i) => {
      allRawScheds[emp.name.toLowerCase()] = rawScheds[i];
    });
  }
  const { plMap, coffMap, adhocMap } = parseLeaveData(dates, allRawScheds);

  setProgress(15, 'Building shift schedules…');
  await sleep(30);

  // Build all employee schedules
  const allSched = []; // [{emp, rule, schedule, adhocDates, fixedShift, adhocFixedShift}]
  for (const rule of activeRules) {
    let allEmps;
    if (rule._empTarget) {
      allEmps = rosterData.filter(e => e.name.toLowerCase() === rule._empTarget.toLowerCase());
    } else {
      allEmps = skillGroups[rule.skill] || [];
    }
    if (!allEmps.length) continue;
    const emps = rule._empSlice
      ? allEmps.slice(rule._empSlice.start, rule._empSlice.end)
      : allEmps;
    if (!emps.length) continue;
    const { rawScheds, fixedShifts } = buildSchedules(emps, rule, dates);
    emps.forEach((emp, i) => {
      const { schedule: sch, adhocDates, adhocFixedShift } = applyOverrides(
        { ...rawScheds[i] }, emp, ahSet, lhMap, plMap, coffMap, adhocMap, dates
      );
      const effectiveFixedShift = adhocFixedShift || fixedShifts[i];
      allSched.push({
        emp, rule, schedule: sch, adhocDates,
        fixedShift: effectiveFixedShift,
        adhocFixedShift,          // null unless full-schedule adhoc override is active
        rawSchedule: rawScheds[i] // keep raw for coverage replacement logic
      });
    });
  }

  // Unique skills in the order they first appear in activeRules.
  // Used by all OUTPUT loops (Excel, Summary, JSON, HTML) so each skill group
  // appears exactly once regardless of how many sub-rules it has.
  const uniqueSkillOrder = [...new Set(activeRules.map(r => r.skill))];

  // ── Adhoc coverage replacement ──────────────────────────────
  // For each group containing an adhoc-pinned employee (full-schedule override):
  //
  //  RULE A — Exclusive shift: On days when the adhoc person is WORKING,
  //    no other group member should be on the same adhoc shift (they switch
  //    back to their own base shift).
  //
  //  RULE B — WO coverage: On the adhoc person's WO days, one group member
  //    temporarily covers the adhoc shift. This person is chosen to minimise
  //    disruption (prefer the person whose removal least hurts other coverage).
  //
  //  RULE C — WO deferral: If the adhoc person's WO day coincides with
  //    another group member's rotation WO AND this would leave any base shift
  //    uncovered (or total WOs > 2), defer that second WO — force the person
  //    to work their base shift instead, so coverage is maintained.
  //
  //  Priority of all other rules (AH, LH, PL, CO) is never changed.
  {
    const REST = new Set(['W','AH','LH','PL','CO']);
    const dStrs = dates.map(d => fmtDMY(d));

    // Collect all defined shifts per group (for coverage checks)
    function getDefinedShifts(grpSched, dStr, di) {
      // Returns Set of shifts that SHOULD be covered today (non-REST, in alloc)
      const shifts = new Set(grpSched.map(s => s.fixedShift).filter(Boolean));
      return shifts;
    }

    for (const skill of uniqueSkillOrder) {
      const grpSched = allSched.filter(s => s.emp.skill === skill);
      if (grpSched.length < 2) continue;

      const adhocPinned = grpSched.filter(s => s.adhocFixedShift);
      if (!adhocPinned.length) continue;

      adhocPinned.forEach(pinned => {
        const adhocShift = pinned.adhocFixedShift;
        const others     = grpSched.filter(s => s !== pinned);

        // Build the set of dates that are within the pinned employee's adhoc window.
        // Coverage replacement (RULE A/B/C) must ONLY apply on these dates.
        // On dates outside the adhoc window the pinned person is on their normal schedule
        // and should not cause disruption to other employees.
        const pinnedAdhocDates = pinned.adhocDates; // Set<dStr> populated by applyOverrides

        dStrs.forEach((dStr, di) => {
          // Only apply coverage replacement on dates that are actually in the adhoc window.
          // Outside the window, all employees keep their base schedule unchanged.
          if (!pinnedAdhocDates.has(dStr)) return;

          const pinnedVal = pinned.schedule[dStr];

          // ── RULE A: Exclusive shift on pinned person's working days ──
          // Only revert another employee's shift if that shift conflicts with adhocShift
          // AND the other employee's raw schedule for this day is NOT 'W'.
          // Never touch an employee whose natural week-off falls on this day.
          if (!REST.has(pinnedVal)) {
            others.forEach(s => {
              if (s.schedule[dStr] === adhocShift) {
                // Do NOT disturb employees whose raw schedule already has W here
                // (their W is legitimate and must be preserved).
                if (s.rawSchedule[dStr] === 'W') return;
                // Revert to own base shift or raw rotation shift
                const ownShift = s.fixedShift || s.rawSchedule[dStr];
                if (ownShift && ownShift !== adhocShift) s.schedule[dStr] = ownShift;
              }
            });
          }

          // ── RULE B + C: WO day handling ──
          if (pinnedVal === 'W') {
            // Collect defined shifts (all base shifts in the group)
            const definedShifts = new Set(grpSched.map(s => s.fixedShift).filter(Boolean));

            // RULE C: If another person's WO on this day would leave a shift uncovered
            // or push total WOs > 2, defer their WO — BUT ONLY if their W is NOT from
            // their natural base schedule (i.e. rawSchedule[dStr] !== 'W').
            // Natural week-offs must never be removed by coverage replacement logic.
            const currentWOers = others.filter(s =>
              s.schedule[dStr] === 'W' && s.rawSchedule[dStr] !== 'W'
            );
            if (currentWOers.length > 0) {
              // Check coverage after removing adhoc-shifted WO persons (pinned + currentWOers)
              const workingShifts = new Set(
                others
                  .filter(s => !REST.has(s.schedule[dStr]))
                  .map(s => s.schedule[dStr])
              );
              const uncovered = [...definedShifts].filter(sh => !workingShifts.has(sh) && sh !== adhocShift);

              // Count natural WOs separately — they are immovable
              const naturalWOCount = others.filter(s => s.rawSchedule[dStr] === 'W').length;
              // Only enforce max 2 total WOs among non-natural WO employees (+1 for pinned)
              const adhocWOs = 1 + currentWOers.length;

              if (uncovered.length > 0 || adhocWOs > 2) {
                // Defer WOs from other employees until coverage is restored
                for (const wo of currentWOers) {
                  // Restore this person to their base shift
                  const ownShift = wo.fixedShift || wo.rawSchedule[dStr];
                  if (ownShift) wo.schedule[dStr] = ownShift;
                  // Re-check coverage
                  const nowWorking = new Set(
                    others
                      .filter(s => !REST.has(s.schedule[dStr]))
                      .map(s => s.schedule[dStr])
                  );
                  const stillUncovered = [...definedShifts].filter(sh => !nowWorking.has(sh) && sh !== adhocShift);
                  const newAdhocWOs = 1 + others.filter(s => s.schedule[dStr] === 'W' && s.rawSchedule[dStr] !== 'W').length;
                  if (stillUncovered.length === 0 && newAdhocWOs <= 2) break; // coverage restored
                }
              }
            }

            // RULE B: Assign coverage for the adhoc shift.
            // Prefer an employee whose base shift has another working backup today,
            // so their temporary reassignment doesn't leave their own shift uncovered.
            // NEVER use an employee whose rawSchedule already has W (natural week-off).
            const workersAfterDefer = others.filter(s =>
              !REST.has(s.schedule[dStr]) && s.rawSchedule[dStr] !== 'W'
            );
            const replacement = workersAfterDefer.find(s => {
              if (s.schedule[dStr] === adhocShift) return false;
              // Check: does this person's shift have a backup?
              const theirShift  = s.fixedShift || s.schedule[dStr];
              const backupExists = workersAfterDefer.some(
                o => o !== s && (o.fixedShift === theirShift || o.schedule[dStr] === theirShift)
              );
              return backupExists;
            }) || workersAfterDefer.find(s => !REST.has(s.schedule[dStr]) && s.schedule[dStr] !== adhocShift);
            if (replacement) {
              replacement.schedule[dStr] = adhocShift;
            }
          }
        });
      });
    }
  }

  setProgress(40, 'Generating Excel workbook…');
  await sleep(30);

  /* ── Excel ────────────────────────────────────────────────── */
  const wb = XLSX.utils.book_new();

  // ── Shared strings ─────────────────────────────────────────
  const FULL_MONTHS = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
  const uniqMonths  = [...new Set(dates.map(d => FULL_MONTHS[d.getMonth()] + ' ' + d.getFullYear()))];
  const rosterTitle = 'Shift Roster \u2014 ' + uniqMonths.join(' \u2013 ');
  const titleStr    = accountName ? accountName + ' \u2013 ' + rosterTitle : rosterTitle;
  const ahList     = [...ahSet].sort().map(d => fmtHolDate(d)).join(', ') || 'None';
  const lhParts    = [];
  for (const [loc, dset] of Object.entries(lhMap)) {
    const name = loc.charAt(0).toUpperCase() + loc.slice(1);
    lhParts.push(name + ': ' + [...dset].sort().map(d => fmtHolDate(d)).join(', '));
  }
  const legendStr = 'AH: ' + ahList + '   |   LH: ' + (lhParts.join('   ') || 'None') +
    '   |   M=Morning  A=Afternoon  N=Night  E=Evening  E1=Evening-1  G=General   |   AH/LH/PL/CO=Unavailable  W=Week Off';

  // ── Cell-level styling helpers (MODEL.xlsx exact colours) ──
  // Shift cell fill colours — exact from MODEL.xlsx analysis
  const SHIFT_FILL = {
    M:     'FF7ED084',  // Light Green
    A:     'FFE9E7B8',  // Light Cream/Yellow
    N:     'FFE1B79D',  // Light Peach/Brown
    E:     'FFB7C4D3',  // Light Blue-Grey
    E1:    'FFB7C4D3',  // Light Blue-Grey (same as E)
    G:     'FFD5B2D5',  // Light Purple
    W:     'FFD9D9D9',  // Gray
    AH:    'FF8B0000',  // Dark Red
    LH:    'FF8B0000',  // Dark Red
    PL:    'FF8B0000',  // Dark Red
    CO:    'FF003366',  // Dark Blue
    SL:    'FF8B0000',  // Dark Red
    EL:    'FF8B0000',  // Dark Red
    ADHOC: 'FFFFE0CC',  // Peach (adhoc override)
  };
  // White text on dark fills; dark text on light fills
  const SHIFT_FG_EXCEL = {
    AH:'FFFFFFFF', LH:'FFFFFFFF', PL:'FFFFFFFF', CO:'FFFFFFFF',
    SL:'FFFFFFFF', EL:'FFFFFFFF'
  };
  const SHIFT_BOLD = { AH:true, LH:true, PL:true, CO:true, SL:true, EL:true };
  // AH/LH display: keep original code (AH/LH), don't collapse to 'H'
  // MODEL.xlsx uses 'AH' and 'LH' as cell values (confirmed from data)

  // Header palette
  const C_NAVY   = 'FF1F3864'; // title row / weekday header bg
  const C_BLUE   = 'FF2E75B6'; // legend bar / summary header bg
  const C_GRPHDR = 'FFD6E4F7'; // group header row bg
  const C_ROW0   = 'FFFFFFFF'; // employee odd row
  const C_ROW1   = 'FFEBF3FB'; // employee even row

  // Day-header special colours (exact from MODEL)
  const C_HOL_BG = 'FFFFE6E6'; const C_HOL_FG = 'FFCC0000'; // AH day / Saturday
  const C_WE_BG  = 'FFF2F2F2'; const C_WE_FG  = 'FF444444'; // unused (Sat uses HOL)
  const C_SUN_FG = 'FFBBBBBB'; // Sunday text colour (MODEL exact)

  function mkCell(v, fgColor, bgColor, bold, sz, wrap) {
    const cell = { v: v === null || v === undefined ? '' : v, t: typeof v === 'number' ? 'n' : 's' };
    cell.s = { font: { name: 'Calibri', color: { rgb: fgColor || 'FF000000' }, bold: !!bold, sz: sz || 9 },
               fill: { fgColor: { rgb: bgColor || 'FFFFFFFF' }, patternType: 'solid' },
               alignment: { horizontal: 'center', vertical: 'center', wrapText: !!wrap } };
    return cell;
  }

  function mkLeftCell(v, fgColor, bgColor, bold, sz) {
    const cell = { v: v === null || v === undefined ? '' : v, t: 's' };
    cell.s = { font: { name: 'Calibri', color: { rgb: fgColor || 'FF000000' }, bold: !!bold, sz: sz || 9 },
               fill: { fgColor: { rgb: bgColor || 'FFFFFFFF' }, patternType: 'solid' },
               alignment: { horizontal: 'left', vertical: 'center' } };
    return cell;
  }

  // ── Build Shift Roster sheet ────────────────────────────────
  const ws = {};

  // Helper: encode column letter
  const col = (c) => {
    let s = '';
    c++;
    while (c > 0) { s = String.fromCharCode(65 + (c-1)%26) + s; c = Math.floor((c-1)/26); }
    return s;
  };
  const addr = (r, c) => col(c) + (r+1);

  // Determine which columns are weekend/holiday
  const numDayCols = dates.length;
  const totalCols  = 5 + numDayCols;

  // Helper to set a cell in the worksheet
  function sc(ws, r, c, cell) {
    const a = addr(r, c);
    ws[a] = cell;
    // Track max row for !ref — will be set explicitly at end
  }

  // Row 0: Title bar — merged across all columns
  const lastCol = col(totalCols - 1);
  ws['!merges'] = [];
  ws['!merges'].push({s:{r:0,c:0},e:{r:0,c:totalCols-1}});
  ws['!merges'].push({s:{r:1,c:0},e:{r:1,c:totalCols-1}});
  // Row 2: Month-band — columns 0-4 (info cols) merged, then one merge per month group
  // (merges added below after computing month spans)

  // Row 1: Title
  sc(ws, 0, 0, mkLeftCell(titleStr, 'FFFFFFFF', C_NAVY, true, 14));
  // Row 2: Legend bar
  sc(ws, 1, 0, mkLeftCell(legendStr, 'FFFFFFFF', C_BLUE, false, 9));

  // ── Row 3 (index 2): Month-name band ────────────────────────
  // Group consecutive date columns by month, emit one merged cell per month.
  // Info columns A–E (indices 0–4) get a blank navy cell merged together.
  const C_MONTH_BG = 'FF1A56A0';   // slightly lighter navy for the month band
  const C_MONTH_FG = 'FFFFFFFF';

  // Blank cell for info-column section of month band
  ws['!merges'].push({s:{r:2,c:0},e:{r:2,c:4}});
  sc(ws, 2, 0, mkCell('', C_MONTH_FG, C_MONTH_BG, false, 10));

  // Compute month spans
  const monthSpans = []; // [{month, year, startCol, endCol}]
  dates.forEach((dt, di) => {
    const m = dt.getMonth(), y = dt.getFullYear(), dc = 5 + di;
    const last = monthSpans[monthSpans.length - 1];
    if (last && last.month === m && last.year === y) {
      last.endCol = dc;
    } else {
      monthSpans.push({ month: m, year: y, startCol: dc, endCol: dc });
    }
  });

  // Write one merged month-name cell per month group
  monthSpans.forEach(span => {
    const label = FULL_MONTHS[span.month] + ' ' + span.year;
    if (span.startCol < span.endCol) {
      ws['!merges'].push({s:{r:2,c:span.startCol},e:{r:2,c:span.endCol}});
    }
    sc(ws, 2, span.startCol, mkCell(label, C_MONTH_FG, C_MONTH_BG, true, 10));
  });

  // ── Row 4 (index 3): Column headers (Name | Email | Skill | Location | Shift | dates…) ──
  const hdrs = ['Name','Email','Skill','Location','Shift'];
  hdrs.forEach((h, c) => sc(ws, 3, c, mkCell(h, 'FFFFFFFF', C_NAVY, true, 10)));

  dates.forEach((dt, di) => {
    const dc       = 5 + di;
    const dow      = dt.getDay();
    const isSat    = dow === 6;
    const isSun    = dow === 0;
    const isHol    = ahSet.has(fmtDMY(dt));
    const dayLabel = dt.getDate() + '\n' + DAYS[dow];
    let bg = C_NAVY, fg = 'FFFFFFFF';
    if      (isHol || isSat) { bg = C_HOL_BG; fg = C_HOL_FG; }
    else if (isSun)           { bg = C_WE_BG;  fg = C_SUN_FG; }
    sc(ws, 3, dc, mkCell(dayLabel, fg, bg, true, 8, true));
  });

  // Rows 5+: group headers + employee rows  (rowIdx starts at 4)
  let rowIdx = 4;
  for (const skill of uniqueSkillOrder) {
    const grp = allSched.filter(s => s.emp.skill === skill);
    if (!grp.length) continue;

    // Merge group header across all columns
    ws['!merges'].push({s:{r:rowIdx,c:0},e:{r:rowIdx,c:totalCols-1}});
    sc(ws, rowIdx, 0, mkLeftCell('  ' + skill, 'FF1F3864', C_GRPHDR, true, 10));
    rowIdx++;

    grp.forEach(({ emp, schedule, adhocDates, fixedShift }, empPos) => {
      const rowBg = empPos % 2 === 0 ? C_ROW0 : C_ROW1;
      // Use the authoritative fixedShift from buildSchedules — never derived from schedule
      // (schedule has AH/LH/PL/CO overwriting some days, so scanning it gives wrong result)
      const initShift = fixedShift || '';

      // Info cells A-E: left-aligned, 9pt
      sc(ws, rowIdx, 0, mkLeftCell(emp.name,     'FF000000', rowBg, false, 9));
      sc(ws, rowIdx, 1, mkLeftCell(emp.email,    'FF000000', rowBg, false, 9));
      sc(ws, rowIdx, 2, mkLeftCell(emp.skill,    'FF000000', rowBg, false, 9));
      sc(ws, rowIdx, 3, mkLeftCell(emp.location, 'FF000000', rowBg, false, 9));
      sc(ws, rowIdx, 4, mkLeftCell(initShift,    'FF000000', rowBg, false, 9));

      // Day cells — Logic 2: ADHOC dates show actual shift value with peach background
      dates.forEach((dt, di) => {
        const dc      = 5 + di;
        const dStr    = fmtDMY(dt);
        const val     = schedule[dStr] || '';
        const isAdhoc = adhocDates && adhocDates.has(dStr);

        // ADHOC peach tint marks genuine shift overrides only.
        // W always uses its own gray — regardless of whether it came from
        // the group rotation or an adhoc WO-override (isWOOverride).
        // AH/LH/PL/CO/W always use their own fixed colours (Logic 3).
        const bg   = (isAdhoc && val !== 'W') ? SHIFT_FILL.ADHOC  // peach = adhoc shift override
                   : (val in SHIFT_FILL)       ? SHIFT_FILL[val]   // W→gray, AH→red, etc.
                   : rowBg;
        const bold = !!SHIFT_BOLD[val];
        const fg   = SHIFT_FG_EXCEL[val] || 'FF000000';
        sc(ws, rowIdx, dc, mkCell(val, fg, bg, bold, 9));
      });

      rowIdx++;
    });
  }

  ws['!ref'] = 'A1:' + lastCol + (rowIdx + 1);

  // Footer row: Account Name + Manager Name
  {
    const footerParts = [];
    if (accountName) footerParts.push('Account: ' + accountName);
    if (managerName) footerParts.push('Manager: ' + managerName);
    const footerText = footerParts.join('   │   ');
    if (footerText) {
      ws['!merges'].push({s:{r:rowIdx,c:0},e:{r:rowIdx,c:totalCols-1}});
      sc(ws, rowIdx, 0, mkLeftCell(footerText, 'FFAAAAAA', 'FF1A1F2E', false, 9));
    }
    rowIdx++;
  }

  // Freeze panes applied via XML injection after write (xlsx-js-style doesn't emit !freeze)

  // Column widths (exact MODEL.xlsx values)
  ws['!cols'] = [
    {wch:26}, {wch:24}, {wch:22}, {wch:12}, {wch:8},
    ...dates.map(() => ({wch:4.2}))
  ];

  // Row heights: r1=28pt title, r2=18pt legend, r3=16pt month-band, r4=30pt header, then data
  {
    const rowHeights = [
      {hpt:28}, // row 1: title
      {hpt:18}, // row 2: legend
      {hpt:16}, // row 3: month-name band  ← NEW
      {hpt:30}, // row 4: day headers
    ];
    let ri = 4;
    for (const skill of uniqueSkillOrder) {
      const grp = allSched.filter(s => s.emp.skill === skill);
      if (!grp.length) continue;
      rowHeights[ri] = {hpt:20}; // group header
      ri++;
      for (let ei = 0; ei < grp.length; ei++) {
        rowHeights[ri] = {hpt:18}; // employee row
        ri++;
      }
    }
    ws['!rows'] = rowHeights;
    ws['!rows'].push({hpt:16}); // footer
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Shift Roster');

  setProgress(60, 'Building Summary sheet…');
  await sleep(20);

  /* ── Summary sheet ────────────────────────────────────────── */
  const sumWs = {};
  // Logic 3: AH and LH are separate columns — never merged into a single 'Holiday' column
  const sumHdrs = ['Name','Skill','Shift','M(Morning)','A(Afternoon)','N(Night)','E(Evening)','E1(Eve-1)','G(General)','W(WeekOff)','AH(Acct Hol)','LH(Loc Hol)','PL','CO','ADHOC','Working Days'];

  // Title row (sz=13 matches MODEL)
  sumWs['!merges'] = [{s:{r:0,c:0},e:{r:0,c:sumHdrs.length-1}}]; // auto-spans to new 16-col width
  sumWs['A1'] = mkLeftCell((accountName ? accountName + ' \u2013 ' : '') + 'Shift Distribution Summary \u2014 ' + uniqMonths.join(' \u2013 '), 'FFFFFFFF', C_NAVY, true, 13);

  // Header row
  sumHdrs.forEach((h, c) => {
    const a = String.fromCharCode(65+c) + '2';
    sumWs[a] = mkCell(h, 'FFFFFFFF', C_BLUE, true, 10);
  });

  // Data rows — Logic 2 & 3: separate AH/LH, pass adhocDates, no merged Holiday column
  allSched.forEach(({ emp, schedule, adhocDates, fixedShift }, i) => {
    const c = countShifts(schedule, adhocDates);
    // fixedShift comes directly from buildSchedules — authoritative base shift
    const rowBg = i % 2 === 0 ? C_ROW0 : C_ROW1;
    const row   = i + 3;
    // Logic 3: AH and LH are separate columns (cols 10 and 11), never combined
    const vals = [emp.name, emp.skill, fixedShift,
      c.M||0, c.A||0, c.N||0, c.E||0, c.E1||0, c.G||0,
      c.W||0, c.AH||0, c.LH||0, c.PL||0, c.CO||0, c.ADHOC||0, c.working];
    vals.forEach((v, ci) => {
      const a = ci < 26 ? String.fromCharCode(65+ci) + row
                        : 'A' + String.fromCharCode(65+(ci-26)) + row; // >Z columns
      const bg = (() => {
        // Colour-code the count cells by type for readability
        if (ci >= 3 && v > 0) {
          if (ci === 9)  return 'FFD9D9D9'; // W  — gray
          if (ci === 10) return 'FFFF4444'; // AH — bright red
          if (ci === 11) return 'FFFF7777'; // LH — lighter red
          if (ci === 12) return 'FFFFCCCC'; // PL — pale red
          if (ci === 13) return 'FFFFAAAA'; // CO — medium red
          if (ci === 14) return 'FFFFE0CC'; // ADHOC — peach
        }
        return rowBg;
      })();
      const fg = (ci === 10 && v > 0) ? 'FFFFFFFF' : 'FF000000'; // white on AH
      sumWs[a] = ci < 3 ? mkLeftCell(v, 'FF000000', rowBg, false, 9)
                        : mkCell(v || '', fg, bg, false, 9);
    });
  });

  // 16 columns now (added LH column) — last col = P
  {
    const sumLastDataRow = allSched.length + 2;  // 1-indexed row of last employee
    const footerParts = [];
    if (accountName) footerParts.push('Account: ' + accountName);
    if (managerName) footerParts.push('Manager: ' + managerName);
    const footerText = footerParts.join('   \u2502   ');
    if (footerText) {
      // Merge A(lastRow+1) across all 16 Summary columns
      sumWs['!merges'].push({s:{r:sumLastDataRow,c:0},e:{r:sumLastDataRow,c:sumHdrs.length-1}});
      sumWs['A' + (sumLastDataRow + 1)] =
        mkLeftCell(footerText, 'FFAAAAAA', 'FF1A1F2E', false, 9);
      sumWs['!ref'] = 'A1:P' + (sumLastDataRow + 1);
    } else {
      sumWs['!ref'] = 'A1:P' + (allSched.length + 2);
    }
  }
  sumWs['!cols'] = [{wch:26},{wch:22},{wch:7},{wch:10},{wch:11},{wch:9},{wch:10},{wch:9},{wch:10},{wch:9},{wch:9},{wch:9},{wch:7},{wch:5},{wch:8},{wch:12}];
  // Row heights for Summary
  {
    const sh = [{hpt:26},{hpt:22}];
    for (let i = 0; i < allSched.length; i++) sh.push({hpt:16});
    sumWs['!rows'] = sh;
  }
  XLSX.utils.book_append_sheet(wb, sumWs, 'Summary');

  setProgress(75, 'Building Legend sheet…');
  await sleep(10);

  /* ── Legend sheet ─────────────────────────────────────────── */
  const legWs  = {};
  legWs['!merges'] = [{s:{r:0,c:0},e:{r:0,c:2}}];
  legWs['A1'] = mkLeftCell('Shift Codes & Colour Legend', 'FFFFFFFF', C_NAVY, true, 12);
  // Header
  ['Code','Description','Colour'].forEach((h,c)=>{
    legWs[String.fromCharCode(65+c)+'2'] = mkCell(h, 'FFFFFFFF', C_BLUE, true, 10);
  });
  // Entries — exact from MODEL.xlsx (code, description, bg, fg)
  const legRows = [
    ['M',     'Morning (05:30\u201314:30)',        'FFFFF2CC', 'FF000000'],
    ['A',     'Afternoon (13:30\u201322:30)',       'FFDDEBF7', 'FF000000'],
    ['N',     'Night (21:30\u201306:30)',           'FFE2EFDA', 'FF000000'],
    ['E',     'Evening (17:30\u201302:30)',         'FFFCE4D6', 'FF000000'],
    ['E1',    'Evening-1 (19:30\u201304:30)',       'FFF8D7F0', 'FF000000'],
    ['G',     'General (9:30 AM\u20136:30 PM)',     'FFFFF2CC', 'FF000000'],
    ['PL',    'Planned Leave \u2014 RED (unavailable)', 'FFFFCCCC', 'FF800000'],
    ['CO',    'Comp-Off \u2014 RED (unavailable)',  'FFFFAAAA', 'FF7B0000'],
    ['AH',    'Account Holiday \u2014 RED (unavailable)', 'FFFF4444', 'FFFFFFFF'],
    ['LH',    'Local Holiday \u2014 RED (unavailable)',   'FFFF7777', 'FFFFFFFF'],
    ['ADHOC', 'Adhoc / On-call Shift',             'FFFFE0CC', 'FF000000'],

    ['W',     'Week Off',                          'FFD9D9D9', 'FF000000'],
  ];
  legRows.forEach(([code, desc, bg, fg], i) => {
    const r = i + 3;
    legWs['A'+r] = mkCell(code, fg, bg, true, 10);
    legWs['B'+r] = mkLeftCell(desc, 'FF000000', 'FFFFFFFF', false, 9);
    legWs['C'+r] = mkCell('', fg, bg, false, 9);
  });
  legWs['!ref'] = 'A1:C' + (legRows.length + 2);
  legWs['!cols'] = [{wch:8},{wch:36},{wch:16}];
  // Row heights for Legend
  {
    const lh = [{hpt:24},{hpt:20}];
    for (let i=0; i<legRows.length; i++) lh.push({hpt:20});
    legWs['!rows'] = lh;
  }
  XLSX.utils.book_append_sheet(wb, legWs, 'Legend');

  setProgress(85, 'Writing .xlsx file…');
  await sleep(20);

  const datePart  = startD.toISOString().slice(0,10).replace(/-/g,'') + '_to_' + endD.toISOString().slice(0,10).replace(/-/g,'');
  // Filename: "AccountName - Shift Roster - 20260531_to_20260730.xlsx"
  // Sanitise accountName: strip characters not safe in filenames
  const safeAcct  = accountName ? accountName.replace(/[/\\:*?"<>|]/g, '').trim() + ' - ' : '';
  const xlsxName  = safeAcct + 'Shift Roster - ' + datePart + '.xlsx';

  // ── Write xlsx and inject freeze panes via JSZip ──────────────
  // xlsx-js-style does not honour ws['!freeze'] — the pane element is never
  // emitted in the sheetView XML.  We write to an ArrayBuffer, re-open it
  // with JSZip, inject the correct <pane> tag into sheet1.xml only, then
  // re-pack and download.  Freeze target: F4 (cols A-E + rows 1-3 fixed).
  {
    const xlsxBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    async function addFreezePanes(buf, xSplit, ySplit) {
      try {
        const colLtr = c => { let s=''; c++; while(c>0){s=String.fromCharCode(65+(c-1)%26)+s;c=Math.floor((c-1)/26);}return s; };
        const topLeft  = colLtr(xSplit) + (ySplit + 1);   // 'F4'
        const paneXml  = `<pane xSplit="${xSplit}" ySplit="${ySplit}" topLeftCell="${topLeft}" ` +
                         `activePane="bottomRight" state="frozen"/>` +
                         `<selection pane="bottomRight" activeCell="${topLeft}" sqref="${topLeft}"/>`;

        const zip = await JSZip.loadAsync(buf);
        const sheetPath = 'xl/worksheets/sheet1.xml';
        let xml = await zip.file(sheetPath).async('string');

        // Inject pane into the first (Shift Roster) sheetView only
        if (xml.includes('<pane ')) {
          // already has a pane — replace it
          xml = xml.replace(/<pane[^>]*\/>/g, '').replace(/<selection pane[^>]*\/>/g, '');
        }
        xml = xml
          .replace(/<sheetView([^>]*)\/>/,    (m,a) => `<sheetView${a}>${paneXml}</sheetView>`)
          .replace(/<sheetView([^>]*)><\/sheetView>/, (m,a) => `<sheetView${a}>${paneXml}</sheetView>`);
        if (!xml.includes('<pane ')) {
          xml = xml.replace(/(<sheetView[^>]*>)(?!<pane)/, m => m + paneXml);
        }

        zip.file(sheetPath, xml);
        return await zip.generateAsync({ type:'arraybuffer', compression:'DEFLATE', compressionOptions:{ level:6 } });
      } catch(e) {
        console.warn('Freeze pane injection failed (non-critical):', e.message);
        return buf;
      }
    }

    const patchedBuf = await addFreezePanes(xlsxBuf, 5, 4);
    const xlsxBlob   = new Blob([patchedBuf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const xlsxUrl    = URL.createObjectURL(xlsxBlob);
    const xlsxA      = document.createElement('a');
    xlsxA.href = xlsxUrl; xlsxA.download = xlsxName;
    document.body.appendChild(xlsxA); xlsxA.click(); document.body.removeChild(xlsxA);
    setTimeout(() => URL.revokeObjectURL(xlsxUrl), 5000);
  }

  setProgress(92, 'Building JSON export…');
  await sleep(10);

  /* ── JSON export ─────────────────────────────────────────── */
  // Collect per-day coverage summary
  const coverage = {};
  dates.forEach(dt => {
    const dStr = fmtDMY(dt);
    coverage[dStr] = {};
    for (const skill of uniqueSkillOrder) {
      const grp = allSched.filter(s => s.emp.skill === skill);
      // Per shift slot: who is working, who is on WO, what is the coverage status
      const shiftSlots = {};
      grp.forEach(({ emp, schedule, adhocDates, fixedShift }) => {
        const val = schedule[dStr];
        if (!shiftSlots[fixedShift]) shiftSlots[fixedShift] = { working: [], onWO: [], onLeave: [] };
        if (['AH','LH','PL','CO'].includes(val)) {
          shiftSlots[fixedShift].onLeave.push(emp.name);
        } else if (val === 'W') {
          shiftSlots[fixedShift].onWO.push(emp.name);
        } else {
          shiftSlots[fixedShift].working.push({
            name: emp.name,
            shift: val,
            isAdhoc: !!(adhocDates && adhocDates.has(dStr))
          });
        }
      });
      coverage[dStr][skill] = shiftSlots;
    }
  });

  const jsonPayload = {
    metadata: {
      generated:       new Date().toISOString(),
      rosterStart:     fmtDMY(startD),
      rosterEnd:       fmtDMY(endD),
      totalDays:       dates.length,
      totalEmployees:  rosterData.length,
      accountHolidays: [...ahSet].sort(),
      locationHolidays: Object.fromEntries(
        Object.entries(lhMap).map(([k, v]) => [k, [...v].sort()])
      )
    },
    skillRules: uniqueSkillOrder.map(skill => {
      // For prompt multi-slot rules, merge sub-rules back into one display entry
      const subRules = activeRules.filter(r => r.skill === skill);
      if (subRules.length === 1) return subRules[0];
      // Multi-slot: reconstruct combined alloc string for display
      const alloc = subRules.map(r => (r.count > 1 ? r.count : '') + r.alloc).join(', ');
      return { ...subRules[0], alloc, count: subRules.reduce((s,r) => s+r.count, 0) };
    }),
    employees: allSched.map(({ emp, rule, schedule, adhocDates, fixedShift }) => {
      const c = countShifts(schedule, adhocDates);
      // Logic 2: rebuild dailySchedule with adhoc dates labelled clearly
      // The cell values are already the actual shift (M/A/N/G) but JSON
      // includes a parallel 'adhocFlags' map so consumers can distinguish.
      const adhocFlags = {};
      if (adhocDates) adhocDates.forEach(d => { adhocFlags[d] = true; });
      return {
        name: emp.name, email: emp.email, skill: emp.skill, location: emp.location,
        fixedShift,  // authoritative base shift from buildSchedules
        dailySchedule: schedule,
        adhocOverrides: adhocFlags,  // Logic 2: which dates were adhoc
        // Logic 3: fully separated leave/WO counts
        shiftCounts: {
          M: c.M, A: c.A, N: c.N, E: c.E, E1: c.E1, G: c.G,
          W:    c.W,       // pure week-off only
          AH:   c.AH,      // account holiday (separate)
          LH:   c.LH,      // location holiday (separate)
          PL:   c.PL,      // planned leave (separate)
          CO:   c.CO,      // comp-off (separate)
          ADHOC: c.ADHOC,  // adhoc overrides (separate, Logic 2)
          working: c.working
        }
      };
    }),
    coverageSummary: coverage,
    validation: { errors: [], warnings: [] }
  };

  const jBlob = new Blob([JSON.stringify(jsonPayload, null, 2)], { type: 'application/json' });
  const jUrl  = URL.createObjectURL(jBlob);
  const jA    = document.createElement('a');
  jA.href = jUrl; jA.download = xlsxName.replace('.xlsx', '.json');
  document.body.appendChild(jA); jA.click(); document.body.removeChild(jA);
  setTimeout(() => URL.revokeObjectURL(jUrl), 5000);

  /* ── XML export ──────────────────────────────────────────────
   * Produces a self-contained XML file that can be:
   *   - Published directly on any static host (GitHub Pages, S3, etc.)
   *   - Opened in a browser with an XSL stylesheet
   *   - Consumed by any tool that reads XML (Excel, BI tools, etc.)
   *   - Served from a data: URI with no server needed
   *
   * Structure mirrors the JSON payload exactly:
   *   <ShiftRoster>
   *     <Metadata … />
   *     <SkillRules><Rule … /></SkillRules>
   *     <Employees><Employee …><DailySchedule><Day …/></DailySchedule></Employee></Employees>
   *     <CoverageSummary><Day date="…"><Skill …><Slot …></Slot></Skill></Day></CoverageSummary>
   *   </ShiftRoster>
   *
   * All attribute values are XML-escaped so the file is always well-formed.
   */
  setProgress(95, 'Building XML export…');
  await sleep(10);

  function xmlEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Build XML string via array push (faster than string concat on large rosters)
  const xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>');
  xml.push('<!-- Shift Roster export — generated by ShiftScheduler -->');
  xml.push('<ShiftRoster>');

  // Metadata
  const md = jsonPayload.metadata;
  xml.push('  <Metadata'
    + ' generated="'      + xmlEsc(md.generated)      + '"'
    + ' rosterStart="'    + xmlEsc(md.rosterStart)     + '"'
    + ' rosterEnd="'      + xmlEsc(md.rosterEnd)       + '"'
    + ' totalDays="'      + xmlEsc(md.totalDays)       + '"'
    + ' totalEmployees="' + xmlEsc(md.totalEmployees)  + '"'
    + '>');
  if (md.accountHolidays.length) {
    xml.push('    <AccountHolidays>');
    md.accountHolidays.forEach(d => xml.push('      <Holiday date="' + xmlEsc(d) + '"/>'));
    xml.push('    </AccountHolidays>');
  }
  const lhEntries = Object.entries(md.locationHolidays);
  if (lhEntries.length) {
    xml.push('    <LocationHolidays>');
    lhEntries.forEach(([loc, days]) =>
      days.forEach(d => xml.push('      <Holiday location="' + xmlEsc(loc) + '" date="' + xmlEsc(d) + '"/>'))
    );
    xml.push('    </LocationHolidays>');
  }
  xml.push('  </Metadata>');

  // Skill rules
  xml.push('  <SkillRules>');
  jsonPayload.skillRules.forEach(r => {
    xml.push('    <Rule'
      + ' skill="'    + xmlEsc(r.skill)    + '"'
      + ' alloc="'    + xmlEsc(r.alloc)    + '"'
      + ' rotation="' + xmlEsc(r.rotation) + '"'
      + ' weekoff="'  + xmlEsc(r.weekoff)  + '"'
      + '/>');
  });
  xml.push('  </SkillRules>');

  // Employees
  xml.push('  <Employees>');
  jsonPayload.employees.forEach(emp => {
    xml.push('    <Employee'
      + ' name="'       + xmlEsc(emp.name)       + '"'
      + ' email="'      + xmlEsc(emp.email)       + '"'
      + ' skill="'      + xmlEsc(emp.skill)       + '"'
      + ' location="'   + xmlEsc(emp.location)    + '"'
      + ' fixedShift="' + xmlEsc(emp.fixedShift)  + '"'
      + '>');

    // Shift counts summary
    const sc = emp.shiftCounts;
    xml.push('      <ShiftCounts'
      + ' M="'       + sc.M       + '"'
      + ' A="'       + sc.A       + '"'
      + ' N="'       + sc.N       + '"'
      + ' E="'       + sc.E       + '"'
      + ' E1="'      + sc.E1      + '"'
      + ' G="'       + sc.G       + '"'
      + ' W="'       + sc.W       + '"'
      + ' AH="'      + sc.AH      + '"'
      + ' LH="'      + sc.LH      + '"'
      + ' PL="'      + sc.PL      + '"'
      + ' CO="'      + sc.CO      + '"'
      + ' ADHOC="'   + sc.ADHOC   + '"'
      + ' working="' + sc.working + '"'
      + '/>');

    // Daily schedule — one <Day> element per roster date
    xml.push('      <DailySchedule>');
    Object.entries(emp.dailySchedule).forEach(([date, shift]) => {
      const isAdhoc = !!(emp.adhocOverrides && emp.adhocOverrides[date]);
      xml.push('        <Day date="' + xmlEsc(date) + '" shift="' + xmlEsc(shift) + '"'
        + (isAdhoc ? ' adhoc="true"' : '') + '/>');
    });
    xml.push('      </DailySchedule>');
    xml.push('    </Employee>');
  });
  xml.push('  </Employees>');

  // Coverage summary
  xml.push('  <CoverageSummary>');
  Object.entries(jsonPayload.coverageSummary).forEach(([date, skills]) => {
    xml.push('    <Day date="' + xmlEsc(date) + '">');
    Object.entries(skills).forEach(([skill, slots]) => {
      xml.push('      <Skill name="' + xmlEsc(skill) + '">');
      Object.entries(slots).forEach(([slotShift, data]) => {
        xml.push('        <Slot shift="' + xmlEsc(slotShift) + '">');
        data.working.forEach(w =>
          xml.push('          <Working name="' + xmlEsc(w.name) + '"'
            + ' shift="' + xmlEsc(w.shift) + '"'
            + (w.isAdhoc ? ' adhoc="true"' : '') + '/>')
        );
        data.onWO.forEach(n =>
          xml.push('          <OnWO name="' + xmlEsc(n) + '"/>')
        );
        data.onLeave.forEach(n =>
          xml.push('          <OnLeave name="' + xmlEsc(n) + '"/>')
        );
        xml.push('        </Slot>');
      });
      xml.push('      </Skill>');
    });
    xml.push('    </Day>');
  });
  xml.push('  </CoverageSummary>');

  xml.push('</ShiftRoster>');

  const xmlStr  = xml.join('\n');

  // ── Styled HTML viewer — Excel-like roster table ──────────────
  // Instead of a bare XML file, generate a self-contained HTML file
  // that embeds the XML data and renders it as a fully styled,
  // colour-coded roster table — matching the Excel output exactly.
  // Opens in any browser with no server needed.

  const SHIFT_CSS = {
    M:'#7ED084',  A:'#E9E7B8',  N:'#E1B79D',  E:'#B7C4D3',  E1:'#B7C4D3',
    G:'#D5B2D5',  W:'#D9D9D9',  AH:'#8B0000', LH:'#8B0000',
    PL:'#8B0000', CO:'#003366', ADHOC:'#FFE0CC'
  };
  const SHIFT_FG = { AH:'#fff', LH:'#fff', PL:'#fff', CO:'#fff' };

  // ── Section 1: Metadata + Skill Rules ─────────────────────────
  function metaHtml() {
    const rows = [];
    rows.push('<table class="meta-tbl">');
    rows.push('<tr><th colspan="2">Roster Metadata</th></tr>');
    rows.push('<tr><td>Generated</td><td>' + xmlEsc(new Date(md.generated).toLocaleString()) + '</td></tr>');
    rows.push('<tr><td>Period</td><td>' + xmlEsc(md.rosterStart) + ' – ' + xmlEsc(md.rosterEnd) + ' (' + md.totalDays + ' days)</td></tr>');
    rows.push('<tr><td>Employees</td><td>' + md.totalEmployees + '</td></tr>');
    if (accountName) rows.push('<tr><td>Account</td><td>' + xmlEsc(accountName) + '</td></tr>');
    if (managerName) rows.push('<tr><td>Manager</td><td>' + xmlEsc(managerName) + '</td></tr>');
    if (md.accountHolidays.length)
      rows.push('<tr><td>Account Holidays</td><td>' + md.accountHolidays.map(xmlEsc).join(', ') + '</td></tr>');
    const lhE2 = Object.entries(md.locationHolidays);
    if (lhE2.length)
      rows.push('<tr><td>Location Holidays</td><td>' + lhE2.map(([l,ds]) => xmlEsc(l)+': '+ds.map(xmlEsc).join(', ')).join('<br>') + '</td></tr>');
    rows.push('</table>');

    rows.push('<table class="meta-tbl" style="margin-top:16px">');
    rows.push('<tr><th>Skill</th><th>Allocation</th><th>Rotation</th><th>Week Off</th></tr>');
    jsonPayload.skillRules.forEach(r => {
      rows.push('<tr><td>' + xmlEsc(r.skill) + '</td><td>' + xmlEsc(r.alloc) + '</td><td>'
        + xmlEsc(r.rotation) + '</td><td>' + xmlEsc(r.weekoff) + '</td></tr>');
    });
    rows.push('</table>');
    return rows.join('\n');
  }

  // ── Section 2: Shift Roster — one row per employee, one cell per day ──
  function rosterHtml() {
    const empsBySkill = {};
    jsonPayload.employees.forEach(emp => {
      if (!empsBySkill[emp.skill]) empsBySkill[emp.skill] = [];
      empsBySkill[emp.skill].push(emp);
    });

    // Collect all dates from first employee
    const allDates = jsonPayload.employees.length
      ? Object.keys(jsonPayload.employees[0].dailySchedule)
      : [];

    const rows = [];
    rows.push('<div class="tbl-wrap"><table class="roster-tbl">');

    // Header row 1: title spanning all
    const totalCols2 = 5 + allDates.length;
    rows.push('<thead>');
    rows.push('<tr><th colspan="' + totalCols2 + '" class="tbl-title">'
      + xmlEsc(titleStr) + '</th></tr>');
    rows.push('<tr><th colspan="' + totalCols2 + '" class="tbl-legend">'
      + xmlEsc(legendStr) + '</th></tr>');

    // Header row 3: columns
    rows.push('<tr class="col-hdr">');
    rows.push('<th class="ch-name">Name</th><th class="ch-email">Email</th>'
      + '<th class="ch-skill">Skill</th><th class="ch-loc">Location</th>'
      + '<th class="ch-shift">Shift</th>');
    allDates.forEach(d => {
      const dt   = new Date(d.split('-').reverse().join('-') + 'T00:00:00');
      const dow  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
      const dd   = dt.getDate();
      const isSat = dt.getDay() === 6;
      const isSun = dt.getDay() === 0;
      rows.push('<th class="ch-day' + (isSat?' ch-sat':isSun?' ch-sun':'') + '">'
        + dd + '<br><span class="dow">' + dow + '</span></th>');
    });
    rows.push('</tr>');
    rows.push('</thead><tbody>');

    // Group + employee rows
    let rowNum = 0;
    Object.entries(empsBySkill).forEach(([skill, emps]) => {
      // Group header
      rows.push('<tr class="grp-hdr"><td colspan="' + totalCols2 + '">' + xmlEsc(skill) + '</td></tr>');
      emps.forEach(emp => {
        const bg = rowNum % 2 === 0 ? '' : ' class="emp-alt"';
        rows.push('<tr' + bg + '>');
        rows.push('<td class="td-name">' + xmlEsc(emp.name) + '</td>');
        rows.push('<td class="td-email">' + xmlEsc(emp.email) + '</td>');
        rows.push('<td class="td-skill">' + xmlEsc(emp.skill) + '</td>');
        rows.push('<td class="td-loc">' + xmlEsc(emp.location) + '</td>');
        rows.push('<td class="td-fs"><span class="shift-badge s-' + xmlEsc(emp.fixedShift) + '">'
          + xmlEsc(emp.fixedShift) + '</span></td>');
        allDates.forEach(d => {
          const sh = emp.dailySchedule[d] || '';
          const isAdhoc = !!(emp.adhocOverrides && emp.adhocOverrides[d]);
          const bg2 = (isAdhoc && sh !== 'W') ? SHIFT_CSS.ADHOC : (SHIFT_CSS[sh] || '');
    const fg2v = SHIFT_FG[sh] || '#111';
          const fg2 = SHIFT_FG[sh] || '#111';
          rows.push('<td class="td-day" style="background:' + bg2 + ';color:' + fg2 + '">'
            + xmlEsc(sh) + '</td>');
        });
        rows.push('</tr>');
        rowNum++;
      });
    });

    rows.push('</tbody></table></div>');
    return rows.join('\n');
  }

  // ── Section 3: Summary ─────────────────────────────────────────
  function summaryHtml() {
    const rows = [];
    rows.push('<table class="sum-tbl">');
    rows.push('<tr><th colspan="16" class="tbl-title">Shift Distribution Summary</th></tr>');
    rows.push('<tr class="sum-hdr">'
      + '<th>Name</th><th>Skill</th><th>Shift</th>'
      + '<th>M</th><th>A</th><th>N</th><th>E</th><th>E1</th><th>G</th>'
      + '<th>W</th><th>AH</th><th>LH</th><th>PL</th><th>CO</th><th>ADHOC</th><th>Working</th>'
      + '</tr>');
    jsonPayload.employees.forEach((emp, i) => {
      const sc2 = emp.shiftCounts;
      const alt = i % 2 !== 0 ? ' class="emp-alt"' : '';
      rows.push('<tr' + alt + '>'
        + '<td class="td-name">' + xmlEsc(emp.name) + '</td>'
        + '<td class="td-skill">' + xmlEsc(emp.skill) + '</td>'
        + '<td class="td-fs"><span class="shift-badge s-' + xmlEsc(emp.fixedShift) + '">'
          + xmlEsc(emp.fixedShift) + '</span></td>'
        + ['M','A','N','E','E1','G','W','AH','LH','PL','CO','ADHOC','working']
            .map(k => '<td class="td-cnt">' + (sc2[k] ?? 0) + '</td>').join('')
        + '</tr>');
    });
    rows.push('</table>');
    return rows.join('\n');
  }

  // Build the styled HTML using string concatenation — NOT a template literal.
  // A backtick template literal containing <\/script> would terminate the outer
  // application <script> block early, breaking the entire page.
  // All <\/script> tags inside the HTML payload are split across two strings
  // so the browser parser never sees them as closing the outer script.
  const _sc = '<\/script>';   // safe: split prevents early script-tag close

  const styledHtml = '<!DOCTYPE html>\n'
    + '<html lang="en">\n<head>\n'
    + '<meta charset="UTF-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + xmlEsc(titleStr) + '</title>\n'
    + '<style>\n'
    + '*{box-sizing:border-box;margin:0;padding:0}\n'
    + 'body{font-family:Calibri,Segoe UI,Arial,sans-serif;font-size:11px;background:#f0f2f5;color:#111;padding:16px}\n'
    + 'h2{font-size:16px;margin-bottom:12px;color:#1f3864}\n'
    + '.tabs{display:flex;gap:4px;margin-bottom:0;border-bottom:2px solid #1f3864}\n'
    + '.tab-btn{padding:7px 18px;border:none;border-radius:4px 4px 0 0;cursor:pointer;font-size:11px;font-weight:600;background:#dde4ef;color:#444}\n'
    + '.tab-btn.active{background:#1f3864;color:#fff}\n'
    + '.tab-pane{display:none;padding:16px 0 0 0}\n'
    + '.tab-pane.active{display:block}\n'
    + '.meta-tbl,.sum-tbl{border-collapse:collapse;min-width:400px;margin-bottom:8px}\n'
    + '.meta-tbl td,.meta-tbl th,.sum-tbl td,.sum-tbl th{border:1px solid #c8d0dc;padding:4px 8px;white-space:nowrap}\n'
    + '.meta-tbl th{background:#1f3864;color:#fff;font-weight:600;text-align:left}\n'
    + '.meta-tbl tr:nth-child(even) td{background:#eef2f8}\n'
    + '.sum-tbl .tbl-title{background:#1f3864;color:#fff;font-weight:700;font-size:13px;text-align:left;padding:6px 8px}\n'
    + '.sum-hdr th{background:#2e75b6;color:#fff;font-weight:600}\n'
    + '.sum-tbl td,.sum-tbl th{border:1px solid #b8c4d4;padding:3px 7px}\n'
    + '.emp-alt td{background:#ebf3fb}\n'
    + '.td-cnt{text-align:center}\n'
    + '.tbl-wrap{overflow-x:auto;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.15)}\n'
    + '.roster-tbl{border-collapse:collapse;table-layout:fixed;white-space:nowrap}\n'
    + '.roster-tbl td,.roster-tbl th{border:1px solid #c8d0dc;padding:3px 4px}\n'
    + '.tbl-title{background:#1f3864;color:#fff;font-weight:700;font-size:14px;text-align:left;padding:6px 10px;white-space:normal}\n'
    + '.tbl-legend{background:#2e75b6;color:#fff;font-size:9px;text-align:left;padding:4px 10px;white-space:normal}\n'
    + '.col-hdr th{background:#1f3864;color:#fff;font-weight:600;font-size:10px;text-align:center;position:sticky;top:0;z-index:2}\n'
    + '.ch-name{width:140px;text-align:left !important;position:sticky;left:0;z-index:3}\n'
    + '.ch-email{width:120px;text-align:left !important}\n'
    + '.ch-skill{width:110px;text-align:left !important}\n'
    + '.ch-loc{width:70px;text-align:left !important}\n'
    + '.ch-shift{width:40px}\n'
    + '.ch-day{width:28px;font-size:9px}\n'
    + '.ch-sat{color:#cc0000}\n'
    + '.ch-sun{color:#aaa}\n'
    + '.dow{font-size:8px;font-weight:400;opacity:.85}\n'
    + '.grp-hdr td{background:#d6e4f7;font-weight:700;font-size:11px;padding:4px 6px;position:sticky;left:0}\n'
    + '.td-name{font-weight:500;min-width:130px;background:inherit;position:sticky;left:0;z-index:1}\n'
    + '.td-email{min-width:120px;color:#555}\n'
    + '.td-skill{min-width:110px}\n'
    + '.td-loc{min-width:70px}\n'
    + '.td-fs{text-align:center;min-width:40px}\n'
    + '.td-day{text-align:center;width:28px;font-size:9px;font-weight:600;min-width:28px}\n'
    + '.shift-badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:700;background:#eee}\n'
    + '.s-M{background:#7ED084}.s-A{background:#E9E7B8}.s-N{background:#E1B79D}\n'
    + '.s-E{background:#B7C4D3}.s-E1{background:#B7C4D3}.s-G{background:#D5B2D5}\n'
    + '.s-W{background:#D9D9D9}.s-AH{background:#8B0000;color:#fff}\n'
    + '.s-LH{background:#8B0000;color:#fff}.s-PL{background:#8B0000;color:#fff}.s-CO{background:#003366;color:#fff}\n'
    + '.legend-bar{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;align-items:center}\n'
    + '.lb{display:inline-flex;align-items:center;gap:4px;font-size:10px}\n'
    + '.lc{width:18px;height:14px;border-radius:2px;border:1px solid rgba(0,0,0,.12)}\n'
    + '</style>\n</head>\n<body>\n'
    + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">\n'
    + '  <div style="font-size:20px">\uD83D\uDCCA</div>\n'
    + '  <div>\n'
    + '    <div style="font-size:18px;font-weight:700;color:#1f3864">' + xmlEsc(titleStr) + '</div>\n'
    + '    <div style="font-size:10px;color:#666">Generated ' + xmlEsc(new Date(md.generated).toLocaleString())
        + (accountName ? ' &nbsp;&middot;&nbsp; Account: ' + xmlEsc(accountName) : '')
        + (managerName ? ' &nbsp;&middot;&nbsp; Manager: ' + xmlEsc(managerName) : '')
        + '</div>\n'
    + '  </div>\n</div>\n'
    + '<div class="legend-bar">\n'
    + Object.entries(SHIFT_CSS).map(([k,v]) =>
        '  <span class="lb"><span class="lc" style="background:' + v + '"></span>' + k + '</span>'
      ).join('\n') + '\n</div>\n'
    + '<div class="tabs">\n'
    + '  <button class="tab-btn active" onclick="showTab(\'roster\')">&#x1F4CB; Shift Roster</button>\n'
    + '  <button class="tab-btn" onclick="showTab(\'summary\')">&#x1F4CA; Summary</button>\n'
    + '  <button class="tab-btn" onclick="showTab(\'meta\')">&#x2139;&#xFE0F; Metadata</button>\n'
    + '</div>\n'
    + '<div id="tab-roster" class="tab-pane active">\n' + rosterHtml()  + '\n</div>\n'
    + '<div id="tab-summary" class="tab-pane">\n'       + summaryHtml() + '\n</div>\n'
    + '<div id="tab-meta" class="tab-pane">\n'          + metaHtml()   + '\n</div>\n'
    + '<script>\n'
    + 'function showTab(id){\n'
    + '  document.querySelectorAll(\'.tab-pane\').forEach(function(p){p.classList.remove(\'active\');});\n'
    + '  document.querySelectorAll(\'.tab-btn\').forEach(function(b){b.classList.remove(\'active\');});\n'
    + '  document.getElementById(\'tab-\'+id).classList.add(\'active\');\n'
    + '  event.target.classList.add(\'active\');\n'
    + '}\n'
    + _sc + '\n'
    + '</body>\n</html>';

  const xBlob   = new Blob([styledHtml], { type: 'text/html;charset=utf-8' });
  const xUrl    = URL.createObjectURL(xBlob);
  const xA      = document.createElement('a');
  xA.href = xUrl; xA.download = xlsxName.replace('.xlsx', '-roster.html');
  document.body.appendChild(xA); xA.click(); document.body.removeChild(xA);
  setTimeout(() => URL.revokeObjectURL(xUrl), 5000);

  setProgress(100, '✓ Done! Excel + JSON + HTML downloaded successfully.', 'ok');
  markDone(6);

  // Cache for Publish feature
  _lastGeneratedHtml  = styledHtml;
  _lastGeneratedTitle = titleStr;
  _lastPublishSource  = 'generate';    // Publish will use this HTML
  _updatePublishCard();
  _setPublishBtn(true);
  // Reset publish panel so a new generation clears the previous URL
  const pp = document.getElementById('publishPanel');
  if (pp) pp.style.display = 'none';

  genBtn.disabled = false;
}

/* ─── Utility ───────────────────────────────────────────────── */
