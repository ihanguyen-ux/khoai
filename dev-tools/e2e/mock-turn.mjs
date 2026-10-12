import http from 'node:http';
let hits = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits += 1;
    console.log('MOCK-TURN', req.method, req.url, req.headers.authorization, body);
    if (req.url === '/hits') { res.end(String(hits)); return; }
    if (req.headers.authorization !== 'Bearer fake-token') { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c' },
    ] }));
  });
}).listen(9911, '127.0.0.1');
