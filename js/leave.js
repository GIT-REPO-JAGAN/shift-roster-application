'use strict';

function parseLeaveData(dates, allSchedules) {
  dates        = dates        || [];
  allSchedules = allSchedules || {};

  const raw    = document.getElementById('leaveInput').value;
  const plMap  = {}, coffMap = {}, adhocMap = {};
  const DMY_RE  = /\d{2}-\d{2}-\d{4}/;
  const DOW_MAP = { mon:1, tue:2, wed:3, thu:4, fri:5, sat:6, sun:0 };

  function parseDMYlocal(s) {
    const [dd,mm,yyyy] = s.trim().split('-');
    return new Date(parseInt(yyyy,10), parseInt(mm,10)-1, parseInt(dd,10));
  }
  function fmtLocal(d) {
    return String(d.getDate()).padStart(2,'0') + '-' +
           String(d.getMonth()+1).padStart(2,'0') + '-' + d.getFullYear();
  }

  // Expand date spec string into Date[]
  // Supports: single, comma-sep, range, mixed combo, "Always"
  function expandDateSpec(spec) {
    spec = spec.trim();
    if (/^always$/i.test(spec)) return dates.map(d => new Date(d));
    const out = [];
    spec.split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
      const rM = tok.match(/^(\d{2}-\d{2}-\d{4})\s+to\s+(\d{2}-\d{2}-\d{4})$/i);
      if (rM) {
        try {
          let cur = parseDMYlocal(rM[1]);
          const end = parseDMYlocal(rM[2]);
          while (cur <= end) { out.push(new Date(cur)); cur.setDate(cur.getDate()+1); }
        } catch(_){}
      } else if (DMY_RE.test(tok)) {
        try { out.push(parseDMYlocal(tok.match(DMY_RE)[0])); } catch(_){}
      }
    });
    return out;
  }

  // Parse "Only On: ..." -> Set<dow> or null
  function parseDowFilter(clause) {
    const c = clause.replace(/^(?:only\s*on|every)\s*[:\u2013\-]?\s*/i, '').trim();
    const days = new Set();
    const rM = c.match(/^(\w+)\s+to\s+(\w+)$/i);
    if (rM) {
      const s = DOW_MAP[rM[1].toLowerCase().slice(0,3)];
      const e = DOW_MAP[rM[2].toLowerCase().slice(0,3)];
      if (s != null && e != null) {
        const order = [1,2,3,4,5,6,0];
        let active = false;
        for (const d of [...order, ...order]) {
          if (d === s) active = true;
          if (active) days.add(d);
          if (d === e && active) break;
        }
        return days;
      }
    }
    c.split(/[,&]/).map(s => s.trim()).forEach(tok => {
      const key = tok.toLowerCase().slice(0,3);
      if (DOW_MAP[key] != null) days.add(DOW_MAP[key]);
    });
    return days.size > 0 ? days : null;
  }

  // Build adhoc entries from date array + options
  //
  // TWO modes depending on context:
  //
  //  A) woPattern + overrideWO, WITHOUT overrideHolidays
  //     (e.g. "Always | Shift: E1 | Week Off: Mon & Wed")
  //     → WO days (Mon/Wed) : emit { shift:'W', isWOOverride:true }   — custom WO days
  //     → All other days    : emit { shift:'E1', overrideWO:true }     — working days
  //     AH/LH still take priority over everything.
  //
  //  B) overrideHolidays=true  (e.g. "… | Week Off: Wed & Thu | Condition: Include WO")
  //     → ALL dates in range  : emit { shift, overrideHolidays:true, overrideWO:true }
  //     WO days are NOT turned into W — the adhoc shift overrides them.
  //     AH/LH/PL/CO are also overridden (handled in applyOverrides).
  //
  function buildAdhocEntries(dateDts, shifts, rotation, dowFilter,
                              shiftFilter, overrideWO, empKey, woPattern,
                              overrideHolidays, excludeWO) {
    if (!dateDts.length) return [];
    const entries    = [];
    const startDt    = dateDts[0];
    const startMonth = startDt.getFullYear()*12 + startDt.getMonth();

    dateDts.forEach(dt => {
      const di    = Math.round((dt - startDt) / 86400000);
      let period  = 0;
      if      (rotation === 'Every Week'    || rotation === 'every week'  || rotation === 'Weekly')    period = Math.floor(di / 7);
      else if (rotation === 'Every 2 Weeks' || rotation === 'every 2 weeks' || rotation === 'Biweekly') period = Math.floor(di / 14);
      else if (rotation === 'Every 3 Weeks' || rotation === 'every 3 weeks') period = Math.floor(di / 21);
      else if (rotation === 'Every Month'   || rotation === 'all month' || rotation === 'every month' || rotation === 'Monthly')
        period = dt.getFullYear()*12 + dt.getMonth() - startMonth;

      const shift = shifts[period % shifts.length];
      const dStr  = fmtLocal(dt);

      // MODE B — Include WO: apply adhoc shift on ALL dates, including WO days.
      // Do NOT emit W for woPattern days; the shift overrides WO entirely.
      if (overrideHolidays) {
        entries.push({ date: dStr, shift, overrideWO: true, overrideHolidays: true });
        return;
      }

      // MODE C — Exclude WO: dowFilter holds the WO DOW set.
      // SKIP dates whose day-of-week is in the exclusion set — leave those days unchanged.
      if (excludeWO && dowFilter) {
        if (dowFilter.has(dt.getDay())) {
          // Record this date as an explicitly declared WO day so applyOverrides
          // can enforce W on it even if the base schedule doesn't have it as W.
          // We tag it as a metadata entry (not a shift entry) using a sentinel.
          entries.push({ date: dStr, shift: 'W', overrideWO: false,
                         isExcludedWO: true });
          return;
        }
        // Not a WO day → emit the adhoc shift normally
        entries.push({ date: dStr, shift, overrideWO: false });
        return;
      }

      // MODE A — woPattern without Include WO:
      // WO-pattern days become custom WO (W); all other days get the adhoc shift.
      if (woPattern && woPattern.size > 0 && overrideWO) {
        if (woPattern.has(dt.getDay())) {
          entries.push({ date: dStr, shift: 'W', overrideWO: true, isWOOverride: true });
        } else {
          entries.push({ date: dStr, shift, overrideWO: true, isWOOverride: false });
        }
        return;
      }

      // Day-of-week filter (Only On: Mon,Wed — apply adhoc only on those days)
      if (dowFilter && !dowFilter.has(dt.getDay())) return;

      // Shift-type filter ("Week Off: M-only" — only on days base-shift === M)
      if (shiftFilter && shiftFilter.size > 0) {
        const sched     = allSchedules[empKey] || {};
        const baseShift = (sched[dStr] || '').toUpperCase();
        if (!shiftFilter.has(baseShift)) return;
      }

      entries.push({ date: dStr, shift, overrideWO: !!overrideWO });
    });
    return entries;
  }

  // Parse each line
  raw.split('\n').map(s => s.trim())
     .filter(s => s && !s.startsWith('//') && !s.startsWith('#'))
     .forEach(line => {
    let m;

    // PL
    m = line.match(/^(.+?)\s*[\u2013\-]\s*PL:\s*(.+)$/i);
    if (m) {
      const key = m[1].trim().toLowerCase();
      if (!plMap[key]) plMap[key] = new Set();
      expandDateSpec(m[2]).forEach(d => plMap[key].add(fmtLocal(d)));
      return;
    }

    // SL (Sick Leave) — treated as PL in the schedule
    m = line.match(/^(.+?)\s*[\u2013\-]\s*SL:\s*(.+)$/i);
    if (m) {
      const key = m[1].trim().toLowerCase();
      if (!plMap[key]) plMap[key] = new Set();
      expandDateSpec(m[2]).forEach(d => plMap[key].add(fmtLocal(d)));
      return;
    }

    // EL (Emergency Leave) — treated as PL in the schedule
    m = line.match(/^(.+?)\s*[\u2013\-]\s*EL:\s*(.+)$/i);
    if (m) {
      const key = m[1].trim().toLowerCase();
      if (!plMap[key]) plMap[key] = new Set();
      expandDateSpec(m[2]).forEach(d => plMap[key].add(fmtLocal(d)));
      return;
    }

    // COFF
    m = line.match(/^(.+?)\s*[\u2013\-]\s*COFF:\s*(.+)$/i);
    if (m) {
      const key = m[1].trim().toLowerCase();
      if (!coffMap[key]) coffMap[key] = new Set();
      expandDateSpec(m[2]).forEach(d => coffMap[key].add(fmtLocal(d)));
      return;
    }

    // Adhoc / Adhoc Shift  (dash/en-dash optional — "Name Adhoc:" and "Name – Adhoc:" both work)
    m = line.match(/^(.+?)\s*(?:[\u2013\-]\s*)?Adhoc(?:\s*Shift)?:\s*(.+)$/i);
    if (!m) return;

    const empName   = m[1].trim();
    const empKey    = empName.toLowerCase();
    if (!adhocMap[empKey]) adhocMap[empKey] = [];

    // Split on pipes, strip each part
    const parts = m[2].split('|').map(s => s.trim());

    // Each pipe-segment may have a keyword prefix (Date:, Shift:, Rotation:,
    // Week Off:, Condition:, Only On:, Every:) or be positional (no prefix).
    // Positional: first unclassified segment = date, second = shift.
    // Both "Date: 20-06-2026" and bare "20-06-2026" are accepted.
    // Both "Shift: E1"        and bare "E1"           are accepted.
    let datePart  = '';
    let shiftPart = '';
    const extra   = [];
    let usedPos   = 0;

    for (const part of parts) {
      if (/^date\s*:/i.test(part)) {
        datePart  = part.replace(/^date\s*:\s*/i, '').trim();
      } else if (/^shift\s*:/i.test(part)) {
        shiftPart = part.replace(/^shift\s*:\s*/i, '').trim();
      } else if (/^(?:rotation|week\s*off|only\s*on|every|condition)\s*[:\-]/i.test(part)) {
        extra.push(part);
      } else {
        // Positional fallback
        if      (!datePart  && usedPos === 0) { datePart  = part; usedPos++; }
        else if (!shiftPart && usedPos === 1) { shiftPart = part; usedPos++; }
        else extra.push(part);
      }
    }

    if (!datePart)  datePart  = '';
    if (!shiftPart) shiftPart = 'M';

    const isAlways   = /^always$/i.test(datePart.trim());
    const overrideWO = isAlways;
    const shifts     = shiftPart.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    let rotation    = null;
    let dowFilter   = null;
    let shiftFilter = null;

    let woPattern = null;  // day-of-week Set for full-schedule WO override

    for (const ex of extra) {
      if (/^rotation\s*:/i.test(ex)) {
        // Normalise: strip hyphens/spaces, lowercase for matching
        const rv = ex.replace(/^rotation\s*:\s*/i,'').trim()
                     .toLowerCase().replace(/-/g,' ');
        if      (/^na$|^none$|^static$|^always$/.test(rv))                      rotation = null; // "Always" = same shift, no rotation
        // Short aliases: Weekly, 2-Week, 3-Week, Monthly
        else if (/^weekly$/.test(rv))                                           rotation = 'every week';
        else if (/^2\s*week$/.test(rv))                                         rotation = 'every 2 weeks';
        else if (/^3\s*week$/.test(rv))                                         rotation = 'every 3 weeks';
        else if (/^monthly$/.test(rv))                                          rotation = 'all month';
        // Legacy verbose forms still accepted
        else if (/every\s*week$/.test(rv) && !/2|3/.test(rv))                 rotation = 'every week';
        else if (/every\s*2\s*week/.test(rv))                                rotation = 'every 2 weeks';
        else if (/every\s*3\s*week/.test(rv))                                rotation = 'every 3 weeks';
        else if (/all\s*month|every\s*month/.test(rv))                       rotation = 'all month';

      } else if (/^week\s*off\s*:/i.test(ex)) {
        // Detect whether value is a shift code or day names.
        // New alias: "M-only" = shift-type filter for M shift.
        // New range: "Mon–Wed" (en-dash) treated same as "Mon to Wed".
        const val      = ex.replace(/^week\s*off\s*:\s*/i, '').trim();
        // Normalise: strip parens, replace en-dash with "to" for range detection
        const valClean = val.replace(/[()]/g, '').replace(/\u2013/g, ' to ').trim();
        const DOW_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
        const firstTok = valClean.split(/[,&\s]+/)[0].toLowerCase().slice(0,3);

        // "M-only" → treat as shift-type filter for M
        if (/^m\s*-\s*only$/i.test(valClean)) {
          shiftFilter = new Set(['M']);
        } else if (DOW_KEYS.includes(firstTok)) {
          // Day-of-week pattern: "Mon & Wed", "Mon–Wed", "Mon to Wed", etc.
          // Replaces the group WO pattern for the adhoc period.
          woPattern = parseDowFilter(valClean);
          dowFilter = woPattern;
        } else {
          // Shift-type filter: "M" or "M, A"
          shiftFilter = new Set(
            valClean.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
          );
        }

      } else if (/^(?:only\s*on|every)\s*[:\-]?/i.test(ex)) {
        // Legacy: "Only On: Mon" / "Every: Mon & Wed" — day-of-week filter only
        dowFilter = parseDowFilter(ex.replace(/^(?:only\s*on|every)\s*[:\-]?\s*/i, ''));

      } else if (/^condition\s*:/i.test(ex)) {
        // "Condition: Include W" / "Condition: Include WO" / "Condition: Include Week Off"
        //   → adhoc shift overrides WO days only.
        //   → AH, LH, PL, COFF are NOT overridden — they keep their own priority.
        // "Condition: Exclude W" / "Condition: Exclude WO" / "Condition: Exclude Week Off"
        //   → Week Off: <days> identifies which days to SKIP.
        //   → Adhoc is not applied on WO days; base schedule left completely unchanged.
        //   → AH, LH, PL, COFF are also NOT overridden.
        const cv = ex.replace(/^condition\s*:\s*/i, '').trim().toLowerCase();
        if (/^include/i.test(cv)) {
          extra._includeWO = true;
        } else if (/^exclude/i.test(cv)) {
          extra._excludeWO = true;
        }
      }
    }

    // overrideWO is true when:
    //   - date spec is "Always"
    //   - a woPattern (custom WO days) is set WITHOUT a Condition clause — defines new WO pattern
    //   - "Condition: Include WO" — overrides existing WO days with the adhoc shift
    const includeWO = !!(extra._includeWO);
    const excludeWO = !!(extra._excludeWO);

    // "Condition: Exclude WO": woPattern becomes a DOW exclusion filter.
    // Dates whose day-of-week is in the woPattern are SKIPPED entirely —
    // the base schedule on those days is left completely unchanged.
    // effectiveOverrideWO must stay false so WO days are not reassigned.
    const effectiveOverrideWO = includeWO || isAlways ||
                                 (!excludeWO && woPattern && woPattern.size > 0);

    // overrideHolidays is NEVER set for Include W / Exclude W.
    // Include W overrides WO days only — AH, LH, PL, COFF keep their own priority.
    // Exclude W skips WO days silently — AH, LH, PL, COFF also unaffected.
    const overrideHolidays = false;

    const dateDts = expandDateSpec(datePart);

    // Determine what to pass as woPattern and dowFilter to buildAdhocEntries:
    //  • Include W → woPattern=null (MODE B: override WO days with shift)
    //  • Exclude W → woPattern=null, exclusionFilter=woPattern (skip those DOWs)
    //  • No Condition, woPattern set → woPattern passed (MODE A: WO-setter)
    //  • dowFilter from "Only On:" → passed as-is when no woPattern
    const passWOPattern = (includeWO || excludeWO) ? null : woPattern;
    const passDOWFilter = excludeWO ? woPattern   // exclusion filter (skip matching DOWs)
                        : woPattern ? null         // woPattern active, suppress dowFilter
                        : dowFilter;               // plain day filter

    const entries = buildAdhocEntries(
      dateDts, shifts, rotation,
      passDOWFilter,
      shiftFilter,
      effectiveOverrideWO,
      empKey,
      passWOPattern,
      overrideHolidays,
      excludeWO             // when true: invert dowFilter (skip matching days, emit sentinel)
    );
    entries.forEach(e => adhocMap[empKey].push(e));
  });

  return { plMap, coffMap, adhocMap };
}

/* --- Override application --- */
/*
 * Priority (high to low):
 *   AH > LH > PL > COFF
 *     > Adhoc WO-override (isWOOverride=true)  — replaces group WO with custom pattern
 *     > Adhoc shift-override (overrideWO=true) — replaces shift AND group WO days
 *     > W (group week-off)
 *     > Adhoc normal (non-WO days only)
 *     > base rotation shift
 *
 * Full-schedule adhoc (e.g. "Always | Shift: E1 | Week Off: Mon & Wed"):
 *   • isWOOverride=true entries → force W on those days (overrides group Sat/Sun WO)
 *   • overrideWO=true, isWOOverride=false entries → force the adhoc shift on ALL other days
 *   • AH/LH still take top priority over everything
 *
 * Returns { schedule, adhocDates, adhocFixedShift }
 *   adhocFixedShift: the adhoc shift code if a full-schedule override is active,
 *                    used by generateRoster to update col-E and Summary.
 */
function applyOverrides(schedule, emp, ahSet, lhMap, plMap, coffMap, adhocMap, dates) {
  const nameKey    = emp.name.toLowerCase();
  const locKey     = emp.location.toLowerCase().replace(/\s+/g, '');
  const adhocDates = new Set();
  let   adhocFixedShift = null;  // set if a full-schedule WO override is active

  const entries = adhocMap[nameKey] || [];

  // ── Pre-scan: classify this employee's adhoc mode ─────────────────
  //
  //  Full-override (MODE A / Always):  entries have isWOOverride=true
  //    → adhocFixedShift = the non-WO shift code
  //
  //  Include WO (MODE B):              entries have overrideHolidays=true
  //    → adhocFixedShift = the shift code (all dates including WO get the shift)
  //
  //  Exclude WO (MODE C):              entries have overrideWO=false, no isWOOverride
  //    → adhocFixedShift = the shift code (WO days declared, non-WO dates get shift)
  //    → declared WO days are tracked via excludedWODays Set for explicit W enforcement
  //
  // Classify this employee's adhoc mode from the entry flags:
  //   MODE A (Always / woPattern): entries have isWOOverride=true
  //   MODE B (Include W):          entries have overrideWO=true, no isWOOverride, no isExcludedWO
  //   MODE C (Exclude W):          entries have isExcludedWO sentinel entries
  //   Normal adhoc:                entries have overrideWO=false, no special flags
  const hasFullOverride = entries.some(e => e.isWOOverride);
  const hasExcludeWO    = entries.some(e => e.isExcludedWO);
  // MODE B: overrideWO=true but not from a WO-setter (not isWOOverride)
  const hasIncludeW     = !hasFullOverride && !hasExcludeWO &&
                           entries.some(e => e.overrideWO === true && !e.isWOOverride);

  if (hasFullOverride) {
    // MODE A: fixed shift is the non-WO working-day shift.
    // IMPORTANT: only set adhocFixedShift (which triggers group-wide coverage replacement)
    // when there are actual working-day entries with a non-standard shift.
    // If all non-WO entries match the employee's own base schedule shift, this is
    // just a date-range adhoc with an explicit Week Off declaration — NOT a true
    // full-schedule override that should disrupt other employees' Week Offs.
    const shiftEntry = entries.find(e => e.overrideWO && !e.isWOOverride);
    if (shiftEntry && shiftEntry.shift && shiftEntry.shift !== 'W') {
      // Only activate group coverage replacement if this adhoc covers the ENTIRE schedule
      // period (i.e. the date spec was "Always" — every date in dates[] has an entry).
      // A bounded date-range adhoc (even with woPattern/Week Off declared) must NOT
      // trigger group-wide WO reshuffling; it only affects the pinned employee.
      const entryDateSet = new Set(entries.map(e => e.date));
      const allDatesStr  = dates.map(d => fmtDMY(d));
      const coversAll    = allDatesStr.every(d => entryDateSet.has(d));
      if (coversAll) {
        adhocFixedShift = shiftEntry.shift;
      }
    }
  } else if (hasIncludeW) {
    // MODE B: all entries carry the same shift code
    const shiftEntry = entries.find(e => e.overrideWO && e.shift && e.shift !== 'W');
    if (shiftEntry) adhocFixedShift = shiftEntry.shift;
  } else if (hasExcludeWO) {
    // MODE C: shift is carried by non-sentinel entries
    const shiftEntry = entries.find(e => !e.isExcludedWO && e.shift && e.shift !== 'W');
    if (shiftEntry) adhocFixedShift = shiftEntry.shift;
  }

  dates.forEach(dt => {
    const dStr = fmtDMY(dt);
    const cur  = schedule[dStr];
    const isWO = cur === 'W';

    // ── Priority chain (high to low): ────────────────────────────
    //   AH > LH > PL > COFF
    //     > MODE C: Exclude W  — declared WO days → keep W; working days → shift
    //     > MODE A: Full-override (Always/woPattern) — overrideWO entries
    //       ↳ isWOOverride=true  → force W (custom WO day)
    //       ↳ overrideWO=true    → force adhoc shift (overrides group WO)
    //     > MODE B: Include W   — overrideWO=true entries → override WO, respect AH/LH/PL/CO
    //     > Normal adhoc (non-overrideWO): skip WO days

    // AH / LH — always highest priority; nothing overrides them
    if (ahSet.has(dStr))                                { schedule[dStr] = 'AH'; return; }
    if (lhMap[locKey] && lhMap[locKey].has(dStr))       { schedule[dStr] = 'LH'; return; }
    // PL / COFF
    if (plMap[nameKey] && plMap[nameKey].has(dStr))     { schedule[dStr] = 'PL'; return; }
    if (coffMap[nameKey] && coffMap[nameKey].has(dStr)) { schedule[dStr] = 'CO'; return; }

    if (entries.length) {
      // MODE C — Exclude W: declared WO days → keep W; handled first so they're explicit
      const excludedEntry = entries.find(a => a.date === dStr && a.isExcludedWO);
      if (excludedEntry) {
        schedule[dStr] = 'W';
        return;
      }

      // MODE A + MODE B — entries with overrideWO=true
      // MODE A: isWOOverride=true → custom WO (force W), or overrideWO non-WO → force shift
      // MODE B (Include W): overrideWO=true, no isWOOverride → force shift (overrides group WO)
      // Both reach here; AH/LH/PL/CO already returned above so they're already protected.
      const dayEntry = entries.find(a => a.date === dStr && a.overrideWO);
      if (dayEntry) {
        if (dayEntry.isWOOverride) {
          // Custom WO day (MODE A only) — force W, don't add to adhocDates
          schedule[dStr] = 'W';
        } else {
          // Override the shift — works for both WO days (Include W) and working days
          const sh = (dayEntry.shift && dayEntry.shift !== 'ADHOC') ? dayEntry.shift : cur;
          schedule[dStr] = sh;
          if (sh !== 'W') adhocDates.add(dStr);
        }
        return;
      }

      // Normal adhoc (MODE C working days + legacy): skip WO days
      if (!isWO) {
        const entry = entries.find(a => a.date === dStr && !a.overrideWO);
        if (entry) {
          const sh = (entry.shift && entry.shift !== 'ADHOC') ? entry.shift : cur;
          schedule[dStr] = sh;
          if (sh !== 'W') adhocDates.add(dStr);
          return;
        }
      }
    }
  });

  return { schedule, adhocDates, adhocFixedShift };
}


/* ─── Allocation string parser ──────────────────────────────── */
