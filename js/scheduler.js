'use strict';

function assignWOPositions(weekoff, shiftSlotForFn, dates, empsCount) {
  if (weekoff === 'Sat & Sun') return null;

  const n     = empsCount;
  const is6   = weekoff === 'Rotation (6th & 7th Day)';
  const winDays = p => is6 ? [p % 7, (p + 1) % 7] : [p % 7];
  const overlaps2 = (p, q) => p === q || (p+1)%7 === q || p === (q+1)%7;
  const sameDay1  = (p, q) => p === q;

  // ── Build all (cyclePos, period) shift snapshots ──────────────
  // A "period snapshot" is the set of shifts at a particular cycle position
  // for each rotation period. We enumerate unique (period) combinations.
  const periodSnapshots = [];   // each entry: empIdx → shift for that rotation period
  const seenPeriods     = new Set();
  dates.forEach((dt, di) => {
    const cp = di % 7;
    if (cp !== 0) return;   // only first day of each cycle window
    // Get the period key for this day
    const snapshot = Array.from({ length: n }, (_, i) => shiftSlotForFn(i, di, dt));
    const key = snapshot.join(',');
    if (!seenPeriods.has(key)) { seenPeriods.add(key); periodSnapshots.push(snapshot); }
  });
  // Also include the very first day snapshot
  {
    const snap0 = Array.from({ length: n }, (_, i) => shiftSlotForFn(i, 0, dates[0]));
    const key0  = snap0.join(',');
    if (!seenPeriods.has(key0)) { seenPeriods.add(key0); periodSnapshots.unshift(snap0); }
  }

  // ── Coverage check for a candidate WO position ───────────────
  // For a given snapshot (period), check that adding woPos[candidateIdx]=pos
  // does not leave any defined shift with zero workers on any cycle day
  // covered by this position's window.
  function coverageOKForSnapshot(pos, candidateIdx, currentAssigned, snapshot) {
    const byShift = {};
    snapshot.forEach((sh, i) => { if (!byShift[sh]) byShift[sh] = []; byShift[sh].push(i); });

    const days = winDays(pos);
    // Build daily WO count (from already-assigned + candidate)
    const dayCnt = new Array(7).fill(0);
    currentAssigned.forEach((p, i) => { if (p != null) winDays(p).forEach(d => dayCnt[d]++); });

    for (const day of days) {
      // Max-2 global cap
      if (dayCnt[day] >= 2) return false;

      // Find all employees on WO on this cycle day (including candidate)
      const woEmps = currentAssigned
        .map((p, i) => (p != null && winDays(p).includes(day)) ? i : -1)
        .filter(i => i >= 0);
      woEmps.push(candidateIdx);  // include the candidate

      // For each defined shift in this period, ensure ≥1 working employee
      for (const [sh, members] of Object.entries(byShift)) {
        const working = members.filter(i => !woEmps.includes(i));
        if (working.length === 0) return false;  // shift would be uncovered
      }

      // Single-slot exclusivity: if candidate is sole on their shift in this period,
      // no other WO allowed on the same day
      const candSh      = snapshot[candidateIdx];
      const candShCount = byShift[candSh]?.length ?? 1;
      if (candShCount === 1 && dayCnt[day] >= 1) return false;

      // Converse: if any already-assigned employee is single-slot in this period,
      // candidate cannot WO on the same day
      for (let i = 0; i < n; i++) {
        if (currentAssigned[i] == null) continue;
        const iSh      = snapshot[i];
        const iShCount = byShift[iSh]?.length ?? 1;
        if (iShCount === 1 && winDays(currentAssigned[i]).includes(day)) return false;
      }
    }
    return true;
  }

  // Check all period snapshots for coverage
  function allPeriodsOK(pos, candidateIdx, currentAssigned) {
    return periodSnapshots.every(snap =>
      coverageOKForSnapshot(pos, candidateIdx, currentAssigned, snap)
    );
  }

  // ── Determine processing order: most-constrained first ───────
  // An employee is more constrained if they are single-slot in MORE periods
  function constraintScore(empIdx) {
    return periodSnapshots.reduce((sum, snap) => {
      const byShift = {};
      snap.forEach((sh, i) => { if (!byShift[sh]) byShift[sh] = []; byShift[sh].push(i); });
      const sh = snap[empIdx];
      return sum + (byShift[sh].length === 1 ? 1 : 0);
    }, 0);
  }
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => constraintScore(b) - constraintScore(a));

  const assigned = new Array(n).fill(null);

  for (const empIdx of order) {
    // Get the initial-period shift to determine same-shift neighbors for spacing
    const initSnap = periodSnapshots[0];
    const sh       = initSnap[empIdx];
    const sameInInit = periodSnapshots[0]
      .map((s, i) => (s === sh && assigned[i] != null) ? assigned[i] : null)
      .filter(p => p != null);

    const startPos = sameInInit.length > 0
      ? (Math.max(...sameInInit) + 3) % 7
      : (empIdx * 2) % 7;

    let pos = startPos, found = false;

    // Primary search: full coverage check across all periods
    for (let t = 0; t < 14; t++) {
      if (allPeriodsOK(pos, empIdx, assigned)) { found = true; break; }
      pos = (pos + 1) % 7;
    }

    // Fallback: relax to just same-shift non-overlap in initial period
    // (edge case: impossible to satisfy coverage for all periods simultaneously)
    if (!found) {
      pos = startPos;
      for (let t = 0; t < 7; t++) {
        const ok = is6
          ? !sameInInit.some(p => overlaps2(p, pos))
          : !sameInInit.some(p => sameDay1(p, pos));
        if (ok) { found = true; break; }
        pos = (pos + 1) % 7;
      }
    }
    assigned[empIdx] = pos;
  }

  return assigned.map(p => p ?? 0);
}

/* ─── Schedule builder ──────────────────────────────────────── */
/*
 * ROTATION RULES:
 *   Every Week    : slot advances every 7 calendar days
 *   Every 2 Weeks : slot advances every 14 calendar days
 *   Every 3 Weeks : slot advances every 21 calendar days
 *   Every Month   : one shift per calendar month, advances at month boundary
 *   NA / Static   : same shift for the entire roster period
 *
 * SHIFT STABILITY: within each rotation period the employee works ONE shift.
 *   shiftSlotFor(empIdx, di, dt) = allocs[(empIdx + rotOffset(di,dt)) % n]
 *
 * WO ASSIGNMENT:
 *   Positions are computed once via assignWOPositions (staggered, non-overlapping
 *   within same-shift groups). The 7-day cycle repeats unconditionally — no WOs
 *   are ever denied. Coverage gaps for single-slot employees are unavoidable.
 *
 * MAX_CONSEC_WORK:
 *   Hard cap after WO assignment. W/AH/LH/PL/CO all reset the counter.
 *   Only adds extra WOs if a run genuinely exceeds the limit.
 */
/*
 * buildSchedules — builds per-employee daily schedules for one sub-rule.
 *
 * Rotation model (double-bracket / FORMAT 3):
 *   Each group has a fixed shift array e.g. [N, M, A].
 *   Each rotation period, that array is rotated LEFT by 1.
 *   Employee keeps their POSITION within the array; the array shifts under them.
 *     period 0: emp[0]=N  emp[1]=M  emp[2]=A
 *     period 1: emp[0]=M  emp[1]=A  emp[2]=N    (left-rotated by 1)
 *     period 2: emp[0]=A  emp[1]=N  emp[2]=M    (left-rotated by 2)
 *   formula:  homeGroup[ (empIdx + period) % homeGroup.length ]
 *
 *   Week-Off is FIXED per group — it does NOT rotate.
 *
 * Rotation model (single-bracket / FORMAT 2 / automation):
 *   allocs[(empIdx + period) % n]
 *
 * rotOffset returns the period number for a given day index.
 */
function buildSchedules(emps, rule, dates) {
  /* ── Day-of-week abbreviation map ─────────────────────────── */
  const DOW = { mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,sun:0 };

  /* ── Parse a weekday pattern string → Set<dow> ─────────────── */
  function dowSet(pattern) {
    if (!pattern || !pattern.trim()) return null;
    const p = pattern.replace(/[()]/g,'').trim();
    const days = new Set();
    // "Mon to Fri" range
    const range = p.match(/^(\w+)\s+to\s+(\w+)$/i);
    if (range) {
      const s = DOW[range[1].toLowerCase().slice(0,3)];
      const e = DOW[range[2].toLowerCase().slice(0,3)];
      if (s != null && e != null) {
        const ord = [1,2,3,4,5,6,0];
        let on = false;
        for (const d of [...ord,...ord]) {
          if (d === s) on = true;
          if (on) days.add(d);
          if (d === e && on) break;
        }
        return days;
      }
    }
    // "Mon & Wed" or "Mon, Wed"
    p.split(/[,&]/).forEach(tok => {
      const k = tok.trim().toLowerCase().slice(0,3);
      if (DOW[k] != null) days.add(DOW[k]);
    });
    return days.size > 0 ? days : null;
  }

  /* ── Derive WO Set from a normalised WO string ─────────────── */
  function woSetFor(woStr) {
    if (!woStr) return null;
    if (/sat.*sun|sun.*sat/i.test(woStr)) {
      return new Set([0, 6]); // Sun, Sat
    }
    return dowSet(woStr);
  }

  /* ── allocs array and start month ──────────────────────────── */
  const allocs     = parseAlloc(rule.alloc);   // flat array e.g. ['N','M','A']
  const n          = allocs.length;
  const startMonth = dates.length
    ? dates[0].getFullYear() * 12 + dates[0].getMonth() : 0;

  /* ── Double-bracket group rotation ─────────────────────────── */
  // hasGroupRot: true when this sub-rule has a multi-group rotation defined
  // AND rotation is not NA/Always.
  const hasGroupRot = !!(
    rule._groupAllocs && rule._numGroups >= 1 &&
    rule.rotation !== 'NA'
  );

  /* ── shiftSlotFor: shift for employee empIdx on dateIdx di ─── */
  function shiftSlotFor(empIdx, di, dt) {
    const period = rotOffset(rule.rotation, di, dt, startMonth);

    // Cross-group pool rotation (FORMAT 2 single-bracket multi-slot, OR
    // FORMAT 3 double-bracket with uniform sub-teams).
    // _poolAllocs set by parser only when this mode applies.
    if (rule._poolAllocs) {
      return rule._poolAllocs[(rule._poolIdx + period) % rule._poolAllocs.length];
    }

    // FORMAT 3 intra-group rotation (diverse-shift groups like Monitoring).
    // Each group rotates its own array: homeGroup[(groupPos + period) % groupLen]
    // _groupPos is the employee's fixed index within their home group.
    if (hasGroupRot) {
      const homeGroup = rule._groupAllocs[rule._groupIdx];
      const groupPos  = rule._groupPos !== undefined ? rule._groupPos : empIdx;
      return homeGroup[(groupPos + period) % homeGroup.length];
    }

    // Standard single alloc / automation
    return allocs[(empIdx + period) % n];
  }

  /* ── WO mode detection ──────────────────────────────────────── */
  const STANDARD_WO = new Set(['Sat & Sun','Rotation (7th Day)','Rotation (6th & 7th Day)']);
  const isCustomWO  = rule.weekoff && !STANDARD_WO.has(rule.weekoff);

  // For group-rotation rules, WO is a fixed DOW set from the home group's WO string.
  let groupWOSet = null;
  if (rule._groupWOs) {
    groupWOSet = woSetFor(rule._groupWOs[rule._groupIdx] || '');
  }

  // For single-bracket custom WO: slotWODays[shift] = Set<dow>
  // Maps each shift code to its WO days (positional: slot i ↔ WO pattern i).
  let slotWODays = null;
  if (isCustomWO && !rule._groupWOs && !rule._poolAllocs) {
    // Standard single-slot custom WO: map each unique shift to its WO pattern
    const woPats   = rule.weekoff.split(',').map(s => s.trim()).filter(Boolean);
    const uniqSlots = [];
    allocs.forEach(s => { if (!uniqSlots.includes(s)) uniqSlots.push(s); });
    slotWODays = {};
    uniqSlots.forEach((slot, idx) => {
      slotWODays[slot] = dowSet(woPats[idx] || '');
    });
  }

  // For rotation-based WO (6th & 7th day / 7th day): pre-assign WO cycle positions
  const maxConsec = rule.weekoff === 'Rotation (6th & 7th Day)' ? 5
                  : rule.weekoff === 'Rotation (7th Day)'       ? 6
                  : Infinity;
  const woPos = (isCustomWO || !rule.weekoff ||
                 rule.weekoff === 'Sat & Sun' ||
                 (rule._groupWOs && groupWOSet))
              ? null
              : assignWOPositions(rule.weekoff, shiftSlotFor, dates, emps.length);

  /* ── Build daily schedules ───────────────────────────────────── */
  const dStrs     = dates.map(d => fmtDMY(d));
  const rawScheds = emps.map((emp, empIdx) => {
    const sched = {};
    dates.forEach((dt, di) => {
      const shift = shiftSlotFor(empIdx, di, dt);
      let   wo    = false;
      const dow   = dt.getDay();  // 0=Sun…6=Sat

      if (rule._groupWOs && groupWOSet) {
        // GROUP-ROTATION: WO is the home group's fixed WO pattern.
        wo = groupWOSet.has(dow);
      } else if (isCustomWO && slotWODays) {
        // SINGLE-BRACKET CUSTOM WO: shift-code → WO days.
        const ds = slotWODays[shift];
        if (ds) wo = ds.has(dow);
      } else if (rule.weekoff === 'Sat & Sun') {
        wo = dow === 0 || dow === 6;
      } else if (woPos) {
        const cp = di % 7;
        wo = rule.weekoff === 'Rotation (6th & 7th Day)'
          ? (cp === woPos[empIdx] || cp === (woPos[empIdx] + 1) % 7)
          : (cp === woPos[empIdx]);
      }

      sched[dStrs[di]] = wo ? 'W' : shift;
    });
    return sched;
  });

  /* ── Consecutive-work hard cap (rotation-based WO only) ─────── */
  if (isFinite(maxConsec)) {
    const REST = new Set(['W','AH','LH','PL','CO']);
    emps.forEach((_, ei) => {
      let streak = 0;
      for (let di = 0; di < dStrs.length; di++) {
        const d = dStrs[di];
        if (REST.has(rawScheds[ei][d])) { streak = 0; }
        else { streak++; if (streak > maxConsec) { rawScheds[ei][d] = 'W'; streak = 0; } }
      }
    });
  }

  return { rawScheds, fixedShifts: emps.map((_, i) => shiftSlotFor(i, 0, dates[0])) };
}



