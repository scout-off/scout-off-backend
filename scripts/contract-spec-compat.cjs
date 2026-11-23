#!/usr/bin/env node
'use strict';
// Fail-closed Soroban ABI comparison. Input JSON comes from:
// stellar contract info interface --wasm <path> --output json
const fs = require('node:fs');
const path = require('node:path');

function entries(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.entries)) return value.entries;
  if (value && Array.isArray(value.spec)) return value.spec;
  throw new Error('Unrecognised Stellar CLI contract interface JSON. Refusing to pass.');
}
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !['doc','docs','documentation','docString','doc_string'].includes(k))
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => [k, canon(v)]));
}
function same(a,b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
function decodeEntry(entry) {
  const variants = {
    functionV0: ['functionV0','function_v0'],
    udtStructV0: ['udtStructV0','udt_struct_v0'],
    udtUnionV0: ['udtUnionV0','udt_union_v0'],
    udtEnumV0: ['udtEnumV0','udt_enum_v0'],
    udtErrorEnumV0: ['udtErrorEnumV0','udt_error_enum_v0'],
    eventV0: ['eventV0','event_v0'],
  };
  for (const [kind, keys] of Object.entries(variants)) {
    for (const field of keys) if (entry && entry[field]) return {kind, body: entry[field]};
  }
  const kind = typeof entry?.type === 'string' ? entry.type : entry?.kind;
  const translated = {
    function:'functionV0', scSpecEntryFunctionV0:'functionV0',
    udtStruct:'udtStructV0', scSpecEntryUdtStructV0:'udtStructV0',
    udtUnion:'udtUnionV0', scSpecEntryUdtUnionV0:'udtUnionV0',
    udtEnum:'udtEnumV0', scSpecEntryUdtEnumV0:'udtEnumV0',
    udtErrorEnum:'udtErrorEnumV0', scSpecEntryUdtErrorEnumV0:'udtErrorEnumV0',
    event:'eventV0', scSpecEntryEventV0:'eventV0',
    SC_SPEC_ENTRY_FUNCTION_V0:'functionV0',SC_SPEC_ENTRY_UDT_STRUCT_V0:'udtStructV0',
    SC_SPEC_ENTRY_UDT_UNION_V0:'udtUnionV0',SC_SPEC_ENTRY_UDT_ENUM_V0:'udtEnumV0',
    SC_SPEC_ENTRY_UDT_ERROR_ENUM_V0:'udtErrorEnumV0',SC_SPEC_ENTRY_EVENT_V0:'eventV0',
  }[kind];
  if (translated) return {kind: translated, body: entry};
  throw new Error(`Unknown contract spec entry kind ${JSON.stringify(kind)}. Refusing to pass.`);
}
function byKey(spec) {
  const map = new Map();
  for (const entry of entries(spec)) {
    const {kind, body} = decodeEntry(entry);
    if (typeof body.name !== 'string') throw new Error(`Unnamed spec entry ${kind}`);
    const key = `${kind}:${body.name}`;
    if (map.has(key)) throw new Error(`Duplicate spec entry: ${key}`);
    map.set(key, {kind, body});
  }
  return map;
}
function check(previous, proposed, contract='contract') {
  const oldMap = byKey(previous), newMap = byKey(proposed);
  const breaking = [], additions=[];
  for (const [key, oldEntry] of oldMap) {
    const latest = newMap.get(key);
    if (!latest) { breaking.push(`${contract}: removed or renamed ${key}`); continue; }
    const {kind, body: before} = oldEntry;
    const after = latest.body;
    if (kind === 'udtEnumV0' || kind === 'udtErrorEnumV0') {
      if (!Array.isArray(before.cases) || !Array.isArray(after.cases)) {
        breaking.push(`${contract}: malformed enum ${key}`); continue;
      }
      for (let i=0; i<before.cases.length; i++) {
        if (!same(before.cases[i], after.cases[i])) {
          breaking.push(`${contract}: ${kind === 'udtErrorEnumV0' ? 'error-code renumbering/reordering' : 'enum variant changed'} at ${key}[${i}]`);
        }
      }
      if (after.cases.length < before.cases.length) breaking.push(`${contract}: removed enum cases ${key}`);
      continue;
    }
    if (!same(before, after)) breaking.push(`${contract}: incompatible interface/layout change ${key}`);
  }
  for (const key of newMap.keys()) if (!oldMap.has(key)) additions.push(`${contract}: new ${key}`);
  return {breaking, additions};
}
function compareDirs(baseDir, headDir) {
  const names = new Set([...fs.readdirSync(baseDir).filter(n=>n.endsWith('.json')), ...fs.readdirSync(headDir).filter(n=>n.endsWith('.json'))]);
  const result = {breaking:[], additions:[]};
  for (const file of [...names].sort()) {
    const oldPath = path.join(baseDir,file), newPath=path.join(headDir,file);
    if (!fs.existsSync(oldPath)) {result.additions.push(`new contract ${file}`); continue;}
    if (!fs.existsSync(newPath)) {result.breaking.push(`removed contract ${file}`); continue;}
    const r=check(JSON.parse(fs.readFileSync(oldPath,'utf8')),JSON.parse(fs.readFileSync(newPath,'utf8')),file);
    result.breaking.push(...r.breaking); result.additions.push(...r.additions);
  }
  return result;
}
if (require.main===module) {
  try {
    const [baseDir, headDir]=process.argv.slice(2);
    if (!baseDir || !headDir) throw new Error('Usage: node scripts/contract-spec-compat.cjs BASE_SPECS HEAD_SPECS');
    const {breaking, additions}=compareDirs(baseDir,headDir);
    const lines=['# Soroban contract interface compatibility', '', ...additions.map(s=>`- ✅ ${s}`), ...breaking.map(s=>`- ❌ **Breaking:** ${s}`)];
    if (!breaking.length) lines.push('- ✅ No breaking changes detected');
    const report=lines.join('\n')+'\n';
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,report);
    if (breaking.length && process.env.CONTRACT_BREAKING_CHANGE_ACKNOWLEDGED !== 'true') process.exitCode=1;
    if (breaking.length && process.env.CONTRACT_BREAKING_CHANGE_ACKNOWLEDGED === 'true') console.warn('Acknowledged contract-breaking-change. Maintainer review required.');
  } catch (e) { console.error(e); process.exitCode=1; }
}
module.exports={check, compareDirs};
