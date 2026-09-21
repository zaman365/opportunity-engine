/** Serves only self-contained handoff viewers, not arbitrary repository files or .env. */
import http from 'node:http';import {readFile} from 'node:fs/promises';
const routes={'/':'../design/preview.html','/design':'../design/preview.html','/handbook':'../HANDBOOK.html'};
http.createServer(async(req,res)=>{
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
 let pathname;try{pathname=new URL(req.url,'http://127.0.0.1').pathname;}catch{res.writeHead(400);return res.end('Invalid path');}
 const target=Object.hasOwn(routes,pathname)?routes[pathname]:undefined;
 if(!target){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Handoff page not found');}
 try{const html=await readFile(new URL(target,import.meta.url));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(req.method==='HEAD'?'':html);}
 catch{res.writeHead(503,{'Content-Type':'text/plain'});res.end('Handoff artifact unavailable');}
}).listen(4178,'127.0.0.1',()=>console.log('Handoff preview: http://127.0.0.1:4178 · handbook: /handbook · No live platform'));
