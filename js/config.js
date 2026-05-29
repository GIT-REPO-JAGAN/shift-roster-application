
'use strict';

/* ─── Constants ─────────────────────────────────────────────── */
const SHIFT_COLORS = {
  M:'#7ED084',  A:'#E9E7B8',  N:'#E1B79D',  E:'#B7C4D3',  E1:'#B7C4D3',
  G:'#D5B2D5',  WO:'#D9D9D9', W:'#D9D9D9',
  AH:'#8B0000', LH:'#8B0000', PL:'#8B0000', CO:'#003366', ADHOC:'#FFE0CC'
};
const SHIFT_TEXT = {
  M:'#111', A:'#111', N:'#111', E:'#111', E1:'#fff',
  G:'#111', WO:'#555', W:'#555',
  AH:'#fff', LH:'#fff', PL:'#fff', CO:'#fff', ADHOC:'#111'
};
const DEFAULT_RULES = [
  {skill:'Monitoring',              alloc:'[(N, M, A), (M, N, A)]',     rotation:'Static',    weekoff:'[(Mon & Tue), (Sat & Sun)]',                                   conditions:''},
  {skill:'Azure + Windows',         alloc:'[(N), (A), (G, G), (E)]',    rotation:'Static',    weekoff:'[(Thu & Fri), (Fri & Sat), (Sat & Sun), (Sat & Sun)]',          conditions:''},
  {skill:'SRE: Azure + Windows',    alloc:'[(E), (E1)]',                rotation:'Static',    weekoff:'[(Sat & Sun), (Sat & Sun)]',                                   conditions:''},
  {skill:'SME: Azure + Windows',    alloc:'[(A), (2E), (E1), (2E)]',    rotation:'Static',    weekoff:'[(Sat & Sun), (Sat & Sun), (Sat & Sun), (Sat & Sun)]',          conditions:''},
  {skill:'L2: Azure + Linux',       alloc:'[(E)]',                      rotation:'Static',    weekoff:'[(Sat & Sun)]',                                                conditions:''},
  {skill:'SRE: Azure /OCI + Linux', alloc:'[(A), (M)]',                 rotation:'Static',    weekoff:'[(Mon & Tue), (Sat & Sun)]',                                   conditions:''},
  {skill:'SME: Linux + OCI + Azure',alloc:'[(A), (M), (A), (2E1)]',    rotation:'Static',    weekoff:'[(Mon & Tue), (Sat & Sun), (Sat & Sun), (Sat & Sun)]',          conditions:''},
  {skill:'AKS: Azure + OCI Network',alloc:'[(E)]',                      rotation:'Static',    weekoff:'[(Sat & Sun)]',                                                conditions:''},
  {skill:'L2: OCI + Azure + Linux', alloc:'[(M), (N)]',                 rotation:'Static',    weekoff:'[(Wed & Thu), (Mon & Tue)]',                                   conditions:''},
];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* ─── State ─────────────────────────────────────────────────── */
let rosterData  = [];   // [{name, email, skill, location}, ...]
let skillGroups = {};   // {skillName: [emp, ...]}
let shiftRules  = [];   // [{skill, count, alloc, rotation, weekoff, conditions}, ...]

/* ─── Navigation ────────────────────────────────────────────── */
/* ─── Step → Card mapping ────────────────────────────────────── */
const STEP_CARD = {
  1: ['card-roster'],          // Upload Roster
  2: ['card-date'],            // Date Range
  3: ['automationCard','promptCard'],   // Shift Assignments
  4: ['card-leave'],           // Leave & Adhoc
  5: ['card-validate'],        // Validate
  6: ['card-generate'],        // Generate
};
// Cards that are always-open (no collapse). Only slElCard remains toggleable.
const ALWAYS_OPEN_CARDS = [
  'card-roster','card-date','automationCard','promptCard',
  'previewCard','card-leave','card-validate','card-generate','card-publish'
];
const ALL_CARDS = [
  ...ALWAYS_OPEN_CARDS, 'slElCard'
];

