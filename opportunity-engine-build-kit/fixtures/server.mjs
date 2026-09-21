/** Loopback-only synthetic fixture server. No outbound requests, auth or payments. */
import http from 'node:http';import {readFile} from 'node:fs/promises';
const pages={ '/product':['product.html',200], '/size-guide':['missing-guide.html',404], '/fit-guide':['healthy-guide.html',200], '/challenge':['challenge.html',403] };
http.createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});return res.end('Read-only fixture');}
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  let item=Object.hasOwn(pages,path)?pages[path]:undefined;if(path==='/healthy-product')item=['product.html',200];
  if(!item){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Unknown fixture route');}
  let html=await readFile(new URL(item[0],import.meta.url),'utf8');
  if(path==='/healthy-product')html=html.replace('href="/size-guide"','href="/fit-guide"').replace('The information link deliberately returns HTTP 404.','This information link returns HTTP 200.');
  res.writeHead(item[1],{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?'':html);
 }catch{res.writeHead(500,{'Content-Type':'text/plain'});res.end('Fixture read failed');}
}).listen(4179,'127.0.0.1',()=>console.log('Synthetic fixtures only: http://127.0.0.1:4179/product'));
