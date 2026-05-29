'use strict';

function normalise(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}
function jaccardScore(a, b) {
  const wa = new Set(normalise(a).split(' '));
  const wb = new Set(normalise(b).split(' '));
  const inter = [...wa].filter(x => wb.has(x)).length;
  return inter / (new Set([...wa, ...wb]).size || 1);
}
function fuzzyMatch(skill) {
  let best = null, bestScore = 0;
  for (const r of DEFAULT_RULES) {
    const sc = jaccardScore(skill, r.skill);
    if (sc > bestScore) { bestScore = sc; best = r; }
  }
  return bestScore > 0.25 ? best : null;
}

/* ─── Rules table ───────────────────────────────────────────── */
function buildRulesFromSkills() {
  shiftRules = [];
  for (const [skill, emps] of Object.entries(skillGroups)) {
    const m = fuzzyMatch(skill);
    shiftRules.push(m
      ? { skill, count: emps.length, alloc: m.alloc, rotation: m.rotation, weekoff: m.weekoff, conditions: m.conditions }
      : { skill, count: emps.length, alloc: '[(M, A, N)]', rotation: 'Weekly', weekoff: '[(Sat & Sun)]', conditions: '' }
    );
  }
  renderRules();
  renderPreview();
}

/* ── Over-allocation check: total slot count — handles bracket AND flat formats ── */
function allocTotal(alloc) {
  if (!alloc) return 0;
  const s = alloc.trim();

  // Bracket format: [(A),(2E),(E1),(2E)]  or  [(N,M,A),(M,N,A)]
  if (s.startsWith('[') || s.startsWith('(')) {
    const inner = s.replace(/^\[/, '').replace(/\]$/, '').trim();
    const groups = [];
    let cur = '', depth = 0;
    for (const ch of inner) {
      if      (ch === '(') { depth++; cur += ch; }
      else if (ch === ')') { depth--; cur += ch; }
      else if (ch === ',' && depth === 0) { groups.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) groups.push(cur.trim());
    let total = 0;
    groups.forEach(g => {
      const inner2 = g.replace(/^\(/, '').replace(/\)$/, '').trim();
      inner2.split(',').map(t => t.trim()).filter(Boolean).forEach(tok => {
        const m = tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
        if (m) total += m[1] ? parseInt(m[1], 10) : 1;
      });
    });
    return total;
  }

  // Legacy flat: "M, A, N" or "2M, 1A"
  let total = 0;
  alloc.split(',').map(t => t.trim()).filter(Boolean).forEach(tok => {
    const m = tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
    if (m) total += m[1] ? parseInt(m[1], 10) : 1;
  });
  return total;
}

function renderRules() {
  const activeEl  = document.activeElement;
  const focusedId = (activeEl && activeEl.id && activeEl.id.startsWith('alloc_'))
    ? activeEl.id : null;
  const focusedWO = (activeEl && activeEl.id && activeEl.id.startsWith('wo_'))
    ? activeEl.id : null;

  const tbody = document.getElementById('rulesBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const ROT_OPTS = ['Weekly', 'Biweekly', 'Monthly', 'Static'];

  shiftRules.forEach((r, i) => {
    const total     = allocTotal(r.alloc);
    const empCount  = r.count;                     // always from roster
    const overAlloc = total > empCount && total > 0;
    const underAlloc = total > 0 && total < empCount;

    // Allocation field style
    const allocStyle = overAlloc
      ? 'border-color:#ff4444;background:rgba(255,68,68,.08);color:#ff7070'
      : underAlloc
      ? 'border-color:#f97316;background:rgba(249,115,22,.07);color:#fb923c'
      : '';

    // Alert line under alloc input
    const alertLine = overAlloc
      ? `<div style="color:#ff5555;font-size:9px;margin-top:3px;display:flex;align-items:center;gap:4px">
           <span style="background:rgba(255,70,70,.15);border:1px solid rgba(255,70,70,.4);border-radius:4px;padding:1px 6px;font-weight:700">
             ⚠ Over-Allocated (${total} > ${empCount})
           </span>
         </div>`
      : underAlloc
      ? `<div style="color:#f97316;font-size:9px;margin-top:3px;display:flex;align-items:center;gap:4px">
           <span style="background:rgba(249,115,22,.12);border:1px solid rgba(249,115,22,.35);border-radius:4px;padding:1px 6px;font-weight:700">
             ⚠ Under-Allocated (${total} < ${empCount})
           </span>
         </div>`
      : '';

    const tr = document.createElement('tr');
    tr.innerHTML =
      // Skill name
      `<td style="min-width:180px;font-weight:600">${esc(r.skill)}</td>` +

      // Count — read-only, auto-fetched from roster
      `<td style="min-width:52px">
         <span style="display:inline-flex;align-items:center;justify-content:center;
                      min-width:36px;padding:3px 8px;border-radius:5px;font-size:11px;
                      font-weight:700;background:rgba(124,106,247,.15);
                      color:#b0a6ff;border:1px solid rgba(124,106,247,.3)"
               title="Auto-fetched from roster">${r.count}</span>
       </td>` +

      // Shift Allocation — free-text input
      `<td style="min-width:220px">
         <input type="text" id="alloc_${i}" value="${esc(r.alloc)}"
           placeholder="e.g. [(N,M,A),(M,N,A)]"
           style="width:100%;${allocStyle}"
           oninput="shiftRules[${i}].alloc=this.value;renderPreview()"
           onblur="renderRules()"
           onkeydown="if(event.key==='Enter'){this.blur()}"
           autocomplete="off"
           aria-label="Allocation for ${esc(r.skill)}"
           title="${overAlloc ? 'Over-Allocated: total ' + total + ' exceeds ' + empCount + ' employees' : underAlloc ? 'Under-Allocated: total ' + total + ' for ' + empCount + ' employees' : ''}">
         ${alertLine}
       </td>` +

      // Rotation dropdown
      `<td style="min-width:140px">
         <select oninput="shiftRules[${i}].rotation=this.value;renderPreview()"
                 aria-label="Rotation for ${esc(r.skill)}">
           ${ROT_OPTS.map(v => `<option${r.rotation === v ? ' selected' : ''}>${v}</option>`).join('')}
         </select>
       </td>` +

      // Week Off — free-text input
      `<td style="min-width:200px">
         <input type="text" id="wo_${i}" value="${esc(r.weekoff)}"
           placeholder="e.g. [(Mon & Tue), (Sat & Sun)]"
           style="width:100%"
           oninput="shiftRules[${i}].weekoff=this.value;renderPreview()"
           onblur="renderRules()"
           onkeydown="if(event.key==='Enter'){this.blur()}"
           autocomplete="off"
           aria-label="Week off for ${esc(r.skill)}">
       </td>`;

    tbody.appendChild(tr);
  });

  // Restore focus
  const restoreId = focusedId || focusedWO;
  if (restoreId) {
    const el = document.getElementById(restoreId);
    if (el) { el.focus(); const len = el.value.length; el.setSelectionRange(len, len); }
  }
}

function clearRules()  { shiftRules = []; renderRules(); renderPreview(); }
function refillRules() { buildRulesFromSkills(); }

function renderPreview() {
  const card     = document.getElementById('previewCard');
  const tbody    = document.getElementById('previewBody');
  const subtitle = document.getElementById('previewSubtitle');
  if (!card || !tbody) return;

  /* ── helpers ──────────────────────────────────────────────── */

  // Parse bracket-format alloc string → array of {shift, count} per group
  // e.g. "[(N,M,A),(M,N,A)]" → [{shifts:['N','M','A']},{shifts:['M','N','A']}]
  // e.g. "[(E),(E1)]"        → [{shifts:['E']},{shifts:['E1']}]
  // e.g. "M, A, N"           → [{shifts:['M','A','N']}]  (single flat group)
  function parseGroups(raw) {
    if (!raw) return [];
    const s = raw.replace(/\[/g,'(').replace(/\]/g,')').trim();

    function splitBal(str) {
      const out=[]; let cur='', d=0;
      for(const ch of str){
        if(ch==='('){d++;cur+=ch;}
        else if(ch===')'){d--;cur+=ch;}
        else if(ch===','&&d===0){if(cur.trim())out.push(cur.trim());cur='';}
        else cur+=ch;
      }
      if(cur.trim())out.push(cur.trim());
      return out;
    }
    function stripOne(str){
      str=str.trim();
      if(!str.startsWith('(')||!str.endsWith(')'))return str;
      let d=0;
      for(let i=0;i<str.length;i++){
        if(str[i]==='(')d++;
        else if(str[i]===')'){d--;if(d===0)return i===str.length-1?str.slice(1,-1).trim():str;}
      }
      return str;
    }
    function expandSlots(raw){
      return splitBal(raw).map(t=>t.trim()).filter(Boolean).flatMap(tok=>{
        const m=tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
        return m?Array(m[1]?parseInt(m[1],10):1).fill(m[2].toUpperCase()):[];
      });
    }

    // Multi-group: starts with '(' and inner has sub-groups
    if(s.startsWith('(')){
      if(s.startsWith('((')){
        // double-bracket: ((A),(B)) → strip one layer → (A),(B)
        const inner=stripOne(s);
        const groups=splitBal(inner);
        if(groups.some(g=>g.trim().startsWith('('))){
          return groups.map(g=>expandSlots(stripOne(g)));
        }
      }
      // check if top-level is a multi-group: (A),(B)
      const top=splitBal(stripOne(s));
      if(top.length>1&&top.some(g=>g.trim().startsWith('('))){
        return top.map(g=>expandSlots(stripOne(g)));
      }
      // single group (E) or (N,M,A)
      return [expandSlots(stripOne(s))];
    }
    // flat: "M, A, N" or "2M, 1A"
    return [expandSlots(s)];
  }

  // Parse multi-group WO string → array of normalised WO strings
  function parseWOGroups(raw){
    if(!raw)return[];
    const s=raw.replace(/\[/g,'(').replace(/\]/g,')').trim();
    function splitBal(str){const out=[];let cur='',d=0;for(const ch of str){if(ch==='('){d++;cur+=ch;}else if(ch===')'){d--;cur+=ch;}else if(ch===','&&d===0){if(cur.trim())out.push(cur.trim());cur='';}else cur+=ch;}if(cur.trim())out.push(cur.trim());return out;}
    function stripOne(str){str=str.trim();if(!str.startsWith('(')||!str.endsWith(')'))return str;let d=0;for(let i=0;i<str.length;i++){if(str[i]==='(')d++;else if(str[i]===')'){d--;if(d===0)return i===str.length-1?str.slice(1,-1).trim():str;}}return str;}

    if(s.startsWith('(')){
      const inner=stripOne(s);
      const groups=splitBal(inner);
      // is it a multi-group WO: each element is a (Mon & Tue) group?
      if(groups.length>1&&groups.some(g=>g.trim().startsWith('('))){
        return groups.map(g=>stripOne(g).trim());
      }
      // single group
      return[stripOne(s).trim()];
    }
    // flat: "Sat & Sun" or already flat "Mon & Tue, Sat & Sun"
    const parts=splitBal(s);
    return parts.length>1?parts.map(p=>p.trim()):[s.trim()];
  }

  // Render coloured shift pills for an array of shift codes
  function shiftPills(shifts){
    return shifts.map(s=>{
      const bg=SHIFT_COLORS[s]||'#2a2a2a';
      const fg=SHIFT_TEXT[s]||'#aaa';
      return '<span style="display:inline-flex;align-items:center;justify-content:center;'
        +'min-width:22px;height:22px;padding:0 6px;border-radius:4px;'
        +'background:'+bg+';color:'+fg+';font-size:10px;font-weight:700;'
        +'letter-spacing:.3px;flex-shrink:0;line-height:1;white-space:nowrap">'
        +esc(s)+'</span>';
    }).join('');
  }

  // Render group pill blocks — each group in its own bordered capsule, same row, no wrap
  function groupPills(groups){
    if(!groups.length) return '<span style="color:var(--tx3)">—</span>';
    if(groups.length===1) return '<div class="alloc-cell">'+shiftPills(groups[0])+'</div>';
    const capsules = groups.map(g=>{
      return '<span style="display:inline-flex;align-items:center;gap:3px;'
        +'padding:2px 5px;border:1px solid rgba(255,255,255,.12);'
        +'border-radius:5px;background:rgba(255,255,255,.04);flex-shrink:0;'
        +'vertical-align:middle">'
        +shiftPills(g)+'</span>';
    }).join('');
    return '<div class="alloc-cell">'+capsules+'</div>';
  }

  /* ── Determine source and build display rows ──────────────── */
  let displayRows, sourceLabel;

  if (_promptMode && typeof promptRules !== 'undefined' && promptRules.length) {
    // ── PROMPT MODE ─────────────────────────────────────────────
    // Group sub-rules by skill, preserving per-group alloc + WO detail
    const skillMap = {};
    promptRules.forEach(r => {
      const key = r.skill || r._empTarget || '(employee)';
      if (!skillMap[key]) {
        skillMap[key] = {
          skill:    key,
          count:    0,
          groups:   [],   // array of shift arrays, one per sub-rule group
          woGroups: [],   // WO string per group
          rotation: r.rotation || '—',
          isEmp:    !!r._empTarget,
        };
      }
      const entry = skillMap[key];
      entry.count += (r.count || 1);
      // Build this sub-rule's shift array
      const grpShifts = parseAlloc(r.alloc);   // e.g. ['N','M','A'] or ['E']
      entry.groups.push(grpShifts);
      entry.woGroups.push(r.weekoff || '—');
      // Use first sub-rule's rotation (all same within a skill)
      if (!entry.rotation || entry.rotation === '—') entry.rotation = r.rotation;
    });

    displayRows = Object.values(skillMap);
    sourceLabel = 'Shift Assignments via Prompt';

  } else {
    // ── AUTOMATION MODE ──────────────────────────────────────────
    // Each shiftRule may have a bracket-format alloc and WO
    // Expand them the same way _expandAutomationRules does for display
    displayRows = (typeof shiftRules !== 'undefined' ? shiftRules : []).map(r => {
      const rawAlloc = (r.alloc || '').replace(/\[/g,'(').replace(/\]/g,')');
      const rawWO    = (r.weekoff || '').replace(/\[/g,'(').replace(/\]/g,')');
      const groups   = parseGroups(rawAlloc);
      const woGroups = parseWOGroups(rawWO);
      return {
        skill:    r.skill,
        count:    r.count,
        groups,
        woGroups,
        rotation: r.rotation || '—',
        isEmp:    false,
      };
    });
    sourceLabel = 'Shift Assignments via Automation';
  }

  if (!displayRows.length) { card.classList.remove('card-open'); return; }
  card.classList.add('card-open');
  if (subtitle) subtitle.textContent = 'Source: ' + sourceLabel + ' — resolved shift slots';

  /* ── Render table rows ────────────────────────────────────── */
  tbody.innerHTML = '';
  displayRows.forEach(row => {
    const emps   = (typeof skillGroups !== 'undefined' && skillGroups[row.skill]) || [];
    const empCnt = emps.length;

    // Total allocated slots = sum of all groups' lengths
    const totalSlots = row.groups.reduce((s, g) => s + g.length, 0);

    // Status: ✓ if count matches, ⚠ if mismatch (or unknown skill)
    let statusHtml;
    if (row.isEmp) {
      statusHtml = '<span style="color:var(--ac);font-size:10px">✓ employee</span>';
    } else if (empCnt === 0) {
      statusHtml = '<span style="color:var(--tx3);font-size:9px">—</span>';
    } else if (totalSlots === empCnt || totalSlots === 0) {
      statusHtml = '<span style="color:#22c55e;font-size:14px">&#10003;</span>';
    } else if (totalSlots > empCnt) {
      statusHtml = '<span style="color:var(--warn);font-size:10px" title="Over-allocated: '
        + totalSlots + ' slots, ' + empCnt + ' employees">&#9651; ' + totalSlots + '/' + empCnt + '</span>';
    } else {
      statusHtml = '<span style="color:var(--warn);font-size:10px" title="Under-allocated: '
        + totalSlots + ' slots, ' + empCnt + ' employees">&#9651; ' + totalSlots + '/' + empCnt + '</span>';
    }

    // WO display: show each group's WO joined if multiple
    const woUnique  = [...new Set(row.woGroups.filter(Boolean))];
    const woDisplay = row.woGroups.length > 1
      ? row.woGroups.map(w => w || '—').join(', ')
      : (row.woGroups[0] || '—');

    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'                             + esc(row.skill || '—')     + '</td>' +
      '<td>'                             + (row.count || 0)          + '</td>' +
      '<td>'                             + groupPills(row.groups)    + '</td>' +
      '<td>'                             + esc(row.rotation || '—')  + '</td>' +
      '<td>'                             + esc(woDisplay)            + '</td>' +
      '<td>'                             + statusHtml                + '</td>';
    tbody.appendChild(tr);
  });
}

/* ─── Holiday parsing ───────────────────────────────────────── */

function parseHolidays() {
  const ahRaw = document.getElementById('ahInput').value;
  const lhRaw = document.getElementById('lhInput').value;
  const ahPills = document.getElementById('ahPills');
  const lhPills = document.getElementById('lhPills');
  ahPills.innerHTML = '';
  lhPills.innerHTML = '';

  ahRaw.split(',').map(s => s.trim()).filter(s => /^\d{2}-\d{2}-\d{4}$/.test(s)).forEach(d => {
    const t = document.createElement('div');
    t.className = 'tag tag-ah'; t.textContent = 'AH ' + fmtHolDate(d);
    ahPills.appendChild(t);
  });
  lhRaw.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
    const m = line.match(/^(.+?)\s*[-\u2013]\s*(\d{2}-\d{2}-\d{4})/);
    if (m) {
      const t = document.createElement('div');
      t.className = 'tag tag-lh'; t.textContent = 'LH ' + m[1].trim() + ': ' + fmtHolDate(m[2]);
      lhPills.appendChild(t);
    }
  });
}

function fmtHolDate(dStr) {
  const [dd, mm, yyyy] = dStr.split('-');
  return dd + ' ' + MONTHS[parseInt(mm, 10) - 1] + ' ' + yyyy;
}

/* ─── Leave / Adhoc display parsing ────────────────────────── */
function parseLeaveDisplay() {
  const raw = document.getElementById('leaveInput').value;
  const div = document.getElementById('parsedLeave');
  div.innerHTML = '';
  if (!raw.trim()) return;

  // Build name set for real-time validation (case-insensitive)
  const nameSet    = new Set((rosterData || []).map(e => e.name.toLowerCase()));
  const rosterLoaded = nameSet.size > 0;

  let plCount = 0, coffCount = 0, adhocCount = 0, warnCount = 0;
  const items = [];

  raw.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('//') && !s.startsWith('#')).forEach(line => {
    let icon = '', label = '', cls = '', empName = '', unknown = false;

    if (/[\u2013\-]\s*PL[:\s]/i.test(line)) {
      const m = line.match(/^(.+?)\s*[\u2013\-]\s*PL:\s*(.+)$/i);
      if (!m) return;
      icon = ''; cls = 'pl'; empName = m[1].trim();
      label = '<b>' + esc(empName) + '</b> <span style="opacity:.7">PL</span> ' + esc(m[2].trim());

    } else if (/[\u2013\-]\s*COFF[:\s]/i.test(line)) {
      const m = line.match(/^(.+?)\s*[\u2013\-]\s*COFF:\s*(.+)$/i);
      if (!m) return;
      icon = ''; cls = 'co'; empName = m[1].trim();
      label = '<b>' + esc(empName) + '</b> <span style="opacity:.7">COFF</span> ' + esc(m[2].trim());

    } else if (/(?:[\u2013\-]\s*)?Adhoc(\s*Shift)?[:\s]/i.test(line)) {
      // Accept "Name Adhoc:", "Name – Adhoc:", "Name - Adhoc:"
      const m = line.match(/^(.+?)\s*(?:[\u2013\-]\s*)?Adhoc(?:\s*Shift)?:\s*(.+)$/i);
      if (!m) return;
      icon = ''; cls = 'adhoc'; empName = m[1].trim();
      const parts    = m[2].split('|').map(s => s.trim());
      // Extract clauses — Date:/Shift: prefixes accepted but not required (positional fallback)
      let dPart = '', sPart = '', extraParts = [];
      let pos = 0;
      for (const p of parts) {
        if (/^date\s*:/i.test(p))       { dPart = p.replace(/^date\s*:\s*/i,''); }
        else if (/^shift\s*:/i.test(p)) { sPart = p.replace(/^shift\s*:\s*/i,''); }
        else if (/^(?:rotation|week\s*off|only\s*on|every|condition)\s*[:\-]/i.test(p)) { extraParts.push(p); }
        else {
          if      (!dPart  && pos === 0) { dPart  = p; pos++; }
          else if (!sPart  && pos === 1) { sPart  = p; pos++; }
          else extraParts.push(p);
        }
      }
      const shiftBadge = sPart ? '<b style="color:var(--ac);background:rgba(255,193,7,.12);padding:1px 5px;border-radius:3px;font-size:10px">' + esc(sPart) + '</b>' : '';
      const extras = extraParts.map(p => '<span style="color:var(--tx3);font-size:9px">' + esc(p) + '</span>').join(' <span style="opacity:.4">|</span> ');
      label = '<b>' + esc(empName) + '</b>'
            + ' <span style="color:var(--tx3);font-size:9px;margin:0 2px">Adhoc</span>'
            + (shiftBadge ? ' ' + shiftBadge : '')
            + (dPart  ? ' <span style="color:var(--tx2);font-size:9px">' + esc(dPart) + '</span>' : '')
            + (extras ? ' <span style="opacity:.7;font-size:9px">| ' + extras + '</span>' : '');

    } else return;

    // Name validation: warn if roster is loaded and name is not found
    if (rosterLoaded && empName && !nameSet.has(empName.toLowerCase())) {
      unknown = true;
    }

    if (unknown) warnCount++;
    if (cls === 'pl') plCount++;
    else if (cls === 'co') coffCount++;
    else if (cls === 'adhoc') adhocCount++;
    items.push({ icon, label, cls, unknown });
  });

  // Summary bar
  if (items.length > 0) {
    const bar = document.createElement('div');
    bar.style.cssText = 'font-size:9px;color:var(--tx3);padding:2px 0 6px;display:flex;gap:10px;align-items:center';
    bar.innerHTML =
      (plCount   ? '<span style="color:#fff;background:rgba(255,57,33,.18);border:1px solid rgba(255,57,33,.3);padding:1px 7px;border-radius:3px;font-size:9px;font-weight:600">' + plCount + ' PL</span> ' : '') +
      (coffCount ? '<span style="color:#fff;background:rgba(160,112,255,.18);border:1px solid rgba(160,112,255,.3);padding:1px 7px;border-radius:3px;font-size:9px;font-weight:600">' + coffCount + ' COFF</span> ' : '') +
      (adhocCount? '<span style="color:#fff;background:rgba(240,165,0,.18);border:1px solid rgba(240,165,0,.3);padding:1px 7px;border-radius:3px;font-size:9px;font-weight:600">' + adhocCount + ' Adhoc</span> ' : '') +
      (warnCount ? '<span style="color:#fff;background:rgba(232,84,84,.18);border:1px solid rgba(232,84,84,.3);padding:1px 7px;border-radius:3px;font-size:9px;font-weight:600">⚠ ' + warnCount + ' name' + (warnCount>1?'s':'') + ' not in roster</span>' : '');
    div.appendChild(bar);
  }

  // Items
  items.forEach(({icon, label, cls, unknown}) => {
    const el = document.createElement('div');
    el.className = 'pitem ' + cls + (unknown ? ' name-warn' : '');
    el.innerHTML = icon + ' ' + label
      + (unknown ? ' <span style="color:var(--err);font-size:9px" title="Name not found in uploaded roster"> not in roster</span>' : '');
    div.appendChild(el);
  });
}

/* ─── Validation ────────────────────────────────────────────── */
function runValidation() {
  const res = [];

  // ── Roster ──────────────────────────────────────────────────────
  if (!rosterData.length) res.push({ t: 'err',  msg: 'No roster file uploaded.' });
  else                     res.push({ t: 'ok',   msg: 'Roster loaded: ' + rosterData.length + ' employees across ' + Object.keys(skillGroups).length + ' skill groups.' });

  // ── Date range ──────────────────────────────────────────────────
  const sd = document.getElementById('startDate').value;
  const ed = document.getElementById('endDate').value;
  if (!sd || !ed)                        res.push({ t: 'err',  msg: 'Date range is not set.' });
  else if (new Date(sd) > new Date(ed))  res.push({ t: 'err',  msg: 'Start date is after end date.' });
  else {
    const days = Math.round((new Date(ed) - new Date(sd)) / 86400000) + 1;
    res.push({ t: 'ok', msg: 'Date range: ' + fmtDisplay(sd) + ' → ' + fmtDisplay(ed) + ' (' + days + ' days).' });
  }

  // ── Shift rules — validate ONLY the active mode ─────────────────
  if (_promptMode) {
    // ── Prompt mode validation ────────────────────────────────────
    parsePromptRules();
    if (!promptRules.length) {
      res.push({ t: 'err', msg: 'Go With Prompt is active but no valid rules found. Enter at least one line in Shift Assignments via Prompt.' });
    } else {
      // Group sub-rules by skill (or _empTarget) for count checks
      const byTarget = {};
      promptRules.forEach(r => {
        const key = r._empTarget ? ('__emp:' + r._empTarget.toLowerCase()) : r.skill;
        if (!byTarget[key]) byTarget[key] = { count: 0, empCount: 0, isEmp: !!r._empTarget, name: r._empTarget || r.skill };
        byTarget[key].count += r.count;
        if (!r._empTarget) byTarget[key].empCount = (skillGroups[r.skill] || []).length;
        else byTarget[key].empCount = 1;
      });
      let overAlloc = 0;
      let countOk   = true;
      for (const [key, info] of Object.entries(byTarget)) {
        if (!info.isEmp && info.empCount === 0 && skillGroups[info.name] === undefined) {
          res.push({ t: 'warn', msg: '"' + info.name + '" not found in roster — will be skipped.' });
        } else if (info.count > info.empCount && info.empCount > 0) {
          res.push({ t: 'err', msg: info.name + ': allocation total (' + info.count + ') exceeds employee count (' + info.empCount + ').' });
          overAlloc++; countOk = false;
        }
      }
      if (!overAlloc && countOk) res.push({ t: 'ok', msg: 'All prompt rule assignments match the roster.' });
      const uniqueSkills = Object.values(byTarget).filter(t => !t.isEmp).length;
      const empTargets   = Object.values(byTarget).filter(t =>  t.isEmp).length;
      const parts = [];
      if (uniqueSkills) parts.push(uniqueSkills + ' skill' + (uniqueSkills !== 1 ? 's' : '') + ' configured');
      if (empTargets)   parts.push(empTargets + ' employee override' + (empTargets !== 1 ? 's' : ''));
      res.push({ t: 'ok', msg: parts.join(', ') + ' across ' + Object.keys(byTarget).length + ' target(s).' });
    }
  } else {
    // ── Automation mode validation ────────────────────────────────
    if (!shiftRules.length) {
      res.push({ t: 'warn', msg: 'No shift rules configured — defaults will be used.' });
    } else {
      let overAllocErr = 0, underAllocWarn = 0;
      for (const r of shiftRules) {
        const total = allocTotal(r.alloc);
        if (total > r.count) {
          res.push({ t: 'err', msg: r.skill + ': Over-Allocated — ' + total + ' slots > ' + r.count + ' employees. Fix before generating.' });
          overAllocErr++;
        } else if (total > 0 && total < r.count) {
          res.push({ t: 'warn', msg: r.skill + ': Under-Allocated — ' + total + ' slots < ' + r.count + ' employees.' });
          underAllocWarn++;
        }
      }
      let countOk = true;
      for (const r of shiftRules) {
        const allocs = parseAlloc(r.alloc);
        if (!allocs.length) res.push({ t: 'err', msg: r.skill + ': no shift allocation defined.' });
      }
      if (!overAllocErr && !underAllocWarn && countOk) res.push({ t: 'ok', msg: 'All skill group counts match the roster.' });
      res.push({ t: 'ok', msg: shiftRules.length + ' shift rule group(s) configured.' });
    }
  }

  // ── Active mode label ────────────────────────────────────────────
  res.push({ t: 'ok', msg: 'Active mode: ' + (_promptMode ? 'Shift Assignments via Prompt' : 'Shift Assignments via Automation') + '.' });

  // ── Leave entries ────────────────────────────────────────────────
  const leaveRaw = document.getElementById('leaveInput').value.trim();
  if (leaveRaw) {
    const { plMap, coffMap, adhocMap } = parseLeaveData([], {});
    const entries = Object.keys(plMap).length + Object.keys(coffMap).length + Object.keys(adhocMap).length;
    res.push({ t: 'ok', msg: entries + ' leave/adhoc override entries parsed.' });
    const nameSet = new Set(rosterData.map(e => e.name.toLowerCase()));
    for (const name of [...Object.keys(plMap), ...Object.keys(coffMap), ...Object.keys(adhocMap)]) {
      if (!nameSet.has(name.toLowerCase())) {
        res.push({ t: 'warn', msg: 'Leave entry name not found in roster: "' + name + '".' });
      }
    }
  }

  const div = document.getElementById('valResults');
  div.innerHTML = '';
  res.forEach(r => {
    const el  = document.createElement('div');
    el.className = 'vitem ' + r.t;
    const icon = r.t === 'ok' ? '✓' : r.t === 'warn' ? '⚠' : '✕';
    el.innerHTML = '<span class="vi-icon">' + icon + '</span>'
                 + '<span class="vi-msg">' + r.msg + '</span>';
    div.appendChild(el);
  });

  const hasErr = res.some(r => r.t === 'err');
  if (!hasErr) {
    document.getElementById('vbadge').style.display = 'flex';
    markDone(5);
    setTimeout(() => goStep(6), 350);  // auto-advance to Generate
  }
  return !hasErr;
}


function getAHSet() {
  const s = new Set();
  document.getElementById('ahInput').value.split(',').map(x => x.trim())
    .filter(x => /^\d{2}-\d{2}-\d{4}$/.test(x))
    .forEach(x => { try { s.add(fmtDMY(parseDMY(x))); } catch(_){} });
  return s;
}
function getLHMap() {
  const m = {};
  document.getElementById('lhInput').value.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
    const match = line.match(/^(.+?)\s*[-\u2013]\s*(\d{2}-\d{2}-\d{4})/);
    if (match) {
      const loc = match[1].trim().toLowerCase().replace(/\s+/g, '');
      if (!m[loc]) m[loc] = new Set();
      try { m[loc].add(fmtDMY(parseDMY(match[2]))); } catch(_){}
    }
  });
  return m;
}

/* --- Leave/Adhoc parsing --- */
/*
 * SUPPORTED FORMATS
 *
 * PL (Planned Leave) / COFF (Comp-Off):
 *   Name - PL: DD-MM-YYYY
 *   Name - PL: DD-MM-YYYY, DD-MM-YYYY
 *   Name - PL: DD-MM-YYYY to DD-MM-YYYY
 *   Name - PL: DD-MM-YYYY, DD-MM-YYYY to DD-MM-YYYY
 *
 * Adhoc Shift (pipe-delimited):
 *   Name - Adhoc Shift: <DATE> | <SHIFT> [| Rotation: ...] [| Week Off: ...] [| Only On: ...]
 *
 *   DATE:
 *     DD-MM-YYYY                    single date
 *     DD-MM-YYYY, DD-MM-YYYY        comma-sep dates
 *     DD-MM-YYYY to DD-MM-YYYY      range
 *     DD-MM-YYYY, DD-MM-YYYY to ... mixed combo
 *     Always                        all roster days (also overrides WO days)
 *
 *   SHIFT: G / M / A / N / E / E1  (or comma-sep list cycling per rotation period)
 *
 *   Rotation: Every Week
 *   Rotation: Every 2 Weeks | Every 2-Weeks
 *   Rotation: Every 3 Weeks | Every 3-Weeks
 *   Rotation: All Month     | Every Month
 *
 *   Week Off: M      apply only on days employee is scheduled as M
 *   Week Off: A / N / E / E1 / G  (comma-sep OK)
 *
 *   Only On: Mon                single weekday
 *   Only On: Mon, Wed, Fri      comma-sep weekdays
 *   Only On: Mon & Tue          & combos
 *   Only On: Mon to Fri         weekday range (inclusive)
 *   Only On: Tue to Thu
 *
 * WO protection:
 *   "Always" date spec: adhoc REPLACES the WO day.
 *   All other specs: WO days are protected (adhoc silently skipped).
 */

function _expandAutomationRules(rules) {
  const expanded = [];
  function _stripOne(s) {
    s = s.trim();
    if (!s.startsWith('(') || !s.endsWith(')')) return s;
    let d = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') { d--; if (d === 0) return i === s.length-1 ? s.slice(1,-1).trim() : s; }
    }
    return s;
  }
  function _splitBal(s) {
    const out = []; let cur = '', d = 0;
    for (const ch of s) {
      if      (ch === '(') { d++; cur += ch; }
      else if (ch === ')') { d--; cur += ch; }
      else if (ch === ',' && d === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function _expandSlots(raw) {
    return _splitBal(raw).map(s => s.trim()).filter(Boolean).flatMap(tok => {
      const m = tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
      return m ? Array(m[1] ? parseInt(m[1],10) : 1).fill(m[2].toUpperCase()) : [];
    });
  }
  function _isMultiGrp(s) {
    s = s.trim();
    if (!s.startsWith('(')) return false;
    if (s.startsWith('((')) return true;
    const inner  = _stripOne(s);
    const groups = _splitBal(inner);
    return groups.length > 1 && groups.some(g => g.trim().startsWith('('));
  }
  for (const rule of rules) {
    const rawAlloc = (rule.alloc  || '').replace(/\[/g,'(').replace(/\]/g,')').trim();
    const rawWO    = (rule.weekoff|| '').replace(/\[/g,'(').replace(/\]/g,')').trim();
    if (!_isMultiGrp(rawAlloc)) { expanded.push(rule); continue; }
    const skillName  = rule.skill;
    const totalEmps  = (skillGroups[skillName] || []).length;
    const shiftGroups = _splitBal(_stripOne(rawAlloc)).map(g => _expandSlots(_stripOne(g)));
    const numGroups   = shiftGroups.length;
    const woInner      = _isMultiGrp(rawWO) ? _stripOne(rawWO) : rawWO;
    let woGroupStrings = _splitBal(woInner).map(g => _normWeekoff(_stripOne(g)));
    while (woGroupStrings.length < numGroups) {
      woGroupStrings.push(woGroupStrings[woGroupStrings.length-1] || 'Sat & Sun');
    }
    const rotNorm    = _normRotation(rule.rotation || 'NA');
    const allUniform = shiftGroups.every(g => new Set(g).size <= 1);
    const flatPool   = shiftGroups.flat();
    const useCross   = allUniform && flatPool.length > 1 && rotNorm !== 'NA';
    let empOff = 0, poolOff = 0;
    shiftGroups.forEach((grpAllocs, grpIdx) => {
      const grpCount = Math.min(grpAllocs.length, totalEmps - empOff);
      if (grpCount <= 0) return;
      for (let ci = 0; ci < grpCount; ci++) {
        expanded.push({
          skill:        skillName,
          count:        1,
          alloc:        grpAllocs[ci] || grpAllocs[0],
          rotation:     rotNorm,
          weekoff:      woGroupStrings[grpIdx],
          conditions:   rule.conditions || '',
          _empSlice:    { start: empOff + ci, end: empOff + ci + 1 },
          _groupIdx:    grpIdx,
          _groupAllocs: shiftGroups,
          _groupWOs:    woGroupStrings,
          _numGroups:   numGroups,
          _groupPos:    ci,
          ...(useCross ? { _poolAllocs: flatPool, _poolIdx: poolOff + ci } : {})
        });
      }
      empOff  += grpCount;
      poolOff += grpAllocs.length;
    });
  }
  return expanded;
}


function _normRotation(rv) {
  const rvl = (rv || '').trim().toLowerCase()
                .replace(/-/g, ' ').replace(/\s+/g, ' ');

  if (/^(na|none|static|always)$/.test(rvl))                   return 'NA';
  if (/^(weekly|every\s*1?\s*week)$/.test(rvl))                return 'Every Week';
  if (/^(biweekly|bi\s*weekly|every\s*2\s*weeks?|2\s*weeks?)$/.test(rvl))
                                                                return 'Every 2 Weeks';
  if (/^(every\s*3\s*weeks?|3\s*weeks?)$/.test(rvl))           return 'Every 3 Weeks';
  if (/^(monthly|every\s*month|all\s*month|month)$/.test(rvl)) return 'Every Month';

  return rv.trim(); // pass-through for already-normalised or automation values
}

/* ─────────────────────────────────────────────────────────────────
 * rotOffset
 * Returns the rotation PERIOD number for a given date.
 *   Weekly    → floor(dateIdx / 7)          (changes every 7 days)
 *   Biweekly  → floor(dateIdx / 14)         (changes every 14 days)
 *   Monthly   → calendar months since start  (changes on 1st of month)
 *   Static/NA → 0                            (never changes)
 * ──────────────────────────────────────────────────────────────── */
function rotOffset(rotation, dateIdx, dt, startMonth) {
  const r = (rotation || '').toLowerCase().replace(/[-\s]+/g, ' ').trim();
  if (r === 'every week'  || r === 'weekly')                    return Math.floor(dateIdx / 7);
  if (r === 'every 2 weeks' || r === 'biweekly' || r === 'bi weekly') return Math.floor(dateIdx / 14);
  if (r === 'every 3 weeks')                                    return Math.floor(dateIdx / 21);
  if (r === 'every month' || r === 'monthly')
    return dt.getFullYear() * 12 + dt.getMonth() - startMonth;
  return 0; // static / NA / unknown → period never changes
}

/* ─────────────────────────────────────────────────────────────────
 * parsePromptLine
 *
 * Parses ONE line from the Shift Assignments via Prompt textarea.
 * Returns an array of sub-rule objects (one per employee or group).
 *
 * ── Supported formats ───────────────────────────────────────────
 *
 * FORMAT 1 — Employee-based:
 *   "Guru Prasad L – Shift: M | Rotation: Weekly | Week Off: Mon & Wed"
 *
 * FORMAT 2 — Skill, square-bracket groups (NEW canonical format):
 *   "Monitoring - Shift Allocation: [(N, M, A), (M, N, A)]
 *                | Rotation: Weekly
 *                | Week_Off: [(Mon & Tue), (Sat & Sun)]"
 *
 *   Each outer (…) inside the […] is one GROUP.
 *   Group i ↔ Week_Off group i.
 *   Rotation is applied uniformly across groups.
 *
 * FORMAT 3 — Skill, old double-bracket (backwards compat):
 *   "Monitoring - Shift Allocation: ((N, M, A), (M, N, A))
 *                | Rotation: Weekly
 *                | Week Off: ((Mon & Tue), (Sat & Sun))"
 *
 * FORMAT 4 — Skill, single flat list (backwards compat):
 *   "Monitoring - Shift Allocation: (2M, 2A, 1N)
 *                | Rotation: Monthly
 *                | Week Off: Sat & Sun"
 *
 * ── Sub-rule fields ─────────────────────────────────────────────
 *   skill, count, alloc, rotation, weekoff, conditions
 *   _empSlice   {start, end}        employee index range within skill group
 *   _empTarget  string              FORMAT 1 only: exact employee name
 *   _groupAllocs string[][]         all groups' flat alloc arrays
 *   _groupWOs   string[]            normalised WO per group (fixed, not rotated)
 *   _groupIdx   number              this sub-rule's group index
 *   _numGroups  number
 *   _groupPos   number              employee's position within their group
 *   _poolAllocs string[]            cross-group flat pool (uniform-shift groups)
 *   _poolIdx    number              employee's starting position in the pool
 * ──────────────────────────────────────────────────────────────── */
function parsePromptLine(line) {
  line = (line || '').trim();
  if (!line || line.startsWith('#')) return [];

  // ── Pre-normalise new-format syntax ──────────────────────────────
  // 1. Square brackets → parentheses so the rest of the parser is format-agnostic
  line = line.replace(/\[/g, '(').replace(/\]/g, ')');
  // 2. Week_Off → Week Off
  line = line.replace(/Week_Off\s*:/ig, 'Week Off:');

  // ── Separator: "- Shift Allocation:" or "– Shift:" ───────────────
  const SEP = /\s*[-–]\s*shift\s*(?:allocation\s*)?:\s*/i;
  const sepIdx = line.search(SEP);
  if (sepIdx < 0) return [];

  const entityName = line.slice(0, sepIdx).trim();
  const rest       = line.slice(sepIdx).replace(SEP, '').trim();

  // Pipe-split into clauses; first = shift spec
  const parts    = rest.split('|').map(s => s.trim()).filter(Boolean);
  const rawShift = parts[0] || '';

  // ── Inner helpers ─────────────────────────────────────────────────

  // Strip exactly one balanced outer () pair
  function stripOne(s) {
    s = s.trim();
    if (!s.startsWith('(') || !s.endsWith(')')) return s;
    let d = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') { d--; if (d === 0) return i === s.length - 1 ? s.slice(1,-1).trim() : s; }
    }
    return s;
  }

  // Comma-split respecting balanced ()
  function splitBal(s) {
    const out = []; let cur = '', d = 0;
    for (const ch of s) {
      if      (ch === '(') { d++; cur += ch; }
      else if (ch === ')') { d--; cur += ch; }
      else if (ch === ',' && d === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // Is this a multi-group spec? "(…), (…)" or "((…),(…))"
  function isMultiGrp(s) {
    s = s.trim();
    if (!s.startsWith('(')) return false;
    if (s.startsWith('((')) return true;
    const inner  = stripOne(s);
    const groups = splitBal(inner);
    return groups.length > 1 && groups.some(g => g.trim().startsWith('('));
  }

  // Expand "2M, N, 3E" → ['M','M','N','E','E','E']
  function expandSlots(raw) {
    return splitBal(raw).map(s => s.trim()).filter(Boolean).flatMap(tok => {
      const m = tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
      return m ? Array(m[1] ? parseInt(m[1], 10) : 1).fill(m[2].toUpperCase()) : [];
    });
  }

  // Extract a named clause value from the pipe-split parts
  function getClause(kw) {
    const re = new RegExp('^' + kw + '\\s*:\\s*', 'i');
    for (const p of parts.slice(1)) {
      if (re.test(p)) return p.replace(re, '').trim();
    }
    return '';
  }

  const rawRotation  = getClause('rotation');
  const rawWeekoff   = getClause('week\\s*(?:off|_off)') || getClause('weekoff');
  const rawCondition = getClause('condition');

  // ── FORMAT 1: Employee-based ──────────────────────────────────────
  // "Guru Prasad L – Shift: M | Rotation: Weekly | Week Off: Mon & Wed"
  const isEmp = !rawShift.includes('(') &&
    !!(skillGroups && Object.values(skillGroups).flat()
         .some(e => e.name.toLowerCase() === entityName.toLowerCase()));

  if (isEmp) {
    return [{
      skill:      null,
      _empTarget: entityName,
      count:      1,
      alloc:      rawShift.trim().toUpperCase(),
      rotation:   _normRotation(rawRotation  || 'Every Month'),
      weekoff:    _normWeekoff (rawWeekoff    || 'Rotation (6th & 7th Day)'),
      conditions: rawCondition.trim()
    }];
  }

  const skillName = entityName;
  const totalEmps = (skillGroups[skillName] || []).length;

  // ── FORMAT 2 / FORMAT 3: Multi-group spec ─────────────────────────
  // Handles both new square-bracket format [(A),(B),(C)] and old ((A),(B),(C))
  // After pre-normalisation both become ((A),(B),(C)) which isMultiGrp detects.
  if (isMultiGrp(rawShift)) {
    // Parse shift groups: e.g. "(N,M,A),(M,N,A)" → [['N','M','A'],['M','N','A']]
    const shiftGroups = splitBal(stripOne(rawShift))
      .map(g => expandSlots(stripOne(g)));
    const numGroups   = shiftGroups.length;

    // Overall rotation — single value applies to all groups
    const rotNorm = _normRotation((splitBal(stripOne(rawRotation))[0] || 'NA').trim());

    // Parse WO groups: "(Mon & Tue),(Sat & Sun)" → ['Mon & Tue','Sat & Sun']
    const woInner      = isMultiGrp(rawWeekoff) ? stripOne(rawWeekoff.trim()) : rawWeekoff.trim();
    let woGroupStrings = splitBal(woInner).map(g => _normWeekoff(stripOne(g)));
    // Pad to match numGroups
    while (woGroupStrings.length < numGroups) {
      woGroupStrings.push(woGroupStrings[woGroupStrings.length - 1] || 'Sat & Sun');
    }

    // ── Rotation model decision ──────────────────────────────────────
    //
    // INTRA-GROUP (e.g. Monitoring [(N,M,A),(M,N,A)]):
    //   Each group has DIVERSE shifts → group rotates its own array independently.
    //   Formula: homeGroup[(groupPos + period) % groupLen]
    //
    // CROSS-GROUP POOL (e.g. Azure+Windows [(N),(A),(G,G),(E)]):
    //   Each group is a UNIFORM sub-team (all employees have the same shift).
    //   All employees share one flat cross-group pool that rotates circularly.
    //   Formula: pool[(poolIdx + period) % poolLen]
    //
    // Heuristic: if EVERY group contains only one unique shift → cross-group pool.
    const allUniform = shiftGroups.every(g => new Set(g).size <= 1);
    const flatPool   = shiftGroups.flat();
    const useCross   = allUniform && flatPool.length > 1 && rotNorm !== 'NA';

    // Build sub-rules (one per employee)
    let empOff = 0, poolOff = 0;
    const subRules = [];
    shiftGroups.forEach((grpAllocs, grpIdx) => {
      const grpCount = Math.min(grpAllocs.length, totalEmps - empOff);
      if (grpCount <= 0) return;

      for (let ci = 0; ci < grpCount; ci++) {
        subRules.push({
          skill:        skillName,
          count:        1,
          alloc:        grpAllocs[ci] || grpAllocs[0],
          rotation:     rotNorm,
          weekoff:      woGroupStrings[grpIdx],
          conditions:   '',
          _empSlice:    { start: empOff + ci, end: empOff + ci + 1 },
          _groupIdx:    grpIdx,
          _groupAllocs: shiftGroups,
          _groupWOs:    woGroupStrings,
          _numGroups:   numGroups,
          _groupPos:    ci,               // position within group (for intra-group rotation)
          ...(useCross ? {
            _poolAllocs: flatPool,        // cross-group flat pool
            _poolIdx:    poolOff + ci     // starting position in pool
          } : {})
        });
      }
      empOff  += grpCount;
      poolOff += grpAllocs.length;
    });
    return subRules;
  }

  // ── FORMAT 4: Single-bracket / flat list ──────────────────────────
  // "(2M, 2A, 1N)" · "(E, E1)" · "(E)" · "M"
  //
  // Multi-slot with rotation → ALL employees share one circular pool.
  // Single-slot → plain static assignment.
  const allocSlots = splitBal(stripOne(rawShift))
    .map(s => s.trim()).filter(Boolean)
    .map(tok => {
      const m = tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
      return m ? { shift: m[2].toUpperCase(), count: parseInt(m[1] || '1', 10) } : null;
    }).filter(Boolean);
  if (!allocSlots.length) return [];

  // Full flat pool for pool-rotation
  const poolAllocs  = allocSlots.flatMap(s => Array(s.count).fill(s.shift));
  const poolRotNorm = _normRotation((splitBal(stripOne(rawRotation))[0] || 'NA').trim());
  const usePool     = poolAllocs.length > 1 && poolRotNorm !== 'NA';

  // WO: positional — slot[i] ↔ WO[i]; broadcast if only one WO given
  const woSlots  = splitBal(stripOne(rawWeekoff)).map(g => stripOne(g));
  const condList = splitBal(stripOne(rawCondition));

  function getV(arr, i, def) {
    if (!arr.length) return def;
    return arr.length === 1 ? arr[0] : (arr[i] !== undefined ? arr[i] : arr[arr.length - 1]);
  }

  let empOff2 = 0, poolOff2 = 0;
  const subRules4 = [];
  allocSlots.forEach((slot, idx) => {
    const weekoff    = _normWeekoff(getV(woSlots, idx, 'Rotation (6th & 7th Day)'));
    const conditions = getV(condList, idx, '').trim();

    for (let ci = 0; ci < slot.count; ci++) {
      subRules4.push({
        skill:      skillName,
        count:      1,
        alloc:      slot.shift,
        rotation:   usePool ? poolRotNorm : _normRotation(poolRotNorm),
        weekoff,
        conditions,
        _empSlice:  { start: empOff2 + ci, end: empOff2 + ci + 1 },
        ...(usePool ? {
          _poolAllocs: poolAllocs,
          _poolIdx:    poolOff2 + ci
        } : {})
      });
    }
    empOff2  += slot.count;
    poolOff2 += slot.count;
  });
  return subRules4;
}

/* Normalise a single week-off value string */
function _normWeekoff(wv) {
  wv = wv.trim();
  if (/sat.*sun|sun.*sat/i.test(wv))  return 'Sat & Sun';
  if (/7th\s*day/i.test(wv))         return 'Rotation (7th Day)';
  if (/6th.*7th|7th.*6th/i.test(wv))  return 'Rotation (6th & 7th Day)';
  return wv; // custom day pattern
}

/*
 * parsePromptLine — parse one prompt textarea line into an array of sub-rules.
 *
 * Format (new — comma-separated per alloc slot):
 *   Monitoring - Shift Allocation: 2M, 2A, 1N
 *              | Rotation: Monthly, Always, Weekly
 *              | Week Off: Mon & Wed, Thu & Fri, Sat & Sun
 *              | Condition: Exclude W, Include W, Exclude W
 *
 * Each comma-separated position in Rotation / Week Off / Condition maps to
 * the corresponding Shift Allocation slot (2M → slot 0, 2A → slot 1, 1N → slot 2).
 * A single value in any clause means "use this for ALL slots".
 *
 * Returns an ARRAY of sub-rule objects (one per alloc slot), each with:
 *   { skill, count, alloc, rotation, weekoff, conditions, _empSlice:{start,end} }
 * _empSlice tells generateRoster which employees from skillGroups[skill] to assign.
 *
 * Returns [] if the line cannot be parsed.
 */
/*
 * parsePromptLine — handles three assignment formats:
 *
 * 1. EMPLOYEE-BASED
 *    "Guru Prasad L – Shift: M | Rotation: Every Month | Week Off: Mon & Wed"
 *    Returns one sub-rule with _empTarget:'name' (exact employee name match).
 *
 * 2. SKILL — SINGLE BRACKET
 *    "Monitoring – Shift: (2M, 2A, 1N) | Rotation: Monthly, Always, Weekly
 *               | Week Off: (Mon & Wed, Thu & Fri, Sat & Sun)"
 *    Each comma-separated alloc slot maps to the corresponding Week Off / Rotation slot.
 *
 * 3. SKILL — DOUBLE BRACKET
 *    "Monitoring – Shift: ((M, A, N), (E, E1, N))
 *               | Week Off: ((Mon, Tue, Wed), (Thu, Fri, Sat))"
 *    Each outer group maps to the corresponding outer Week Off group.
 *    Within each group, shift order = employee order (slice).
 *
 * Returns an array of sub-rule objects or [] on failure.
 * Sub-rule fields: skill, count, alloc, rotation, weekoff, conditions,
 *                  _empSlice (optional), _empTarget (optional, for employee-based).
 */
/*
 * parsePromptLine — parses one prompt line into sub-rules.
 *
 * Supported formats
 * ─────────────────
 * FORMAT 1 — Employee-based:
 *   "Guru Prasad L – Shift: M | Rotation: Every Week | Week Off: Mon & Wed"
 *   → one sub-rule, _empTarget = employee name.
 *
 * FORMAT 2 — Skill, single-bracket:
 *   "Monitoring - Shift Allocation: (2M, 2A, 1N) | Rotation: Weekly
 *                | Week Off: (Mon & Tue, Thu & Fri, Sat & Sun)"
 *   Positional mapping: slot[i] ↔ WO[i].
 *
 * FORMAT 3 — Skill, double-bracket (canonical new format):
 *   "Monitoring - Shift Allocation: ((N, M, A), (M, N, A))
 *                | Rotation: Weekly
 *                | Week Off: ((Mon & Tue), (Sat & Sun))"
 *   Group i ↔ WO group i. Circular rotation: each group's array
 *   rotates left by 1 each period. Week-Off is FIXED per group (does
 *   not rotate). Always → period = 0 → no rotation.
 *
 * Returns: array of sub-rule objects.
 *
 * Sub-rule fields
 * ───────────────
 *   skill, count, alloc (comma-joined), rotation, weekoff, conditions
 *   _empSlice   {start, end}   — employee index range within skill group
 *   _empTarget  string         — FORMAT 1 only: exact employee name
 *   _groupIdx   number         — FORMAT 3: index of this group
 *   _groupAllocs string[][]    — FORMAT 3: all groups' flat alloc arrays
 *   _groupWOs   string[]       — FORMAT 3: normalised WO string per group
 *   _numGroups  number         — FORMAT 3: total number of groups
 */

/*
 * countPromptLineSlots
 * Counts the total number of employee slots specified in the raw shift allocation
 * string of a prompt line — WITHOUT applying any employee-count cap.
 *
 * This is the ground-truth for over-allocation detection:
 *   [(N,M,A),(M,N,A)]  → 3 + 3 = 6 slots
 *   [(N),(A),(G,G),(E)] → 1+1+2+1 = 5 slots
 *   (2M, 2A, 1N)        → 2+2+1  = 5 slots
 *   (E)                 → 1 slot
 *
 * Returns { skillName, rawSlots } or null if the line can't be parsed.
 */
function countPromptLineSlots(line) {
  line = line.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;

  // Split on first '-' that precedes 'Shift Allocation'
  const dashIdx = line.search(/\s*-\s*(?=shift\s+allocation\s*:)/i);
  if (dashIdx === -1) return null;

  const skillName = line.slice(0, dashIdx).trim();
  const rest      = line.slice(dashIdx + 1);

  // Extract the rawShift value
  const saMatch = rest.match(/shift\s+allocation\s*:\s*(.*?)(?:\||$)/i);
  if (!saMatch) return null;

  let rawShift = saMatch[1].trim();

  // Normalise square brackets → round brackets (same as parsePromptLine)
  rawShift = rawShift.replace(/\[/g, '(').replace(/\]/g, ')');

  // ── Helpers (self-contained copies) ───────────────────────────
  function _stripOne(s) {
    s = s.trim();
    if (!s.startsWith('(') || !s.endsWith(')')) return s;
    let d = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') { d--; if (d === 0) return i === s.length - 1 ? s.slice(1, -1).trim() : s; }
    }
    return s;
  }
  function _splitBal(s) {
    const out = []; let cur = '', d = 0;
    for (const ch of s) {
      if      (ch === '(') { d++; cur += ch; }
      else if (ch === ')') { d--; cur += ch; }
      else if (ch === ',' && d === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function _isMultiGrp(s) {
    s = s.trim();
    if (!s.startsWith('(')) return false;
    if (s.startsWith('((')) return true;
    const inner  = _stripOne(s);
    const groups = _splitBal(inner);
    return groups.length > 1 && groups.some(g => g.trim().startsWith('('));
  }
  function _expandSlots(raw) {
    return _splitBal(raw).map(s => s.trim()).filter(Boolean).flatMap(tok => {
      const m = tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
      return m ? Array(m[1] ? parseInt(m[1], 10) : 1).fill(m[2].toUpperCase()) : [];
    });
  }

  let rawSlots = 0;

  if (_isMultiGrp(rawShift)) {
    // FORMAT 2/3: [(N,M,A),(M,N,A)] or [(N),(A),(G,G),(E)]
    const inner  = _stripOne(rawShift);
    const groups = _splitBal(inner).map(g => _expandSlots(_stripOne(g)));
    rawSlots = groups.reduce((sum, g) => sum + g.length, 0);
  } else {
    // FORMAT 4: (2M, 2A, 1N) or (E) or E
    const tokens = _splitBal(_stripOne(rawShift));
    rawSlots = tokens.reduce((sum, tok) => {
      const m = tok.trim().match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
      return sum + (m ? parseInt(m[1] || '1', 10) : 0);
    }, 0);
  }

  return { skillName, rawSlots };
}

/* Parse all lines in the prompt textarea → populate promptRules array */
function parsePromptRules() {
  const el = document.getElementById('promptInput');
  const text = (el?.value || '').trim();

  if (!text) {
    promptRules = [];
    return;
  }

  // Each line returns an array of sub-rules; flatten all
  promptRules = text.split('\n')
    .flatMap(line => parsePromptLine(line))
    .filter(Boolean);
}

/* Validate prompt rules — over-allocation alert with chip highlighting */
function validatePromptRules() {
  const valEl    = document.getElementById('promptValidation');
  const statusEl = document.getElementById('promptStatus');
  if (!valEl) return;

  // ── Reset chip highlight states ───────────────────────────────
  document.querySelectorAll('#promptSkillTags .tag-skill').forEach(chip => {
    chip.classList.remove('tag-over', 'tag-under');
    chip.title = 'Click to insert this skill into the prompt';
  });

  const el   = document.getElementById('promptInput');
  const text = (el?.value || '').trim();

  if (!text || !promptRules.length) {
    valEl.style.display = 'none';
    if (statusEl) { statusEl.textContent = ''; statusEl.style.color = 'var(--tx3)'; }
    return;
  }

  // ── Count RAW slots per skill directly from prompt text ───────
  // Sub-rules in promptRules are already capped by totalEmps inside parsePromptLine,
  // so summing r.count always equals empCount — over-allocation is invisible that way.
  // We must count slots from the raw text BEFORE the employee-cap is applied.
  const rawBySkill = {};   // { skillName: { rawSlots, empCount, known } }

  text.split('\n').forEach(line => {
    const parsed = countPromptLineSlots(line);
    if (!parsed) return;
    const { skillName, rawSlots } = parsed;
    if (!skillName || !rawSlots) return;

    if (!rawBySkill[skillName]) {
      rawBySkill[skillName] = {
        rawSlots: 0,
        empCount: (skillGroups[skillName] || []).length,
        known:    !!(skillGroups[skillName])
      };
    }
    rawBySkill[skillName].rawSlots += rawSlots;
  });

  const uniqueSkillCount = Object.keys(rawBySkill).length;
  if (!uniqueSkillCount) {
    valEl.style.display = 'none';
    return;
  }

  // ── Classify ──────────────────────────────────────────────────
  let hasOver = false, hasUnknown = false;
  Object.entries(rawBySkill).forEach(([, info]) => {
    if (!info.known)                        hasUnknown = true;
    else if (info.rawSlots > info.empCount) hasOver    = true;
  });

  // ── Highlight chips ───────────────────────────────────────────
  document.querySelectorAll('#promptSkillTags .tag-skill').forEach(chip => {
    const chipSkill = chip.textContent.replace(/×\d+$/, '').trim();
    const info = rawBySkill[chipSkill];
    if (!info || !info.known) return;
    if (info.rawSlots > info.empCount) {
      chip.classList.add('tag-over');
      chip.title = 'Over-Allocated: ' + info.rawSlots + ' slots defined, only ' + info.empCount + ' employees';
    } else if (info.rawSlots < info.empCount) {
      chip.classList.add('tag-under');
      chip.title = 'Under-allocated: ' + info.rawSlots + ' of ' + info.empCount + ' employees assigned';
    }
  });

  // ── Success message (used in both states) ─────────────────────
  const successLine =
    '<div style="color:#22c55e;font-size:9px">'
    + '\u2713 ' + uniqueSkillCount + ' skill' + (uniqueSkillCount !== 1 ? 's' : '')
    + ' configured \u2014 will override Shift Assignments table during generation.'
    + '</div>';

  // ── All clean ─────────────────────────────────────────────────
  if (!hasOver && !hasUnknown) {
    valEl.style.display = 'block';
    valEl.innerHTML = successLine;
    if (statusEl) { statusEl.textContent = ''; statusEl.style.color = 'var(--tx3)'; }
    return;
  }

  // ── Build per-skill alert rows ────────────────────────────────
  const rows = Object.entries(rawBySkill).map(([skill, info]) => {
    const { rawSlots, empCount, known } = info;

    if (!known) {
      return '<div style="margin-bottom:4px">'
        + '<span style="color:#d4a843;font-size:9px">\u26a0 \u201c' + esc(skill) + '\u201d not found in roster \u2014 will be skipped</span>'
        + '</div>';
    }

    if (rawSlots <= empCount) return ''; // clean — no row

    // Over-allocation badge
    return '<div style="margin-bottom:5px">'
      + '<div style="display:inline-flex;align-items:center;gap:6px;'
      + 'background:rgba(255,70,70,.12);border:1px solid rgba(255,70,70,.45);'
      + 'border-radius:5px;padding:4px 10px">'
      + '<span style="color:#ff5555;font-size:9px;font-weight:700">\u26a0 Over-Allocated</span>'
      + '<span style="color:rgba(255,255,255,.4);font-size:9px">|</span>'
      + '<span style="color:#ffbbbb;font-size:9px">' + esc(skill) + '</span>'
      + '<span style="color:#ff7070;font-size:9px;font-weight:600">'
      + '(' + rawSlots + ' &gt; ' + empCount + ')'
      + '</span>'
      + '</div>'
      + '</div>';
  }).join('');

  valEl.style.display = 'block';
  valEl.innerHTML =
    successLine.replace('</div>',
      ' &nbsp;<span style="color:rgba(255,255,255,.3);font-size:9px">\u2014 see alerts below</span></div>')
    + '<div style="margin-top:6px">' + rows + '</div>';

  // ── Status label ──────────────────────────────────────────────
  if (statusEl) {
    if (hasOver) {
      statusEl.textContent = '\u26a0 Over-allocation detected \u2014 fix before generating.';
      statusEl.style.color = '#ff7070';
    } else if (hasUnknown) {
      statusEl.textContent = '\u26a0 Unknown skill(s) \u2014 check spelling.';
      statusEl.style.color = '#d4a843';
    } else {
      statusEl.textContent = '';
      statusEl.style.color = 'var(--tx3)';
    }
  }
}

/* Called on every keystroke in the prompt textarea */
function onPromptInput() {
  parsePromptRules();
  validatePromptRules();
  renderPreview();   // keep preview in sync with prompt content
}

/* Insert a template line for a skill when the chip is clicked */
function insertPromptSkill(skillName, empCount) {
  const el = document.getElementById('promptInput');
  if (!el) return;

  // Check if this skill already has a line
  const existing = el.value;
  const lineRe = new RegExp('^' + skillName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    + '\\s*[-\u2013]\\s*Shift Allocation:', 'mi');
  if (lineRe.test(existing)) {
    // Already there — just focus
    el.focus();
    return;
  }

  // Build a template line using the new format based on number of shifts in existing rule
  const existingRule = shiftRules.find(r => r.skill === skillName);
  const allocStr     = existingRule?.alloc || 'M, A, N';

  // Parse alloc into a shift list for the template
  const shiftList = allocStr.split(',').map(s => s.trim()).filter(Boolean).map(tok => {
    const m = tok.match(/^(\d+)?([A-Za-z][A-Za-z0-9]*)$/);
    return m ? m[2].toUpperCase() : tok;
  });

  let template;
  if (shiftList.length <= 2) {
    // Single-bracket format: "(M, E)"
    template = skillName + ' - Shift Allocation: (' + shiftList.join(', ') + ')'
      + ' | Rotation: Every Month'
      + ' | Week Off: (' + shiftList.map((_, i) => i === 0 ? 'Mon & Tue' : 'Wed & Thu').join(', ') + ')';
  } else {
    // Double-bracket format: split into two groups
    const g1 = shiftList.slice(0, Math.ceil(shiftList.length/2));
    const g2 = shiftList.slice(Math.ceil(shiftList.length/2));
    template = skillName + ' - Shift Allocation: ((' + g1.join(', ') + '), (' + g2.join(', ') + '))'
      + ' | Rotation: Weekly'
      + ' | Week Off: (Mon & Tue), (Wed & Thu)';
  }

  el.value = existing ? existing.trimEnd() + '\n' + template : template;
  el.focus();
  // Move cursor to end
  el.selectionStart = el.selectionEnd = el.value.length;
  onPromptInput();
}

function clearPromptInput() {
  const el = document.getElementById('promptInput');
  if (el) el.value = '';
  promptRules = [];
  const valEl = document.getElementById('promptValidation');
  if (valEl) valEl.style.display = 'none';
  const statusEl = document.getElementById('promptStatus');
  if (statusEl) statusEl.textContent = '';
}
