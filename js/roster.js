'use strict';

function showUploadErr(msg) {
  // Show error inline on the upload zone
  const zone  = document.getElementById('upzone');
  const icon  = document.getElementById('upIcon');
  const text  = document.getElementById('upText');
  if (zone)  { zone.classList.remove('ready'); zone.style.borderColor = '#ff4444'; }
  if (icon)  { icon.textContent = '!'; }
  if (text)  { text.textContent = msg; text.style.color = '#ff7777'; }
  // Reset after 6 seconds so user can try again
  setTimeout(() => {
    if (zone) zone.style.borderColor = '';
    if (icon) icon.textContent = '↑';
    if (text) { text.textContent = 'Drop your roster .xlsx here, or click to browse'; text.style.color = ''; }
  }, 6000);
}

function handleFile(file) {
  if (!file) return;
  if (_fileProcessing) return;   // re-entrant guard
  _fileProcessing = true;

  // Guard: xlsx-js-style must be loaded
  if (typeof XLSX === 'undefined' || !XLSX.read) {
    _fileProcessing = false;
    showUploadErr('Excel library not loaded — check your internet connection and reload the page.');
    return;
  }

  // Validate file extension
  const name = (file.name || '').toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    showUploadErr('Wrong file type: please upload an .xlsx or .xls file.');
    _fileProcessing = false;
    return;
  }

  // Show loading state
  document.getElementById('upIcon').textContent = '⏳';
  document.getElementById('upText').textContent = 'Reading ' + file.name + '…';

  const reader = new FileReader();

  reader.onerror = function() {
    _fileProcessing = false;
    showUploadErr('Could not read "' + file.name + '". Try again or use a different file.');
  };

  reader.onload = function(ev) {
    try {
      const data = new Uint8Array(ev.target.result);

      // XLSX.read can throw on corrupted files — catch it
      let wb;
      try {
        wb = XLSX.read(data, { type: 'array' });
      } catch(parseErr) {
        _fileProcessing = false;
        showUploadErr('Cannot parse "' + file.name + '": ' + parseErr.message +
          '. Ensure the file is not password-protected or corrupted.');
        return;
      }

      if (!wb.SheetNames || !wb.SheetNames.length) {
        _fileProcessing = false;
        showUploadErr('The Excel file is empty or has no sheets.');
        return;
      }

      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (!rows.length) {
        _fileProcessing = false;
        showUploadErr('The first sheet is empty — no data found.');
        return;
      }

      // Find header row: scan first 10 rows for a cell equal to "name"
      let hRow = -1;
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        if (rows[i].some(c => String(c).trim().toLowerCase() === 'name')) {
          hRow = i; break;
        }
      }
      if (hRow < 0) {
        _fileProcessing = false;
        const found = rows[0].slice(0, 8).map(c => String(c).trim() || '(blank)').join(', ');
        showUploadErr(
          'No "Name" column found in first 10 rows. ' +
          'Required columns: Name, Email, Skill, Location. ' +
          'Row 1 has: ' + found
        );
        return;
      }

      const headers = rows[hRow].map(c => String(c).trim().toLowerCase());
      const ci = {
        name:     headers.indexOf('name'),
        email:    headers.indexOf('email'),
        skill:    headers.indexOf('skill'),
        location: headers.indexOf('location')
      };

      if (ci.name < 0) {
        _fileProcessing = false;
        showUploadErr('Required column "Name" not found. Columns detected: ' + headers.filter(Boolean).join(', '));
        return;
      }
      if (ci.skill < 0) {
        _fileProcessing = false;
        showUploadErr('Required column "Skill" not found. Columns detected: ' + headers.filter(Boolean).join(', '));
        return;
      }

      rosterData  = [];
      skillGroups = {};

      for (let i = hRow + 1; i < rows.length; i++) {
        const r    = rows[i];
        if (!r || !r.length) continue;
        const nm = String(r[ci.name] != null ? r[ci.name] : '').trim();
        if (!nm) continue;

        const emp = {
          name:     nm,
          email:    (ci.email    >= 0 && r[ci.email]    != null) ? String(r[ci.email]   ).trim() : '',
          skill:    (ci.skill    >= 0 && r[ci.skill]    != null) ? String(r[ci.skill]   ).trim() : 'General',
          location: (ci.location >= 0 && r[ci.location] != null) ? String(r[ci.location]).trim() : ''
        };
        if (!emp.skill) emp.skill = 'General';

        rosterData.push(emp);
        if (!skillGroups[emp.skill]) skillGroups[emp.skill] = [];
        skillGroups[emp.skill].push(emp);
      }

      if (!rosterData.length) {
        _fileProcessing = false;
        showUploadErr('No employee rows found after the header row. Check your file has data below the header.');
        return;
      }

      showUploadSuccess(file.name, file.size);
      // Guard: buildRulesFromSkills is defined in rules.js which may load
      // after roster.js in the multi-file version — use setTimeout to defer
      // until all scripts have loaded, and typeof-check as belt-and-suspenders.
      if (typeof buildRulesFromSkills === 'function') {
        buildRulesFromSkills();
      } else {
        setTimeout(function() {
          if (typeof buildRulesFromSkills === 'function') buildRulesFromSkills();
        }, 0);
      }
      // renderPreview so the preview table reflects the loaded roster
      if (typeof renderPreview === 'function') renderPreview();
      _fileProcessing = false;

    } catch (err) {
      _fileProcessing = false;
      showUploadErr('Unexpected error: ' + err.message + '. Ensure the file is a valid .xlsx.');
    }
  };

  reader.readAsArrayBuffer(file);
}

function showErr(msg) { alert(msg); }

function showUploadSuccess(fname, fsize) {
  const zone = document.getElementById('upzone');
  zone.classList.add('ready');
  document.getElementById('upIcon').textContent = '✓';
  document.getElementById('upText').textContent  = 'File ready · ' + Math.round(fsize / 1024) + ' KB';
  const fn = document.getElementById('upFname');
  fn.textContent = fname; fn.style.display = 'block';

  // Roster upload skill chips (step 1 card)
  const tagsEl = document.getElementById('skillTags');
  tagsEl.innerHTML = '';
  for (const [sk, emps] of Object.entries(skillGroups)) {
    const t = document.createElement('div');
    t.className = 'tag tag-skill'; t.setAttribute('role', 'listitem');
    t.innerHTML = esc(sk) + ' <span class="skcnt" aria-label="' + emps.length + ' employees">\xd7' + emps.length + '</span>';
    tagsEl.appendChild(t);
  }
  document.getElementById('skillBlock').style.display = 'block';

  // Prompt card skill chips (step 3b card)
  const promptTagsEl = document.getElementById('promptSkillTags');
  if (promptTagsEl) {
    promptTagsEl.innerHTML = '';
    for (const [sk, emps] of Object.entries(skillGroups)) {
      const chip = document.createElement('div');
      chip.className = 'tag tag-skill';
      chip.setAttribute('role', 'listitem');
      chip.style.cursor = 'pointer';
      chip.title = 'Click to insert this skill into the prompt';
      chip.innerHTML = esc(sk) + ' <span class="skcnt">\xd7' + emps.length + '</span>';
      // Click to insert a template line for this skill
      chip.addEventListener('click', () => insertPromptSkill(sk, emps.length));
      promptTagsEl.appendChild(chip);
    }
    const promptSkillBlock = document.getElementById('promptSkillBlock');
    if (promptSkillBlock) promptSkillBlock.style.display = 'block';
  }

  markDone(1);
  setTimeout(() => goStep(2), 400);  // auto-advance to Date Range after roster loads
}

/* ─── Fuzzy skill matching ──────────────────────────────────── */
