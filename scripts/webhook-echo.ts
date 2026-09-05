/* eslint-disable no-console */
/**
 * A tiny receiver for debugging the `webhook` setting: prints every request it gets (method,
 * url, headers and the parsed JSON body). Point `webhook` at http://<this host>:5007/ to use it.
 */
import { createServer } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '5007', 10);

const server = createServer((request, response) => {
  console.log(request.method, request.url);
  for (const [header, value] of Object.entries(request.headers)) {
    console.log(`${header}: ${String(value)}`);
  }

  console.log('');
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    response.end();
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      console.dir(JSON.parse(text), { depth: 10 });
    } catch {
      if (text.length > 0) {
        console.log(text);
      }
    }

    console.log('');
  });
});

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}/`);
});
