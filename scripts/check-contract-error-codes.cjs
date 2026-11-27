#!/usr/bin/env node
'use strict';
// Check explicit #[contracterror] numeric assignments independently of the WASM interface.
const fs = require('node:fs');
function errorMap(text) {
  // Guard against incidental docs/comments by restricting to pub enum Error.
  const block = /pub\s+enum\s+Error\s*\{([\s\S]*?)\n\}/.exec(text);
  if (!block) throw new Error('Cannot find contract Error enum');
  const result = new Map();
  for (const match of block[1].matchAll(/^\s*([A-Za-z_][\w]*)\s*=\s*(\d+)\s*,/gm)) {
    if(result.has(match[1])) throw new Error(`Duplicate error name ${match[1]}`);
    result.set(match[1], Number(match[2]));
  }
  if(result.size === 0) throw new Error('No explicit contract error values found');
  return result;
}
function diffErrors(base,head) {
  const previous=errorMap(base),current=errorMap(head),errors=[];
  for(const [name,id] of previous) {
    if(!current.has(name)) errors.push(`Removed error ${name}=${id}`);
    else if(current.get(name)!==id) errors.push(`Renumbered error ${name}: ${id} -> ${current.get(name)}`);
  }
  for(const [name,id] of current) {
    if(!previous.has(name) && [...previous.values()].includes(id)) errors.push(`Reused error code ${id} for ${name}`);
  }
  return errors;
}
if(require.main===module) {
  const [a,b]=process.argv.slice(2);
  if(!a || !b) {console.error('Usage: node check-contract-error-codes.cjs BASE HEAD');process.exitCode=2;}
  else {
    try {
      const errors=diffErrors(fs.readFileSync(a,'utf8'),fs.readFileSync(b,'utf8'));
      const report=errors.length?errors.map(x=>`- ❌ ${x}`).join('\n'):'- ✅ Contract error numeric assignments compatible';
      console.log(report);
      if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'\n## Shared contract error codes\n'+report+'\n');
      if(errors.length && process.env.CONTRACT_BREAKING_CHANGE_ACKNOWLEDGED!=='true') process.exitCode=1;
    }catch(e){console.error(e);process.exitCode=1;}
  }
}
module.exports={errorMap,diffErrors};
