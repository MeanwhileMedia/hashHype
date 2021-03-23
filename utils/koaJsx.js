import path from 'path';
import fs from 'fs';
import * as babel from "@babel/core";
import React from 'react';
//import ReactDOMServer from 'react-dom/server';

// For parsing JSX -> JS in real time upon a view request through koa.
// Based on: https://github.com/yiminghe/koa-jsx

var koaJsx = {

  jsxDir: null, // the path which holds our jsx files ("filename.jsx.js")
  cachedCompiledJsx: {}, //Abs paths as keys holding compiled text for quick cache

  init(dir, opts) {
    koaJsx.jsxDir = dir;

    // Return the generator as koa middleware
    return function (ctx, next) {
      if (koaJsx.isJsx(ctx)) {
        const viewCode = koaJsx.compileResponse(ctx.response, opts);
        if (typeof viewCode === 'undefined') {
          console.log(`File not found at incoming jsx view request url. ${ctx.request.url}`);
          return next();
        }
      } else {
        return next();
      }
    };
  },

  isJsx(ctx) {
    // Is the request for a file with jsx extension?
    return ctx.request.url.match(/\.(jsx)/);
  },

  compileResponse(ctx, opts) {
    const filePath = path.join(koaJsx.jsxDir, ctx.request.url);
    if (!fs.existsSync(filePath)) { return undefined; }

    let compiled;
    if(koaJsx.cachedCompiledJsx[filePath]) {
      console.log(`Requested JSX file was found in cache: ${filePath}`);
      compiled = koaJsx.cachedCompiledJsx[filePath];
    } else {
      compiled = babel.transformFileSync(filePath, {
        presets: ['@babel/react'],
      });
      koaJsx.cachedCompiledJsx[filePath] = compiled;
      console.log(`Requested JSX file was compiled: ${filePath}`);
    }

    const maxAge = opts.maxAge || 0;
    ctx.set({
      'Content-Type': 'application/javascript;charset=utf-8',
      'Content-Length': Buffer.byteLength(compiled.code),
      'Cache-Control': `max-age=${maxAge / 1000 | 0}`,
    });
    ctx.body = compiled.code;
    return compiled.code;
  },

}; // end koaJsx

export default koaJsx.init;
