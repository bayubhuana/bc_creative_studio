import { handleRequest } from '../server.js';

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (err) {
    console.error('[Vercel Handler Error]:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'internal_server_error', message: err.message || 'Internal Server Error' }));
    }
  }
}
