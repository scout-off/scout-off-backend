#!/usr/bin/env node
'use strict';
// Run after build, or within a Docker image from /app.
const express=require('express');
const path=require('node:path');
const fs=require('node:fs');
const http=require('node:http');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
for(const file of ['openapi.json','openapi.yaml','openapi.components.yaml']) {
  assert.ok(fs.existsSync(path.join(root,'dist',file)),`Missing dist/${file}`);
}
process.env.API_DOCS_MODE='public';
process.env.API_DOCS_HIDE_ADMIN='false';
const docs=require(path.join(root,'dist/routes/docs.js')).default;
const app=express(); app.use('/api/docs',docs);
const server=app.listen(0,'127.0.0.1',async()=>{
  try {
    const port=server.address().port;
    for(const suffix of ['','/yaml','/ui']) {
      const response=await fetch(`http://127.0.0.1:${port}/api/docs${suffix}`);
      assert.equal(response.status,200,`docs ${suffix}: ${await response.text()}`);
    }
    console.log('Built OpenAPI routes: HTTP 200');
  } catch (error) {console.error(error);process.exitCode=1;}
  finally {server.close();}
});
